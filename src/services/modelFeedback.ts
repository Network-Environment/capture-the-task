export type FeedbackKind =
  | "helpful"
  | "not_helpful"
  | "incorrect_fact"
  | "wrong_action"
  | "missing_capability"
  | "correction";

export interface FeedbackSignal {
  kind: FeedbackKind;
  requestId?: string;
  traceId?: string;
  behaviorVersion?: string;
  tool?: string;
  sourceIds?: string[];
  note?: string;
  implicit: boolean;
}

const CARD_ACTIONS = new Set<FeedbackKind>([
  "helpful",
  "not_helpful",
  "incorrect_fact",
  "wrong_action",
  "missing_capability",
]);

export function feedbackFromCard(action: string): FeedbackKind | undefined {
  return CARD_ACTIONS.has(action as FeedbackKind) ? (action as FeedbackKind) : undefined;
}

export function feedbackFromIMessage(text: string): FeedbackSignal | undefined {
  const match = text.trim().match(/^(helpful|not helpful|incorrect|wrong action|can't do that|correction)\b[:\s-]*(.*)$/i);
  if (!match) return undefined;
  const word = match[1].toLowerCase();
  const kind: FeedbackKind =
    word === "helpful"
      ? "helpful"
      : word === "not helpful"
        ? "not_helpful"
        : word === "incorrect"
          ? "incorrect_fact"
          : word === "wrong action"
            ? "wrong_action"
            : word === "can't do that"
              ? "missing_capability"
              : "correction";
  return { kind, note: match[2]?.slice(0, 300), implicit: false };
}

export type DiagnosisCause =
  | "intent"
  | "context"
  | "retrieval"
  | "tool_selection"
  | "tool_execution"
  | "policy"
  | "model_output"
  | "stale_memory"
  | "missing_capability"
  | "infrastructure";

export interface Diagnosis {
  cause: DiagnosisCause;
  artifact: "eval_case" | "prompt_patch" | "route_change" | "threshold_change" | "tool_description" | "lesson" | "skill" | "capability";
  evidence: string;
}

export function diagnose(input: {
  verifierRejected?: boolean;
  toolFailed?: boolean;
  policyDenied?: boolean;
  repeatedClarification?: boolean;
  quarantined?: boolean;
  missingCapability?: boolean;
  staleMemory?: boolean;
  badToolChoice?: boolean;
}): Diagnosis {
  if (input.quarantined) {
    return { cause: "infrastructure", artifact: "eval_case", evidence: "request was quarantined" };
  }
  if (input.missingCapability) {
    return { cause: "missing_capability", artifact: "capability", evidence: "user hit a capability boundary" };
  }
  if (input.policyDenied) {
    return { cause: "policy", artifact: "eval_case", evidence: "policy denied the action" };
  }
  if (input.staleMemory) {
    return { cause: "stale_memory", artifact: "lesson", evidence: "stored fact contradicted the latest source" };
  }
  if (input.toolFailed) {
    return { cause: "tool_execution", artifact: "tool_description", evidence: "tool execution failed" };
  }
  if (input.badToolChoice) {
    return { cause: "tool_selection", artifact: "prompt_patch", evidence: "selected tool did not match the request" };
  }
  if (input.verifierRejected) {
    return { cause: "model_output", artifact: "eval_case", evidence: "verifier rejected an unsupported claim" };
  }
  if (input.repeatedClarification) {
    return { cause: "intent", artifact: "threshold_change", evidence: "clarification did not converge" };
  }
  return { cause: "context", artifact: "eval_case", evidence: "no stronger signal; review the redacted trace" };
}

export function sanitizeEvalDraft(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 240);
}
