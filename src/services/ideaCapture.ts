/**
 * Private-channel idea capture. A stated goal is filed before the reply,
 * and later turns in that conversation add to the same note. Clarifying
 * questions stop after the first one.
 */

export interface OpenIdea {
  id: string;
  path: string;
  title: string;
  updatedAt: string;
}

const IDEA_PREFIX = /^idea\s*:/i;
const WHAT_IF = /^what if\b/i;
const LOOKUP = /^(?:what|show|list|find|search|when|who|how)\b/i;
const SEED =
  /\b(?:we|i)(?:\s+|')(?:would|want|need|are looking|like to)\b|\b(?:looking|want|need) to\b/i;
const IDEA_VERB =
  /\b(?:expand|grow|growing|build|building|start|starting|establish|launch|business|market|demand|office)\b/i;
const OTHER_WORK =
  /\b(?:calendar|smartsheet|remind me|what can you do|undo that|approve pa-|schedule a meeting)\b/i;
const RESEARCH =
  /\b(?:you tell me|what are(?: all)? the (?:relevant|key|main)|market|in most demand|business plan|considerations|where should we|research)\b/i;

/** A self-contained goal, plan, or idea the second brain should keep. */
export function isIdeaSeed(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (IDEA_PREFIX.test(trimmed)) return trimmed.replace(IDEA_PREFIX, "").trim().length > 0;
  if (WHAT_IF.test(trimmed)) return trimmed.length >= 40;
  if (trimmed.length < 40 || LOOKUP.test(trimmed) || OTHER_WORK.test(trimmed)) return false;
  return SEED.test(trimmed) && IDEA_VERB.test(trimmed);
}

export function ideaTitleFrom(text: string): string {
  const sentence = text.trim().split(/(?<=[.!?])\s/)[0] ?? text.trim();
  const clean = sentence.replace(/\s+/g, " ").trim();
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 77).trimEnd()}…`;
}

/** Keep the first question. A second question mark is another turn, not this one. */
export function oneQuestion(text: string): string {
  const trimmed = text.trim();
  const first = trimmed.match(/^[\s\S]*?\?/);
  if (!first) return trimmed;
  return trimmed.slice(first[0].length).trim() ? first[0].trim() : trimmed;
}

export function wantsResearch(text: string): boolean {
  return RESEARCH.test(text);
}

/**
 * Add to the open idea when this turn is still about it: an answer to the
 * question already asked, or more of the same plan. A new explicit idea,
 * or a request aimed at another system, starts its own work.
 */
export function shouldAppendToOpenIdea(
  text: string,
  open: OpenIdea | undefined,
  answeringQuestion: boolean
): boolean {
  if (!open) return false;
  const trimmed = text.trim();
  if (trimmed.length < 12 || IDEA_PREFIX.test(trimmed)) return false;
  if (OTHER_WORK.test(trimmed) && !isIdeaSeed(trimmed)) return false;
  if (answeringQuestion) return true;
  return isIdeaSeed(trimmed) || wantsResearch(trimmed);
}

export function continueWithoutAnotherQuestion(
  original: string,
  question: string | undefined,
  answer: string
): { kind: "read" | "respond"; standalone: string } {
  const combined = `${original}\n${answer}`;
  const standalone = [
    original.trim(),
    question?.trim() ? `You already asked: ${question.trim()}` : "",
    `The user replied: ${answer.trim()}`,
    "Do not ask another question. State the assumptions you are making and answer or start the work.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { kind: wantsResearch(combined) ? "read" : "respond", standalone };
}
