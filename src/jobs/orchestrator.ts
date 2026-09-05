/**
 * The single orchestrator. One timer, all jobs.
 *
 * Hardened for real operation:
 *  - CLAIMING: each job is claimed with an etag-conditioned write before it
 *    runs, so scaled-out App Service instances (or an overlapping tick) never
 *    double-execute a job.
 *  - RETRIES: a failed run reschedules itself +5 minutes, up to 3 attempts,
 *    then alerts the job owner and the admin and (for recurring jobs)
 *    advances to the next cron slot.
 *  - Every run is logged to the activity stream.
 */
import { CloudAdapter } from "botbuilder";
import { deliver } from "../channels/deliver";
import { CosmosClient } from "@azure/cosmos";
import { dueJobs, markRun, computeNextRun, Job } from "../services/scheduler";
import { runAgent } from "../services/agent";
import { logActivity } from "../services/activityLog";
import { alertUser, alertAdmin } from "../services/alerts";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const jobsContainer = cosmos.database(process.env.COSMOS_DB ?? "taskbrain").container("jobs");

const POLL_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5 * 60_000;
let running = false;

export function startOrchestrator(adapter: CloudAdapter, botAppId: string): void {
  setInterval(() => tick(adapter, botAppId), POLL_MS);
  console.log("[orchestrator] polling every 60s");
}

export async function tick(adapter: CloudAdapter, botAppId: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const job of await dueJobs()) {
      const claimed = await claim(job);
      if (!claimed) continue; // another instance got it
      await runJob(adapter, botAppId, claimed);
    }
  } catch (err) {
    console.error("[orchestrator] tick failed:", err);
  } finally {
    running = false;
  }
}

/** Etag-conditioned claim: push nextRun forward so no one else picks it up. */
async function claim(job: Job & { _etag?: string }): Promise<Job | null> {
  try {
    const claimedJob = {
      ...job,
      nextRun: new Date(Date.now() + 10 * 60_000).toISOString(), // provisional hold
      claimedAt: new Date().toISOString(),
    };
    await jobsContainer.item(job.id, job.userId).replace(claimedJob, {
      accessCondition: { type: "IfMatch", condition: job._etag ?? "" },
    });
    return claimedJob;
  } catch {
    return null; // etag mismatch — someone else claimed it
  }
}

async function runJob(_adapter: CloudAdapter, _botAppId: string, job: Job): Promise<void> {
  console.log(`[orchestrator] running ${job.id} (${job.name})`);
  const retryCount = Number((job as unknown as Record<string, unknown>).retryCount ?? 0);
  try {
    const result = await runAgent(
      { userId: job.userId, conversationRef: job.conversationRef },
      `Scheduled job "${job.name}". Instruction:\n${job.prompt}\n\n` +
        `Execute it now using your tools and produce a concise result for the user.`,
      "digest"
    );

    // Deliver wherever the user last spoke (Teams or iMessage). If the job
    // was scheduled from a specific channel, prefer it.
    const prefer = (job.conversationRef as { channel?: string } | undefined)?.channel === "imessage"
      ? { channel: "imessage" as const, phone: (job.conversationRef as { phone: string }).phone }
      : undefined;
    await deliver(job.userId, `⏰ **${job.name}**\n\n${result}`, prefer);
    await markRun({ ...job, ...( { retryCount: 0 } as object) } as Job, "ok", result);
    void logActivity({ type: "job_run", userId: job.userId, detail: { job: job.name, status: "ok" } });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[orchestrator] job ${job.id} failed:`, err);
    void logActivity({
      type: "job_run",
      userId: job.userId,
      detail: { job: job.name, status: "error", attempt: retryCount + 1, message },
    });

    if (retryCount + 1 < MAX_RETRIES) {
      // reschedule the same run shortly
      await jobsContainer.items.upsert({
        ...job,
        retryCount: retryCount + 1,
        nextRun: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        lastStatus: "error",
        lastResultPreview: message.slice(0, 300),
      });
    } else {
      await alertUser(job.userId, `Job "${job.name}" failed ${MAX_RETRIES} times: ${message.slice(0, 200)}`);
      await alertAdmin(`Job ${job.id} ("${job.name}") exhausted retries: ${message.slice(0, 200)}`);
      // recurring: give up on this occurrence, move to next slot; one-off: disable
      await jobsContainer.items.upsert({
        ...job,
        retryCount: 0,
        enabled: !job.runOnce,
        nextRun: job.runOnce ? job.nextRun : computeNextRun(job.cron, undefined),
        lastRun: new Date().toISOString(),
        lastStatus: "error",
        lastResultPreview: message.slice(0, 300),
      });
    }
  }
}
