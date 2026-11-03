import type { SessionTurn } from "./session";
import type { IntentPlan } from "./intent";
import { envFlag, PRODUCTION_FLAG_DEFAULTS } from "../config";

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
const TRAILING_PUNCT = "[\\s.,!?]*";
const GREETING = new RegExp(`^(?:hi|hello|hey)(?:\\s+there)?${TRAILING_PUNCT}$`, "i");
const CAPABILITY_ASK =
  /^(?:help|what can you do|how does this work|what are you|i(?:['’]m| am) new(?: here)?)[\s.!?]*$/i;
const PROBE = new RegExp(
  `^(?:(?:this is|send|sending)\\s+(?:a\\s+)?)?(?:test|testing|ping)(?:\\s+(?:message|prompt|the bot|taskbrain))?${TRAILING_PUNCT}$`,
  "i"
);
const LOW_SIGNAL_WORDS = /^(?:asdf|qwerty|zxcv|blah|foobar|lorem|ipsum)$/i;
const SINGLE_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}'_-]*[.!?]?$/u;

export type SocialKind = "greeting" | "probe";

/** Exact greeting or probe. Anchored to the whole message so a real request cannot skip the queue. */
export function socialOnlyKind(text: string): SocialKind | undefined {
  const trimmed = text.trim();
  if (GREETING.test(trimmed)) return "greeting";
  if (PROBE.test(trimmed)) return "probe";
  const words = normalized(trimmed)
    .replace(/[.!?,]+$/g, "")
    .split(" ")
    .filter(Boolean);
  if (words.length > 1 && words.every((word) => /^(?:test|testing|ping)$/i.test(word))) {
    return "probe";
  }
  return undefined;
}

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

function isClarificationWait(turn: SessionTurn): boolean {
  return (
    turn.role === "assistant" &&
    (turn.outcome === "waiting_for_clarification" || turn.intent === "quality_clarify")
  );
}

/**
 * The same words are unresolved only when the latest copy is still waiting
 * on a real question. A later answer, a failed attempt, or a second copy
 * after the repeat warning is a new try, not a refusal to answer.
 */
function repeatsUnresolved(text: string, recent: SessionTurn[]): boolean {
  const target = normalized(text);
  let last = -1;
  for (let index = 0; index < recent.length; index++) {
    if (recent[index].role === "user" && normalized(recent[index].text) === target) last = index;
  }
  if (last < 0) return false;
  const replies = recent.slice(last + 1).filter((turn) => turn.role === "assistant");
  if (!replies.length) return false;
  const answered = replies.some(
    (turn) => !isClarificationWait(turn) && turn.outcome !== "failed"
  );
  if (answered) return false;
  const latest = replies[replies.length - 1];
  if (!isClarificationWait(latest) || latest.outcome === "failed") return false;
  const saidAgain = `${latest.body ?? ""}\n${latest.text}`;
  return !/i received that again/i.test(saidAgain);
}

export function assessInboundQuality(
  text: string,
  recent: SessionTurn[] = [],
  hasPendingClarification = false,
  hasSummary = false
): InboundQualityResult {
  const trimmed = text.trim();
  if (!envFlag("INBOUND_QUALITY_GATE_ENABLED", PRODUCTION_FLAG_DEFAULTS.INBOUND_QUALITY_GATE_ENABLED)) {
    return { disposition: "proceed", reason: "understood" };
  }

  const denied = refusal(trimmed);
  if (denied) return denied;

  const social = socialOnlyKind(trimmed);
  if (social === "greeting") {
    return {
      disposition: "help",
      reason: "probe",
      response:
        "I’m here. Ask me what I can do, or send a complete thought — a task, a question, or work you want followed through.",
    };
  }
  if (CAPABILITY_ASK.test(trimmed)) {
    return { disposition: "proceed", reason: "understood" };
  }
  if (social === "probe") {
    return {
      disposition: "help",
      reason: "probe",
      response:
        "Test received — TaskBrain is responding. Nothing was saved. Ask what I can do, or send a complete thought.",
    };
  }
  const words = normalized(trimmed)
    .replace(/[.!?]+$/g, "")
    .split(" ")
    .filter(Boolean);

  if (repeatsUnresolved(trimmed, recent)) {
    return {
      disposition: "clarify",
      reason: "repeated_unresolved",
      response:
        "I received that again, but I still can’t tell what outcome you want. Say what you want done, or ask me what I can do.",
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
    if (hasSummary || recent.some((turn) => turn.role === "assistant")) {
      return { disposition: "proceed", reason: "understood" };
    }
    return {
      disposition: "clarify",
      reason: "insufficient_context",
      response: `What would you like me to do with “${trimmed.replace(/[.!?]+$/g, "")}”?`,
    };
  }
  return { disposition: "proceed", reason: "understood" };
}

/**
 * A one-word reply can continue an open question or be small talk.
 * It cannot authorize a capture or a shared write on its own.
 */
export function restrainShortReply(
  text: string,
  plan: IntentPlan,
  hasPendingClarification: boolean
): IntentPlan {
  if (hasPendingClarification || !SINGLE_TOKEN.test(text.trim())) return plan;
  if (!plan.intents.some((intent) => intent.kind === "act" || intent.kind === "capture")) {
    return {
      ...plan,
      intents: plan.intents.map((intent) => ({ ...intent, explicit: false })),
    };
  }
  return {
    disposition: "proceed",
    reason: "understood",
    confidence: plan.confidence,
    assumptions: plan.assumptions,
    intents: [
      {
        kind: "respond",
        standalone: text.trim(),
        confidence: plan.confidence,
        explicit: false,
      },
    ],
  };
}
