/**
 * Agent self-memory — distinct from the user's second brain.
 *
 * The second brain stores the USER's knowledge. This container stores the
 * AGENT's operational knowledge about itself and how to work with this user:
 *   - preference:  "user wants risk summaries grouped by project, not date"
 *   - correction:  "'the register' means the Q3 Risk Register sheet, id 4821..."
 *   - tool_lesson: "smartsheet__search: quote multi-word terms or it OR-splits"
 *   - self:        "my triage misfiles voice memos with multiple asks; split them"
 *
 * Lessons come from two sources: the user's explicit feedback (the agent calls
 * remember_lesson when corrected) and post-run reflection on failures.
 * The store is deliberately small and bounded: lessons are injected into every
 * agent system prompt, so each one costs tokens forever. Cap + consolidation
 * keep it from becoming its own context-rot problem.
 */
import { CosmosClient } from "@azure/cosmos";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { route } from "./router";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const mem = cosmos
  .database(process.env.COSMOS_DB ?? "taskbrain")
  .container("agent-memory");

const MAX_LESSONS_PER_USER = 40; // beyond this, consolidate

export type LessonKind = "preference" | "correction" | "tool_lesson" | "self";

export interface Lesson {
  id: string;
  userId: string; // "global" for cross-user tool lessons
  kind: LessonKind;
  text: string;
  createdAt: string;
  hits: number; // bumped when a lesson demonstrably applied — future pruning signal
}

export async function rememberLesson(
  userId: string,
  kind: LessonKind,
  text: string
): Promise<string> {
  const lesson: Lesson = {
    id: `lsn-${Date.now()}`,
    userId,
    kind,
    text: text.slice(0, 400),
    createdAt: new Date().toISOString(),
    hits: 0,
  };
  await mem.items.create(lesson);

  const count = (await getLessons(userId)).length;
  if (count > MAX_LESSONS_PER_USER) await consolidate(userId);
  return `Noted (${kind}).`;
}

export async function getLessons(userId: string): Promise<Lesson[]> {
  const { resources } = await mem.items
    .query({
      query:
        "SELECT * FROM c WHERE c.userId = @u OR c.userId = 'global' ORDER BY c.createdAt DESC",
      parameters: [{ name: "@u", value: userId }],
    })
    .fetchAll();
  return resources as Lesson[];
}

/** Rendered block for injection into agent system prompts. */
export async function lessonsPromptBlock(userId: string): Promise<string> {
  const lessons = await getLessons(userId);
  if (!lessons.length) return "";
  return (
    "\n\nOperational memory (lessons you have learned; apply silently):\n" +
    lessons.map((l) => `- [${l.kind}] ${l.text}`).join("\n")
  );
}

/**
 * Consolidation: when the store exceeds the cap, merge overlapping lessons
 * into fewer, sharper ones. Uses the cheap tier — this is compression, not
 * reasoning. Runs rarely.
 */
async function consolidate(userId: string): Promise<void> {
  const lessons = (await getLessons(userId)).filter((l) => l.userId === userId);
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Consolidate these agent memory lessons. Merge duplicates/overlaps, drop " +
        "anything stale or one-off, keep at most 25. Preserve kind labels. " +
        'Output ONLY JSON: {"lessons":[{"kind":"...","text":"..."}]}',
    },
    { role: "user", content: lessons.map((l) => `[${l.kind}] ${l.text}`).join("\n") },
  ];
  try {
    const res = await route("triage", messages, { json: true });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
      lessons?: { kind: LessonKind; text: string }[];
    };
    if (!parsed.lessons?.length) return;

    for (const l of lessons) await mem.item(l.id, l.userId).delete();
    for (const l of parsed.lessons) {
      await mem.items.create({
        id: `lsn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userId,
        kind: l.kind,
        text: l.text.slice(0, 400),
        createdAt: new Date().toISOString(),
        hits: 0,
      } satisfies Lesson);
    }
  } catch (err) {
    console.error("[agent-memory] consolidation failed (non-fatal):", err);
  }
}
