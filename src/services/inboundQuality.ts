import type { SessionTurn } from "./session";

export type MessageDisposition = "proceed" | "clarify" | "help" | "refuse";

export type InboundQualityReason =
  | "understood"
  | "probe"
  | "insufficient_context"
  | "low_signal"
  | "repeated_unresolved"
  | "credential_request"
  | "identity_bypass"
  | "policy_bypass";

export interface InboundQualityResult {
  disposition: MessageDisposition;
  reason: InboundQualityReason;
  response?: string;
}

const EXPLICIT_CAPTURE =
  /^(?:task|idea|reference|remember|save|note|capture)\s*:/i;
const HELP =
  /^(?:hi|hello|hey|help|what can you do|how does this work)[\s.!?]*$/i;
const PROBE =
  /^(?:(?:this is|send|sending)\s+(?:a\s+)?)?(?:test|testing|ping)(?:\s+(?:message|prompt|the bot|taskbrain))?[\s.!?]*$/i;
const LOW_SIGNAL_WORDS = /^(?:asdf|qwerty|zxcv|blah|foobar|lorem|ipsum)$/i;
const SINGLE_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}'_-]*[.!?]?$/u;

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isExplicitCapture(text: string): boolean {
  return EXPLICIT_CAPTURE.test(text) && text.replace(EXPLICIT_CAPTURE, "").trim().length > 0;
}

function isQuotedOrSecurityDiscussion(text: string): boolean {
  return (
    /["“”'][^"“”']+["“”']/.test(text) ||
    /\b(?:hypothetical|example|incident|attack|attacker|phishing|security review|threat model)\b/i.test(
      text
    ) ||
    /^(?:what|why|how|could|would|should|explain|analyze|analyse|review)\b/i.test(text)
  );
}

function refusal(text: string): InboundQualityResult | undefined {
  if (isExplicitCapture(text) || isQuotedOrSecurityDiscussion(text)) return undefined;

  if (
    /\b(?:show|give|send|print|reveal|expose|dump|return)\b.{0,60}\b(?:passwords?|api[- ]?keys?|access[- ]?tokens?|refresh[- ]?tokens?|credentials?|environment variables?|secrets?)\b/i.test(
      text
    ) &&
    !/\b(?:usage|count|budget|documentation|rotation|expiry|expiration)\b/i.test(text)
  ) {
    return {
      disposition: "refuse",
      reason: "credential_request",
      response:
        "I can’t expose passwords, tokens, credentials, or secret values. I can help check whether an integration is configured, rotate a credential, or troubleshoot it without revealing the secret.",
    };
  }
  if (
    /\b(?:impersonate|pretend to be|act as|use (?:their|another user'?s) identity|spoof)\b.{0,50}\b(?:owner|admin|user|person|identity|account)\b/i.test(
      text
    )
  ) {
    return {
      disposition: "refuse",
      reason: "identity_bypass",
      response:
        "I can’t impersonate another person or use their identity. I can help the authorized user complete the request themselves or explain the required access.",
    };
  }
  if (
    /\b(?:bypass|disable|skip|evade|ignore|override)\b.{0,60}\b(?:approval|policy|guardrail|safeguard|authorization|permission|previous instructions?|system instructions?)\b/i.test(
      text
    )
  ) {
    return {
      disposition: "refuse",
      reason: "policy_bypass",
      response:
        "I can’t bypass approvals, authorization, or TaskBrain safeguards. I can explain the policy or help complete the request through the normal approved path.",
    };
  }
  return undefined;
}

function repeatsUnresolved(text: string, recent: SessionTurn[]): boolean {
  const target = normalized(text);
  return recent.some(
    (turn, index) =>
      turn.role === "user" &&
      normalized(turn.text) === target &&
      recent
        .slice(index + 1)
        .some(
          (later) =>
            later.role === "assistant" &&
            (later.outcome === "waiting_for_clarification" ||
              later.intent === "quality_clarify")
        )
  );
}

export function assessInboundQuality(
  text: string,
  recent: SessionTurn[] = [],
  hasPendingClarification = false
): InboundQualityResult {
  const trimmed = text.trim();
  if (process.env.INBOUND_QUALITY_GATE_ENABLED === "false") {
    return { disposition: "proceed", reason: "understood" };
  }

  const denied = refusal(trimmed);
  if (denied) return denied;

  if (HELP.test(trimmed)) {
    return {
      disposition: "help",
      reason: "probe",
      response:
        "I’m here. You can send a task (“buy milk”), an idea (“idea: offline sync”), ask what you previously captured, or ask me to work with an enabled system.",
    };
  }
  const words = normalized(trimmed)
    .replace(/[.!?]+$/g, "")
    .split(" ")
    .filter(Boolean);
  if (
    PROBE.test(trimmed) ||
    (words.length > 1 && words.every((word) => /^(?:test|testing|ping)$/i.test(word)))
  ) {
    return {
      disposition: "help",
      reason: "probe",
      response:
        "Test received — TaskBrain is responding. Nothing was saved. Try “task: call Pat tomorrow,” “idea: offline sync,” or “what did I capture about the budget?”",
    };
  }

  if (repeatsUnresolved(trimmed, recent)) {
    return {
      disposition: "clarify",
      reason: "repeated_unresolved",
      response:
        "I received that again, but I still can’t tell what outcome you want. Should I save it as a task, idea, or reference, or were you asking a question?",
    };
  }

  if (hasPendingClarification) {
    return { disposition: "proceed", reason: "understood" };
  }
  if (EXPLICIT_CAPTURE.test(trimmed) && !isExplicitCapture(trimmed)) {
    return {
      disposition: "clarify",
      reason: "insufficient_context",
      response:
        "What would you like me to save? Add the task, idea, or reference after the colon.",
    };
  }
  if (isExplicitCapture(trimmed)) {
    return { disposition: "proceed", reason: "understood" };
  }
  if (
    !/[\p{L}\p{N}]/u.test(trimmed) ||
    /^([\p{L}\p{N}.!?_-])\1{2,}$/u.test(trimmed) ||
    (words.length > 0 && words.every((word) => LOW_SIGNAL_WORDS.test(word)))
  ) {
    return {
      disposition: "clarify",
      reason: "low_signal",
      response:
        "I couldn’t tell what you want me to do with that. Please send a task, an idea to save, or a question.",
    };
  }
  if (SINGLE_TOKEN.test(trimmed)) {
    return {
      disposition: "clarify",
      reason: "insufficient_context",
      response: `What would you like me to do with “${trimmed.replace(/[.!?]+$/g, "")}” — save it as a task, idea, or reference, or look something up?`,
    };
  }
  return { disposition: "proceed", reason: "understood" };
}
