/**
 * Jobs-as-data scheduler.
 * A "cron job" is a Cosmos document; the orchestrator (src/jobs/orchestrator.ts)
 * polls for due jobs. No dynamic Azure resource creation, fully auditable,
 * pausable, and listable from chat via the schedule_job / list_jobs tools.
 */
import { CosmosClient } from "@azure/cosmos";
import { CronExpressionParser } from "cron-parser";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const jobs = cosmos.database(process.env.COSMOS_DB ?? "taskbrain").container("jobs");

const TZ = process.env.JOBS_TIMEZONE ?? "America/Chicago";

export interface Job {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  cron?: string; // recurring
  runOnce?: string; // ISO, one-off
  nextRun: string; // ISO — the poller's query key
  enabled: boolean;
  conversationRef?: unknown; // where to deliver results proactively
  lastRun?: string;
  lastStatus?: "ok" | "error";
  lastResultPreview?: string;
}

export function computeNextRun(cron?: string, runOnce?: string, from = new Date()): string {
  if (runOnce) return new Date(runOnce).toISOString();
  if (!cron) throw new Error("job needs cron or runOnce");
  const it = CronExpressionParser.parse(cron, { currentDate: from, tz: TZ });
  return it.next().toISOString();
}

export async function scheduleJob(
  userId: string,
  j: Omit<Job, "id" | "userId" | "nextRun" | "enabled">
): Promise<Job> {
  const job: Job = {
    id: `job-${Date.now()}`,
    userId,
    enabled: true,
    nextRun: computeNextRun(j.cron, j.runOnce),
    ...j,
  };
  await jobs.items.create(job);
  return job;
}

export async function listJobs(userId: string): Promise<Job[]> {
  const { resources } = await jobs.items
    .query({
      query: "SELECT * FROM c WHERE c.userId = @u ORDER BY c.nextRun",
      parameters: [{ name: "@u", value: userId }],
    })
    .fetchAll();
  return resources as Job[];
}

export async function cancelJob(userId: string, idOrName: string): Promise<string> {
  const all = await listJobs(userId);
  const job = all.find((j) => j.id === idOrName || j.name === idOrName);
  if (!job) return `No job matching "${idOrName}".`;
  await jobs.item(job.id, userId).delete();
  return `Cancelled "${job.name}".`;
}

/** Poller queries: due, enabled jobs across all users. */
export async function dueJobs(now = new Date()): Promise<Job[]> {
  const { resources } = await jobs.items
    .query({
      query: "SELECT * FROM c WHERE c.enabled = true AND c.nextRun <= @now",
      parameters: [{ name: "@now", value: now.toISOString() }],
    })
    .fetchAll();
  return resources as Job[];
}

export async function markRun(
  job: Job,
  status: "ok" | "error",
  resultPreview: string
): Promise<void> {
  const updated: Job = {
    ...job,
    lastRun: new Date().toISOString(),
    lastStatus: status,
    lastResultPreview: resultPreview.slice(0, 300),
    // one-off jobs disable themselves; recurring jobs advance
    enabled: job.runOnce ? false : job.enabled,
    nextRun: job.runOnce ? job.nextRun : computeNextRun(job.cron, undefined),
  };
  await jobs.items.upsert(updated);
}
