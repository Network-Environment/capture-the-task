/**
 * Bounds one agent run's model prompt. The stored session is untouched:
 * callers pass a copy to the model and keep the original transcript.
 */
import { loadConfig } from "../config";

const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_TOKENS = 32_000;

export interface PromptMessage {
  role: string;
  content?: string | null | unknown;
  tool_calls?: unknown;
}

const routes = loadConfig<{
  routes: Record<string, { maxTokens?: number; contextTokens?: number }>;
}>("model.routes");

export function messageChars(message: PromptMessage): number {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
  const calls = message.tool_calls ? JSON.stringify(message.tool_calls) : "";
  return message.role.length + content.length + calls.length;
}

export function estimatePromptChars(messages: PromptMessage[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

export function promptCharBudget(maxCompletionTokens: number, contextTokens = DEFAULT_CONTEXT_TOKENS): number {
  const inputTokens = Math.max(2_000, contextTokens - Math.max(0, maxCompletionTokens));
  return inputTokens * CHARS_PER_TOKEN;
}

export function routePromptBudget(task: string): number {
  const route = routes.routes[task];
  return promptCharBudget(route?.maxTokens ?? 3_000, route?.contextTokens ?? DEFAULT_CONTEXT_TOKENS);
}

function textOf(message: PromptMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function protectedTool(text: string): boolean {
  return /approve\s+pa-[a-z0-9]+/i.test(text) || text.startsWith("CLARIFY:") || text.includes("Question recorded");
}

function latestToolStart(messages: PromptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant" && messages[index].tool_calls) return index;
  }
  return messages.length;
}

const ID_PATTERNS: Array<{ pattern: RegExp; group: number }> = [
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, group: 0 },
  { pattern: /"(?:id|[A-Za-z]+Id|[a-z]+_id)"\s*:\s*"?([^",}\s]{4,200})"?/g, group: 1 },
  { pattern: /\b\d{8,}\b/g, group: 0 },
];
const MAX_KEPT_IDS = 20;
const MAX_KEPT_ID_CHARS = 1_500;

/** Record IDs a later write may need, kept when the surrounding evidence is shortened. */
export function evidenceIds(text: string): string[] {
  const ids = new Set<string>();
  let chars = 0;
  for (const { pattern, group } of ID_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const id = match[group];
      if (!id || ids.has(id)) continue;
      if (ids.size >= MAX_KEPT_IDS || chars + id.length > MAX_KEPT_ID_CHARS) return [...ids];
      ids.add(id);
      chars += id.length + 2;
    }
  }
  return [...ids];
}

function shortenedEvidence(text: string): string {
  const ids = evidenceIds(text.slice(160));
  return `${text.slice(0, 160)}\n[earlier tool evidence shortened]${ids.length ? `\nids kept: ${ids.join(", ")}` : ""}`;
}

const OMITTED_TURNS = "[earlier conversation turns omitted to fit the context window]";

function lastUserIndex(messages: PromptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

/**
 * `protectedPrefix` is the count of leading messages (system prompt, record
 * references) that are never dropped. The current user message and the
 * in-run tool exchange are never dropped either; if they alone exceed the
 * budget the result stays over budget and the caller decides what to do.
 */
export function fitRunMessages<T extends PromptMessage>(
  messages: T[],
  budget: number,
  options: { protectedPrefix?: number } = {}
): T[] {
  if (estimatePromptChars(messages) <= budget) return messages;
  const next = shortenToolEvidence(messages, budget);
  return estimatePromptChars(next) <= budget
    ? next
    : dropOlderTurns(next, budget, options.protectedPrefix ?? 1);
}

function dropOlderTurns<T extends PromptMessage>(messages: T[], budget: number, protectedPrefix: number): T[] {
  const next = [...messages];
  const current = lastUserIndex(next);
  let start = Math.max(1, protectedPrefix);
  let dropped = 0;
  while (estimatePromptChars(next) > budget && start < current - dropped) {
    const message = next[start];
    if (message.role === "tool" || message.tool_calls || textOf(message) === OMITTED_TURNS) {
      start += 1;
      continue;
    }
    next.splice(start, 1);
    dropped += 1;
  }
  if (dropped) next.splice(Math.max(1, protectedPrefix), 0, { role: "user", content: OMITTED_TURNS } as T);
  return next;
}

function shortenToolEvidence<T extends PromptMessage>(messages: T[], budget: number): T[] {
  const next = messages.map((message) => ({ ...message }));
  const latest = latestToolStart(next);
  let guard = 0;
  while (estimatePromptChars(next) > budget && guard < 100) {
    guard += 1;
    const older = next
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) =>
        message.role === "tool" &&
        index < latest &&
        !protectedTool(textOf(message)) &&
        !textOf(message).includes("[earlier tool evidence shortened]")
      );
    const pool = older.length
      ? older
      : next
          .map((message, index) => ({ message, index }))
          .filter(({ message }) =>
            message.role === "tool" &&
            !protectedTool(textOf(message)) &&
            !textOf(message).includes("[earlier tool evidence shortened]")
          );
    const target = pool[0];
    if (!target) break;
    next[target.index] = {
      ...target.message,
      content: shortenedEvidence(textOf(target.message)),
    };
  }
  return next;
}
