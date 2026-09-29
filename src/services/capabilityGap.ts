/**
 * Capability gaps: outcomes a person asked for that TaskBrain cannot perform.
 * Policy refusals stay reason codes. This record keeps the ask so operators
 * can see what to build next, and the same turn answers with a fixed reply.
 */
import { logActivity, type ActivityChannel, type ActivityInputMode, type ActivityOrigin } from "./activityLog";

export const UNMET_TITLE = "Not something I can do";
export const FALLBACK_ALTERNATIVE = "tell me what you want tracked instead";

export const CALENDAR_UNAVAILABLE =
  "The requester's live Outlook calendar is unavailable on this channel.";
export const GRAPH_DISABLED = "Execution graph is disabled.";
export const GRAPH_WRITES_OFF =
  "Execution graph writes are disabled during read-only rollout.";

const ENVELOPE_GAP =
  /^NOT_ALLOWED: \S+ is outside this job's approved tool envelope\.$/;

export interface CapabilityGapActor {
  userId: string;
  channel?: ActivityChannel;
  origin?: ActivityOrigin;
  inputMode?: ActivityInputMode;
  trigger?: string;
  traceId?: string;
  requestText?: string;
  unmetReply?: string;
  unmetNoted?: boolean;
}

export interface CapabilityGapInput {
  capability: string;
  limit: string;
  alternative?: string;
}

export const GROUP_CHAT_GAP: CapabilityGapInput = {
  capability: "save or assign work in this group chat",
  limit: "I won’t save personal tasks or assign work in a group chat.",
  alternative: "ask me the same thing in a 1:1 chat",
};

const notedTraces = new Set<string>();
const gapListeners = new Set<(detail: Record<string, unknown>) => void>();

export function resetCapabilityGapNotes(): void {
  notedTraces.clear();
}

export function subscribeCapabilityGaps(
  listener: (detail: Record<string, unknown>) => void
): () => void {
  gapListeners.add(listener);
  return () => gapListeners.delete(listener);
}

export function composeUnmetReply(gap: CapabilityGapInput): string {
  const capability = gap.capability.trim().replace(/^to\s+/i, "").replace(/\.+$/g, "");
  const limitRaw = gap.limit.trim();
  const limit = /[.!?]$/.test(limitRaw) ? limitRaw : `${limitRaw}.`;
  const alternative =
    gap.alternative?.trim().replace(/\.+$/g, "") || FALLBACK_ALTERNATIVE;
  return `You want to ${capability}. ${limit} What I can do is ${alternative}.`;
}

export function classifyCapabilityBoundary(
  message: string
): CapabilityGapInput | undefined {
  if (message === CALENDAR_UNAVAILABLE) {
    return {
      capability: "check your Outlook calendar",
      limit: "Your Outlook calendar is connected in Teams, not in this chat.",
      alternative: "ask me again in Teams, or tell me the meeting in your own words",
    };
  }
  if (message === GRAPH_DISABLED) {
    return {
      capability: "use the shared execution graph",
      limit: GRAPH_DISABLED,
      alternative: "capture it as personal work or put it on a board",
    };
  }
  if (message === GRAPH_WRITES_OFF) {
    return {
      capability: "change the shared execution graph",
      limit: GRAPH_WRITES_OFF,
      alternative: "capture it as personal work or put it on a board",
    };
  }
  if (ENVELOPE_GAP.test(message)) {
    return {
      capability: "run that action in this conversation",
      limit: "That action is not available in this conversation.",
      alternative: FALLBACK_ALTERNATIVE,
    };
  }
  return undefined;
}

function rememberTrace(trace: string): void {
  notedTraces.add(trace);
  if (notedTraces.size <= 200) return;
  const oldest = notedTraces.values().next().value;
  if (oldest) notedTraces.delete(oldest);
}

export async function recordCapabilityGap(
  actor: CapabilityGapActor,
  gap: CapabilityGapInput
): Promise<string> {
  const capability = gap.capability.trim();
  const limit = gap.limit.trim();
  if (!capability || !limit) {
    return "Say what they wanted and the limit, as short phrases.";
  }
  const reply = composeUnmetReply({ capability, limit, alternative: gap.alternative });
  const trace = actor.traceId?.trim();
  const already =
    (trace && notedTraces.has(trace)) || (!trace && actor.unmetNoted === true);
  if (already) {
    actor.unmetReply = actor.unmetReply ?? reply;
    return actor.unmetReply;
  }
  actor.unmetReply = reply;
  actor.unmetNoted = true;
  if (trace) rememberTrace(trace);
  const alternative = gap.alternative?.trim() || FALLBACK_ALTERNATIVE;
  const detail: Record<string, unknown> = {
    capability: capability.slice(0, 200),
    limit: limit.slice(0, 500),
    alternative: alternative.slice(0, 300),
    request: String(actor.requestText ?? "").trim().slice(0, 500),
    channel: actor.channel ?? "internal",
  };
  for (const listener of gapListeners) listener(detail);
  await logActivity({
    type: "capability_gap",
    userId: actor.userId,
    origin: actor.origin,
    channel: actor.channel,
    inputMode: actor.inputMode,
    trigger: actor.trigger,
    traceId: actor.traceId,
    detail,
  });
  return reply;
}

export async function capabilityGapOutbound(
  actor: CapabilityGapActor,
  gap: CapabilityGapInput
): Promise<{ title: string; body: string; summaryLine: string }> {
  const body = await recordCapabilityGap(actor, gap);
  return {
    title: UNMET_TITLE,
    body,
    summaryLine: body.slice(0, 500),
  };
}
