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
  | "embedding"
  | "job_run"
  | "meeting_discovery"
  | "meeting_summary"
  | "error";

export type ActivityOrigin =
  | "user_message"
  | "meeting_discovery"
  | "admin_summary"
  | "scheduled_job"
  | "approval"
  | "system";

export type ActivityChannel = "teams" | "imessage" | "internal";
export type ActivityInputMode = "text" | "voice";

export interface ActivityAttribution {
  origin: ActivityOrigin;
  channel: ActivityChannel;
  inputMode?: ActivityInputMode;
  trigger?: string;
}

export interface ActivityEvent {
  type: ActivityType;
  userId?: string;
  agent?: string;
  origin?: ActivityOrigin;
  channel?: ActivityChannel;
  inputMode?: ActivityInputMode;
  trigger?: string;
  detail: Record<string, unknown>;
}

export function normalizeAttribution(
  e: Partial<ActivityEvent> & { detail?: Record<string, unknown> }
): ActivityAttribution {
  const d = e.detail ?? {};
  const legacyMeeting =
    e.agent === "meeting-ingest" ||
    e.agent === "meeting-discovery" ||
    d.transcriptId != null;
  const origin =
    e.origin ??
    (d.origin as ActivityOrigin | undefined) ??
    (e.type === "meeting_summary" ? "admin_summary" : undefined) ??
    (legacyMeeting ? "meeting_discovery" : undefined) ??
    (e.type === "job_run" ? "scheduled_job" : undefined) ??
    (d.approved != null ? "approval" : undefined) ??
    (e.type === "capture" ? "user_message" : undefined) ??
    "system";
  const rawChannel =
    e.channel ??
    (d.channel as ActivityChannel | undefined) ??
    (origin === "user_message" ? undefined : "internal");
  const channel: ActivityChannel =
    rawChannel === "teams" || rawChannel === "imessage" ? rawChannel : "internal";
  const rawMode = e.inputMode ?? d.inputMode ?? d.source;
  const inputMode =
    rawMode === "text" || rawMode === "voice" ? rawMode : undefined;
  const trigger = e.trigger ?? (d.trigger ? String(d.trigger) : undefined);
  return { origin, channel, inputMode, trigger };
}

export async function logActivity(e: ActivityEvent): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const attribution = normalizeAttribution(e);
    await activity.items.create({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      day, // partition key: efficient "today" queries, natural retention unit
      at: new Date().toISOString(),
      ...e,
      ...attribution,
      detail: {
        ...e.detail,
        origin: attribution.origin,
        channel: attribution.channel,
        ...(attribution.inputMode ? { inputMode: attribution.inputMode } : {}),
        ...(attribution.trigger ? { trigger: attribution.trigger } : {}),
      },
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
    const attribution = normalizeAttribution(e);
    if (e.type === "capture" && attribution.origin === "user_message") {
      stats.captures++;
    }
    if (e.type === "tool_call") stats.toolCalls++;
    if (e.type === "job_run") stats.jobRuns++;
    if (e.type === "error") stats.errors++;
    if (e.type === "model_call" || e.type === "embedding") {
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
  byOrigin: Record<string, number>;
  byInputMode: Record<string, number>;
  byTool: Record<string, number>;
  byUser: Record<string, number>;
  tokensByOrigin: Record<string, number>;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Today's activity sliced for the Usage section with normalized attribution. */
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
  const byOrigin: Record<string, number> = {};
  const byInputMode: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const byUser: Record<string, number> = {};
  const tokensByOrigin: Record<string, number> = {};

  for (const e of resources) {
    const d = (e.detail ?? {}) as Record<string, unknown>;
    const attribution = normalizeAttribution(e);
    bump(byChannel, attribution.channel);
    bump(byOrigin, attribution.origin);
    if (e.type === "capture" && attribution.origin === "user_message") {
      stats.captures++;
      if (attribution.inputMode) bump(byInputMode, attribution.inputMode);
    }
    if (e.type === "tool_call") {
      stats.toolCalls++;
      bump(byTool, String(d.tool ?? "unknown"));
    }
    if (e.type === "job_run") stats.jobRuns++;
    if (e.type === "error") stats.errors++;
    if (e.userId) bump(byUser, String(e.userId));
    if (e.type === "model_call" || e.type === "embedding") {
      const model = String(d.model ?? "unknown");
      const inTok = Number(d.inputTokens ?? 0);
      const outTok = Number(d.outputTokens ?? 0);
      stats.inputTokens += inTok;
      stats.outputTokens += outTok;
      stats.byModel[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
      stats.byModel[model].calls++;
      stats.byModel[model].inputTokens += inTok;
      stats.byModel[model].outputTokens += outTok;
      bump(tokensByOrigin, attribution.origin);
      tokensByOrigin[attribution.origin] += inTok + outTok - 1;
    }
  }

  return {
    stats,
    byChannel,
    byOrigin,
    byInputMode,
    byTool,
    byUser,
    tokensByOrigin,
  };
}
