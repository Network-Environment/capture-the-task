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

export function fitRunMessages<T extends PromptMessage>(messages: T[], budget: number): T[] {
  if (estimatePromptChars(messages) <= budget) return messages;
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
    const text = textOf(target.message);
    next[target.index] = {
      ...target.message,
      content: `${text.slice(0, 160)}\n[earlier tool evidence shortened]`,
    };
  }
  return next;
}
