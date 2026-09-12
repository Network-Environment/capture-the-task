import type { Channel } from "../channels/types";

export type IntentKind = "respond" | "read" | "capture" | "act" | "clarify";
export type CaptureKind = "task" | "idea" | "reference";
export type MessageDisposition = "proceed" | "clarify" | "help" | "refuse";
export type IntentReason =
  | "understood"
  | "probe"
  | "insufficient_context"
  | "nonsense"
  | "repeated"
  | "unsafe_request"
  | "policy_bypass"
  | "credential_request"
  | "identity_bypass";
export type OperationEffect =
  | "read"
  | "personal_write"
  | "shared_write"
  | "destructive"
  | "scheduled"
  | "external_cost";

export interface ChannelPolicy {
  channel: Channel;
  scope: "private" | "group";
  identity: "canonical" | "mapped" | "weak";
  allowReads: boolean;
  allowPersonalWrites: boolean;
  allowSharedWrites: boolean;
  approvalUx: "adaptive_card" | "text";
}

export interface InterpretedIntent {
  kind: IntentKind;
  standalone: string;
  confidence: number;
  explicit: boolean;
  captureKind?: CaptureKind;
  title?: string;
  detail?: string;
  due?: string;
  tags?: string[];
  links?: string[];
  ambiguity?: string;
  missing?: string[];
  question?: string;
}

export interface IntentPlan {
  disposition: MessageDisposition;
  reason: IntentReason;
  response?: string;
  intents: InterpretedIntent[];
  confidence: number;
  assumptions: string[];
  clarification?: string;
  continuesPending?: boolean;
}

export interface OperationMetadata {
  name: string;
  effect: OperationEffect;
  reversible: boolean;
  description: string;
}

export type PolicyDecision =
  | { decision: "execute"; reason: string }
  | { decision: "clarify"; reason: string }
  | { decision: "approve"; reason: string }
  | { decision: "deny"; reason: string };

export interface AuthorizationContext {
  explicit: boolean;
  confidence: number;
  channel: ChannelPolicy;
}

const configuredThreshold = Number(process.env.INTENT_CONFIDENCE_THRESHOLD ?? 0.72);
export const INTENT_CONFIDENCE_THRESHOLD = Number.isFinite(configuredThreshold)
  ? Math.max(0.5, Math.min(1, configuredThreshold))
  : 0.72;

export function normalizeConfidence(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

export function evaluateOperation(
  operation: OperationMetadata,
  auth: AuthorizationContext
): PolicyDecision {
  if (operation.effect === "read") {
    return auth.channel.allowReads
      ? { decision: "execute", reason: "Read-only lookup is allowed." }
      : { decision: "deny", reason: "Read operations are not enabled on this channel." };
  }
  if (auth.confidence < INTENT_CONFIDENCE_THRESHOLD) {
    return { decision: "clarify", reason: "The requested operation is not understood confidently enough." };
  }
  if (!auth.explicit) {
    return { decision: "clarify", reason: "A mutation must be explicitly requested." };
  }
  if (operation.effect === "personal_write") {
    return auth.channel.allowPersonalWrites
      ? { decision: "execute", reason: "Explicit, reversible personal change." }
      : { decision: "deny", reason: "Personal changes are not enabled on this channel." };
  }
  if (!auth.channel.allowSharedWrites) {
    return { decision: "deny", reason: "Shared or high-impact changes are not enabled on this channel." };
  }
  return {
    decision: "approve",
    reason: `${operation.effect.replace("_", " ")} operations require a preview and approval.`,
  };
}

export function validateIntentPlan(raw: unknown): IntentPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const disposition = String(value.disposition) as MessageDisposition;
  const reason = String(value.reason) as IntentReason;
  if (!["proceed", "clarify", "help", "refuse"].includes(disposition)) {
    return undefined;
  }
  if (
    ![
      "understood",
      "probe",
      "insufficient_context",
      "nonsense",
      "repeated",
      "unsafe_request",
      "policy_bypass",
      "credential_request",
      "identity_bypass",
    ].includes(reason)
  ) {
    return undefined;
  }
  if (!Array.isArray(value.intents) || value.intents.length === 0 || value.intents.length > 8) {
    return undefined;
  }
  const intents: InterpretedIntent[] = [];
  for (const item of value.intents) {
    if (!item || typeof item !== "object") return undefined;
    const i = item as Record<string, unknown>;
    const kind = String(i.kind) as IntentKind;
    if (!["respond", "read", "capture", "act", "clarify"].includes(kind)) return undefined;
    const standalone = typeof i.standalone === "string" ? i.standalone.trim() : "";
    if (!standalone) return undefined;
    const captureKind = i.captureKind as CaptureKind | undefined;
    if (kind === "capture" && !["task", "idea", "reference"].includes(String(captureKind))) {
      return undefined;
    }
    const ambiguity =
      typeof i.ambiguity === "string" && !/^(none|n\/a|no)$/i.test(i.ambiguity.trim())
        ? i.ambiguity.trim()
        : undefined;
    const missing = Array.isArray(i.missing)
      ? i.missing.map(String).filter((v) => !/^(none|n\/a|no)$/i.test(v.trim()))
      : [];
    intents.push({
      kind,
      standalone,
      confidence: normalizeConfidence(i.confidence),
      explicit: i.explicit === true,
      captureKind,
      title: typeof i.title === "string" ? i.title.trim() : undefined,
      detail: typeof i.detail === "string" ? i.detail : undefined,
      due: typeof i.due === "string" ? i.due : undefined,
      tags: Array.isArray(i.tags) ? i.tags.map(String).slice(0, 4) : [],
      links: Array.isArray(i.links) ? i.links.map(String) : [],
      ambiguity,
      missing,
      question:
        typeof i.question === "string" && i.question.trim() ? i.question.trim() : undefined,
    });
  }
  const hasBlockingIntent = intents.some(
    (i) =>
      i.kind === "clarify" ||
      ((i.kind === "capture" || i.kind === "act") &&
        i.confidence < INTENT_CONFIDENCE_THRESHOLD) ||
      ((i.kind === "capture" || i.kind === "act") &&
        (Boolean(i.ambiguity) || Boolean(i.missing?.length))) ||
      ((i.kind === "capture" || i.kind === "act") && !i.explicit)
  );
  const response =
    typeof value.response === "string" && value.response.trim()
      ? value.response.trim()
      : undefined;
  if (
    (disposition === "help" || disposition === "refuse") &&
    (!response || intents.some((intent) => intent.kind !== "respond"))
  ) {
    return undefined;
  }
  if (
    disposition === "clarify" &&
    !intents.some((intent) => intent.kind === "clarify")
  ) {
    return undefined;
  }
  if (
    disposition === "proceed" &&
    (reason !== "understood" || intents.some((intent) => intent.kind === "clarify"))
  ) {
    return undefined;
  }
  return {
    disposition,
    reason,
    response,
    intents,
    confidence: normalizeConfidence(value.confidence),
    assumptions: Array.isArray(value.assumptions) ? value.assumptions.map(String) : [],
    continuesPending: value.continuesPending === true,
    clarification:
      hasBlockingIntent && typeof value.clarification === "string" && value.clarification.trim()
        ? value.clarification.trim()
        : undefined,
  };
}

export function planNeedsClarification(plan: IntentPlan): boolean {
  if (plan.disposition === "help" || plan.disposition === "refuse") return false;
  return (
    plan.disposition === "clarify" ||
    plan.confidence < INTENT_CONFIDENCE_THRESHOLD ||
    Boolean(plan.clarification) ||
    plan.intents.some(
      (i) =>
        i.kind === "clarify" ||
        ((i.kind === "capture" || i.kind === "act") &&
          i.confidence < INTENT_CONFIDENCE_THRESHOLD) ||
        ((i.kind === "capture" || i.kind === "act") &&
          (Boolean(i.ambiguity) || Boolean(i.missing?.length))) ||
        ((i.kind === "capture" || i.kind === "act") && !i.explicit)
    )
  );
}
