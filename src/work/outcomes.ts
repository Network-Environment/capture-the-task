/**
 * Checkpointed outcomes. One step runs per claim, bounded by the same
 * deadline as a single request. Approval or a question freezes the job.
 */
import { loadConfig } from "../config";
import { cosmosContainer } from "../services/cosmos";

export const OUTCOME_STEP_DEADLINE_MS = Number(process.env.REQUEST_DEADLINE_MS ?? 240_000);
const MAX_STEPS = 8;
const MAX_ATTEMPTS = 3;

export interface OutcomeStep {
  profile: string;
  prompt: string;
  status: "pending" | "done" | "failed";
  result?: string;
  allowedTools?: string[];
}

export interface OutcomeJob {
  id: string;
  userId: string;
  name: string;
  status: "queued" | "running" | "waiting_approval" | "waiting_user" | "done" | "failed";
  steps: OutcomeStep[];
  cursor: number;
  conversationRef?: unknown;
  nextRun: string;
  enabled: boolean;
  progress?: string;
  attempts?: number;
  _etag?: string;
}

function outcomes() {
  return cosmosContainer("outcomes");
}

export function knownProfiles(): string[] {
  const config = loadConfig<{ profiles: Record<string, unknown> }>("agents");
  return Object.keys(config.profiles);
}

export function parseOutcomeSteps(
  prompt: string,
  raw: unknown,
  profiles: string[]
): OutcomeStep[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [{ profile: "capture", prompt, status: "pending" }];
  }
  if (raw.length > MAX_STEPS) return `An outcome can have at most ${MAX_STEPS} steps.`;
  const steps: OutcomeStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return "Each step needs a profile and a prompt.";
    const row = item as Record<string, unknown>;
    const profile = String(row.profile ?? "capture");
    const stepPrompt = String(row.prompt ?? "").trim();
    if (!profiles.includes(profile)) return `Unknown profile "${profile}".`;
    if (!stepPrompt) return "Each step needs a prompt.";
    const allowedTools = Array.isArray(row.allowedTools)
      ? row.allowedTools.map(String).filter(Boolean)
      : undefined;
    steps.push({ profile, prompt: stepPrompt, status: "pending", allowedTools });
  }
  return steps;
}

export function classifyStepResult(result: string): "approval" | "question" | "limit" | "done" {
  if (/approve\s+pa-[a-z0-9]+/i.test(result)) return "approval";
  if (result.includes("Question recorded") || result.startsWith("CLARIFY:")) return "question";
  if (result.includes("tool-call limit") || /exceeded its \d+ms deadline/.test(result)) return "limit";
  return "done";
}

export function applyStepResult(job: OutcomeJob, result: string, now = new Date()): OutcomeJob {
  const kind = classifyStepResult(result);
  const preview = result.slice(0, 500);
  const steps = job.steps.map((step, index) =>
    index === job.cursor
      ? { ...step, result: result.slice(0, 2000), status: kind === "done" ? "done" as const : step.status }
      : step
  );
  if (kind === "approval") {
    return { ...job, steps, status: "waiting_approval", enabled: false, progress: preview, attempts: 0 };
  }
  if (kind === "question") {
    return { ...job, steps, status: "waiting_user", enabled: false, progress: preview, attempts: 0 };
  }
  if (kind === "limit") {
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      return {
        ...job,
        steps: steps.map((step, index) =>
          index === job.cursor ? { ...step, status: "failed" } : step
        ),
        attempts,
        status: "failed",
        enabled: false,
        progress: preview,
      };
    }
    return {
      ...job,
      steps,
      attempts,
      status: "queued",
      enabled: true,
      nextRun: new Date(now.getTime() + 60_000).toISOString(),
      progress: preview,
    };
  }
  const next = job.cursor + 1;
  if (next >= steps.length) {
    return { ...job, steps, cursor: next, status: "done", enabled: false, progress: preview, attempts: 0 };
  }
  return {
    ...job,
    steps,
    cursor: next,
    status: "queued",
    enabled: true,
    nextRun: now.toISOString(),
    progress: preview,
    attempts: 0,
  };
}

export function applyStepError(job: OutcomeJob, message: string, now = new Date()): OutcomeJob {
  return applyStepResult(job, `step exceeded its ${OUTCOME_STEP_DEADLINE_MS}ms deadline: ${message}`, now);
}

export function stepPrompt(job: OutcomeJob, step: OutcomeStep): string {
  return (
    `Outcome "${job.name}", step ${job.cursor + 1} of ${job.steps.length} (${step.profile}).\n` +
    `${step.prompt}\n\nPrior progress:\n${job.progress ?? "none"}\n\n` +
    "Finish this step only. Shared changes still wait for approval."
  );
}

export async function startOutcome(
  userId: string,
  input: { name: string; prompt: string; steps: OutcomeStep[]; conversationRef?: unknown }
): Promise<OutcomeJob> {
  const now = new Date().toISOString();
  const job: OutcomeJob = {
    id: `out-${Date.now()}`,
    userId,
    name: input.name.trim() || "Outcome",
    status: "queued",
    steps: input.steps,
    cursor: 0,
    conversationRef: input.conversationRef,
    nextRun: now,
    enabled: true,
  };
  await outcomes().items.create(job);
  return job;
}

export async function listOutcomes(userId: string): Promise<OutcomeJob[]> {
  const { resources } = await outcomes()
    .items.query({
      query: "SELECT * FROM c WHERE c.userId = @u ORDER BY c.nextRun DESC",
      parameters: [{ name: "@u", value: userId }],
    })
    .fetchAll();
  return resources as OutcomeJob[];
}

export async function continueOutcome(userId: string, idOrName: string, note?: string): Promise<string> {
  const all = await listOutcomes(userId);
  const job = all.find((item) => item.id === idOrName || item.name === idOrName);
  if (!job) return `No outcome matching "${idOrName}".`;
  if (job.status !== "waiting_user" && job.status !== "waiting_approval") {
    return `"${job.name}" is ${job.status}, so there is nothing to continue.`;
  }
  const resumed: OutcomeJob = {
    ...job,
    status: "queued",
    enabled: true,
    attempts: 0,
    nextRun: new Date().toISOString(),
    progress: note?.trim() ? `${job.progress ?? ""}\nUser: ${note.trim()}`.slice(0, 500) : job.progress,
  };
  await outcomes().items.upsert(resumed);
  return `Continued "${job.name}". The next step will run shortly.`;
}

export async function dueOutcomes(now = new Date()): Promise<OutcomeJob[]> {
  const { resources } = await outcomes()
    .items.query({
      query:
        "SELECT * FROM c WHERE c.enabled = true AND c.nextRun <= @now AND (c.status = 'queued' OR c.status = 'running')",
      parameters: [{ name: "@now", value: now.toISOString() }],
    })
    .fetchAll();
  return resources as OutcomeJob[];
}

export async function claimOutcome(job: OutcomeJob): Promise<OutcomeJob | null> {
  try {
    const claimed: OutcomeJob = {
      ...job,
      status: "running",
      nextRun: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    await outcomes().item(job.id, job.userId).replace(claimed, {
      accessCondition: { type: "IfMatch", condition: job._etag ?? "" },
    });
    return claimed;
  } catch {
    return null;
  }
}

export async function saveOutcome(job: OutcomeJob): Promise<void> {
  const { _etag, ...rest } = job;
  void _etag;
  await outcomes().items.upsert(rest);
}

export function withDeadline<T>(work: Promise<T>, ms = OUTCOME_STEP_DEADLINE_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`step exceeded its ${ms}ms deadline`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
