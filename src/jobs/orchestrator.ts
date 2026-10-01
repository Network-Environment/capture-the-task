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
import { CloudAdapter, type ConversationReference } from "botbuilder";
import { deliver } from "../channels/deliver";
import { cosmosContainer } from "../services/cosmos";
import { dueJobs, markRun, computeNextRun, Job } from "../services/scheduler";
import { runAgent } from "../services/agent";
import { logActivity } from "../services/activityLog";
import { alertUser, alertAdmin } from "../services/alerts";
import { channelPolicy } from "../channels/types";
import { scheduledReadToolEnvelope } from "../tools/registry";
import { maybeConsolidateObservations } from "../memory/observe";
import { getGraphUserToken } from "../services/graphTasks";
import {
  applyStepError,
  applyStepResult,
  claimOutcome,
  dueOutcomes,
  saveOutcome,
  stepPrompt,
  withDeadline,
  type OutcomeJob,
  type OutcomeStep,
} from "../work/outcomes";

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
    await runOutcomes(adapter, botAppId);
    await maybeConsolidateObservations();
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
    await cosmosContainer("jobs").item(job.id, job.userId).replace(claimedJob, {
      accessCondition: { type: "IfMatch", condition: job._etag ?? "" },
    });
    return claimedJob;
  } catch {
    return null; // etag mismatch — someone else claimed it
  }
}

async function graphTokenFor(
  adapter: CloudAdapter,
  botAppId: string,
  ref: unknown
): Promise<(() => Promise<string>) | undefined> {
  if (!ref || typeof ref !== "object" || !("conversation" in ref)) return undefined;
  const channelId = (ref as { channelId?: string }).channelId;
  if (channelId && channelId !== "msteams") return undefined;
  try {
    let token = "";
    await adapter.continueConversationAsync(
      botAppId,
      ref as Partial<ConversationReference>,
      async (ctx) => {
        token = await getGraphUserToken(ctx);
      }
    );
    return token ? async () => token : undefined;
  } catch {
    return undefined;
  }
}

async function runOutcomes(adapter: CloudAdapter, botAppId: string): Promise<void> {
  let due: OutcomeJob[] = [];
  try {
    due = await dueOutcomes();
  } catch (err) {
    console.error("[orchestrator] outcome query failed:", err);
    return;
  }
  for (const job of due) {
    const claimed = await claimOutcome(job);
    if (!claimed) continue;
    const step = claimed.steps[claimed.cursor] as OutcomeStep | undefined;
    if (!step) {
      await saveOutcome({ ...claimed, status: "done", enabled: false });
      continue;
    }
    try {
      const getGraphToken = await graphTokenFor(adapter, botAppId, claimed.conversationRef);
      const result = await withDeadline(
        runAgent(
          {
            userId: claimed.userId,
            conversationRef: claimed.conversationRef,
            origin: "scheduled_job",
            channel: "internal",
            trigger: `outcome:${claimed.name}`,
            allowedTools: step.allowedTools,
            getGraphToken,
            authorization: {
              explicit: true,
              confidence: 1,
              channel: channelPolicy("teams", {
                scope: "private",
                identity: "canonical",
                allowActions: false,
              }),
            },
          },
          stepPrompt(claimed, step),
          step.profile
        )
      );
      const updated = applyStepResult(claimed, result);
      await saveOutcome(updated);
      const prefer = teamsPrefer(claimed.conversationRef);
      await deliver(
        claimed.userId,
        `Outcome **${claimed.name}** — step ${claimed.cursor + 1}: ${updated.status}\n\n${result.slice(0, 1200)}`,
        prefer
      );
      void logActivity({
        type: "job_run",
        userId: claimed.userId,
        origin: "scheduled_job",
        channel: "internal",
        trigger: `outcome:${claimed.name}`,
        detail: { job: claimed.name, status: updated.status, step: claimed.cursor },
      });
    } catch (err) {
      const message = (err as Error).message;
      const updated = applyStepError(claimed, message);
      await saveOutcome(updated);
      if (updated.status === "failed") {
        await alertUser(claimed.userId, `Outcome "${claimed.name}" stopped: ${message.slice(0, 200)}`);
      }
      void logActivity({
        type: "job_run",
        userId: claimed.userId,
        origin: "scheduled_job",
        channel: "internal",
        trigger: `outcome:${claimed.name}`,
        detail: { job: claimed.name, status: updated.status, message },
      });
    }
  }
}

function teamsPrefer(ref: unknown): { channel: "imessage"; phone: string } | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const row = ref as { channel?: string; phone?: string };
  if (row.channel === "imessage" && row.phone) return { channel: "imessage", phone: row.phone };
  return undefined;
}

async function runJob(_adapter: CloudAdapter, _botAppId: string, job: Job): Promise<void> {
  console.log(`[orchestrator] running ${job.id} (${job.name})`);
  if (!job.allowedTools) {
    job = { ...job, allowedTools: await scheduledReadToolEnvelope() };
  }
  const retryCount = Number((job as unknown as Record<string, unknown>).retryCount ?? 0);
  try {
    const result = await runAgent(
      {
        userId: job.userId,
        conversationRef: job.conversationRef,
        origin: "scheduled_job",
        channel: "internal",
        trigger: `job:${job.name}`,
        allowedTools: job.allowedTools,
        preapprovedTools: job.actionTools,
        authorization: {
          explicit: true,
          confidence: 1,
          channel: channelPolicy("teams", {
            scope: "private",
            identity: "canonical",
            allowActions: false,
          }),
        },
      },
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
    void logActivity({
      type: "job_run",
      userId: job.userId,
      origin: "scheduled_job",
      channel: "internal",
      trigger: `job:${job.name}`,
      detail: { job: job.name, status: "ok" },
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[orchestrator] job ${job.id} failed:`, err);
    void logActivity({
      type: "job_run",
      userId: job.userId,
      origin: "scheduled_job",
      channel: "internal",
      trigger: `job:${job.name}`,
      detail: { job: job.name, status: "error", attempt: retryCount + 1, message },
    });

    if (retryCount + 1 < MAX_RETRIES) {
      // reschedule the same run shortly
      await cosmosContainer("jobs").items.upsert({
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
      await cosmosContainer("jobs").items.upsert({
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

