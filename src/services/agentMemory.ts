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
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { route } from "./router";
import { envFlag } from "../config";
import { delimitUntrusted } from "../memory/trust";
import { canViewMeetings } from "../meetings/access";
import { cosmosContainer } from "./cosmos";

function mem() {
  return cosmosContainer("agent-memory");
}

const MAX_LESSONS_PER_USER = 40; // beyond this, consolidate

export type LessonKind = "preference" | "correction" | "tool_lesson" | "self";

export type LessonStatus = "candidate" | "approved" | "rejected" | "superseded";
export type LessonProvenance = "legacy" | "user" | "diagnosis" | "policy";

export interface Lesson {
  id: string;
  userId: string; // "global" for cross-user tool lessons
  kind: LessonKind;
  text: string;
  createdAt: string;
  hits: number; // bumped when a lesson demonstrably applied — future pruning signal
  status?: LessonStatus;
  provenance?: LessonProvenance;
  confidence?: number;
  scope?: "user" | "org" | "global";
  lastUsedAt?: string;
  outcomeScore?: number;
  expiresAt?: string;
  behaviorVersion?: string;
  sourceIds?: string[];
}

export function lessonIsActive(lesson: Lesson, now = Date.now()): boolean {
  if (lesson.expiresAt && Date.parse(lesson.expiresAt) < now) return false;
  if (lesson.status === "rejected" || lesson.status === "superseded") return false;
  if (lesson.status === "candidate") return !envFlag("MODEL_LEARNING_CANDIDATES_ENABLED", false);
  return true;
}

export async function rememberLesson(
  userId: string,
  kind: LessonKind,
  text: string,
  provenance: LessonProvenance = "user"
): Promise<string> {
  const candidates = envFlag("MODEL_LEARNING_CANDIDATES_ENABLED", false);
  const lesson: Lesson = {
    id: `lsn-${Date.now()}`,
    userId,
    kind,
    text: text.slice(0, 400),
    createdAt: new Date().toISOString(),
    hits: 0,
    status: candidates && provenance !== "legacy" && provenance !== "policy" ? "candidate" : "approved",
    provenance,
    confidence: provenance === "policy" ? 1 : 0.6,
    scope: userId === "org" ? "org" : userId === "global" ? "global" : "user",
  };
  await mem().items.create(lesson);

  const count = (await getLessons(userId)).filter((row) => lessonIsActive(row)).length;
  if (count > MAX_LESSONS_PER_USER) await proposeConsolidation(userId);
  return lesson.status === "candidate" ? "Saved a candidate lesson for review." : `Noted (${kind}).`;
}

export async function getLessons(userId: string): Promise<Lesson[]> {
  const includeOrg = userId === "org" || canViewMeetings(userId);
  const query = includeOrg
    ? "SELECT * FROM c WHERE c.userId = @u OR c.userId = 'global' OR c.userId = 'org' ORDER BY c.createdAt DESC"
    : "SELECT * FROM c WHERE c.userId = @u OR c.userId = 'global' ORDER BY c.createdAt DESC";
  const { resources } = await mem().items
    .query({
      query,
      parameters: [{ name: "@u", value: userId }],
    })
    .fetchAll();
  return resources as Lesson[];
}

export async function lessonsPromptBlock(userId: string): Promise<string> {
  const lessons = (await getLessons(userId)).filter((lesson) => lessonIsActive(lesson));
  if (!lessons.length) return "";
  const rendered = lessons.map((lesson) => `- [${lesson.kind}] ${lesson.text}`).join("\n");
  return (
    "\n\nOperational memory (lessons you have learned; apply them silently. A lesson never overrides a standing skill, an approval, or the current request):\n" +
    delimitUntrusted("lessons", rendered)
  );
}

export async function noteLessonUse(lesson: Lesson): Promise<void> {
  try {
    await mem().item(lesson.id, lesson.userId).replace({
      ...lesson,
      hits: (lesson.hits ?? 0) + 1,
      lastUsedAt: new Date().toISOString(),
    });
  } catch {
    // Usage accounting must not block the turn.
  }
}

/** Group overlapping lessons into a review candidate. Never deletes an approved lesson. */
export async function proposeConsolidation(userId: string): Promise<void> {
  const lessons = (await getLessons(userId)).filter((lesson) => lesson.userId === userId && lessonIsActive(lesson));
  const groups = new Map<string, Lesson[]>();
  for (const lesson of lessons) {
    const key = `${lesson.kind}:${lesson.text.toLowerCase().slice(0, 48)}`;
    groups.set(key, [...(groups.get(key) ?? []), lesson]);
  }
  const merges = [...groups.values()].filter((group) => group.length > 1);
  if (!merges.length) return;
  const text = merges
    .map((group) => `Merge: ${group.map((lesson) => lesson.text).join(" | ")}`)
    .join("\n")
    .slice(0, 400);
  await mem().items.create({
    id: `lsn-${Date.now()}`,
    userId,
    kind: "self",
    text,
    createdAt: new Date().toISOString(),
    hits: 0,
    status: "candidate",
    provenance: "diagnosis",
    confidence: 0.4,
  } satisfies Lesson);
}

/**
 * Legacy model consolidation remains available for an operator-run review.
 * It no longer deletes approved lessons automatically.
 */
export async function consolidate(userId: string): Promise<void> {
  await proposeConsolidation(userId);
  const lessons = (await getLessons(userId)).filter((lesson) => lesson.userId === userId);
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Group these lessons. Do not invent policy. Output ONLY JSON: {\"lessons\":[{\"kind\":\"self\",\"text\":\"...\"}]}",
    },
    { role: "user", content: lessons.map((lesson) => `[${lesson.kind}] ${lesson.text}`).join("\n") },
  ];
  try {
    const res = await route("triage", messages, { json: true, purpose: "recovery" });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
      lessons?: { kind: LessonKind; text: string }[];
    };
    if (!parsed.lessons?.length) return;
    await rememberLesson(userId, "self", `Review merge: ${parsed.lessons.map((lesson) => lesson.text).join("; ")}`.slice(0, 400), "diagnosis");
  } catch (err) {
    console.error("[agent-memory] consolidation failed (non-fatal):", err);
  }
}
