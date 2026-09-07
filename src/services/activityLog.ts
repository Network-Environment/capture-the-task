/**
 * Activity log — the observability spine.
 * Every meaningful event (capture, triage decision, tool call, model call with
 * token counts, job run) is one document in the `activity` container. The admin
 * dashboard reads this; nothing else in the system depends on it, so logging
 * failures never break the pipeline.
 */
import { CosmosClient } from "@azure/cosmos";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const activity = cosmos
  .database(process.env.COSMOS_DB ?? "taskbrain")
  .container("activity");

export type ActivityType =
  | "capture"
  | "triage"
  | "tool_call"
  | "model_call"
  | "job_run"
  | "error";

export interface ActivityEvent {
  type: ActivityType;
  userId?: string;
  agent?: string;
  detail: Record<string, unknown>;
}

export async function logActivity(e: ActivityEvent): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await activity.items.create({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      day, // partition key: efficient "today" queries, natural retention unit
      at: new Date().toISOString(),
      ...e,
    });
  } catch (err) {
    console.error("[activity] log failed (non-fatal):", err);
  }
}

export interface DayStats {
  captures: number;
  toolCalls: number;
  jobRuns: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

export async function recentEvents(limit = 100): Promise<Record<string, unknown>[]> {
  const { resources } = await activity.items
    .query({
      query: "SELECT TOP @n * FROM c ORDER BY c.at DESC",
      parameters: [{ name: "@n", value: limit }],
    })
    .fetchAll();
  return resources;
}

export async function dayStats(day = new Date().toISOString().slice(0, 10)): Promise<DayStats> {
  const { resources } = await activity.items
    .query({
      query: "SELECT * FROM c WHERE c.day = @day",
      parameters: [{ name: "@day", value: day }],
    })
    .fetchAll();

  const stats: DayStats = {
    captures: 0, toolCalls: 0, jobRuns: 0, errors: 0,
    inputTokens: 0, outputTokens: 0, byModel: {},
  };
  for (const e of resources) {
    if (e.type === "capture") stats.captures++;
    if (e.type === "tool_call") stats.toolCalls++;
    if (e.type === "job_run") stats.jobRuns++;
    if (e.type === "error") stats.errors++;
    if (e.type === "model_call") {
      const d = e.detail ?? {};
      const model = String(d.model ?? "unknown");
      const inTok = Number(d.inputTokens ?? 0);
      const outTok = Number(d.outputTokens ?? 0);
      stats.inputTokens += inTok;
      stats.outputTokens += outTok;
      stats.byModel[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
      stats.byModel[model].calls++;
      stats.byModel[model].inputTokens += inTok;
      stats.byModel[model].outputTokens += outTok;
    }
  }
  return stats;
}

export interface UsageBreakdown {
  stats: DayStats;
  byChannel: Record<string, number>;
  bySource: Record<string, number>;
  byTool: Record<string, number>;
  byUser: Record<string, number>;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Today's activity sliced for the Usage section (channel, source, tool, user). */
export async function usageBreakdown(
  day = new Date().toISOString().slice(0, 10)
): Promise<UsageBreakdown> {
  const { resources } = await activity.items
    .query({
      query: "SELECT * FROM c WHERE c.day = @day",
      parameters: [{ name: "@day", value: day }],
    })
    .fetchAll();

  const stats: DayStats = {
    captures: 0,
    toolCalls: 0,
    jobRuns: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    byModel: {},
  };
  const byChannel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const byUser: Record<string, number> = {};

  for (const e of resources) {
    const d = (e.detail ?? {}) as Record<string, unknown>;
    if (e.type === "capture") {
      stats.captures++;
      bump(byChannel, String(d.channel ?? "unknown"));
      bump(bySource, String(d.source ?? "unknown"));
    }
    if (e.type === "tool_call") {
      stats.toolCalls++;
      bump(byTool, String(d.tool ?? "unknown"));
    }
    if (e.type === "job_run") stats.jobRuns++;
    if (e.type === "error") stats.errors++;
    if (e.userId) bump(byUser, String(e.userId));
    if (e.type === "model_call") {
      const model = String(d.model ?? "unknown");
      const inTok = Number(d.inputTokens ?? 0);
      const outTok = Number(d.outputTokens ?? 0);
      stats.inputTokens += inTok;
      stats.outputTokens += outTok;
      stats.byModel[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
      stats.byModel[model].calls++;
      stats.byModel[model].inputTokens += inTok;
      stats.byModel[model].outputTokens += outTok;
    }
  }

  return { stats, byChannel, bySource, byTool, byUser };
}
