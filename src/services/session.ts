/**
 * Short-window conversational state. This is the entire defense against
 * context rot: the ONLY chat history that ever reaches the model is the last
 * few turns, and Cosmos TTL (900s, set on the container) erases even that.
 */
import { createHash } from "node:crypto";
import type { IntentPlan } from "./intent";
import { cosmosContainer } from "./cosmos";

function sessions() {
  return cosmosContainer("sessions");
}

const MAX_TURNS = 5;

export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  intent?: string;
  outcome?: string;
  references?: string[];
}

export interface PendingClarification {
  plan: IntentPlan;
  originalText: string;
  question: string;
  createdAt: string;
}

export interface LastCapture {
  id: string;
  path: string;
  title: string;
  createdAt: string;
}

interface SessionDoc {
  id: string;
  userId: string;
  conversationId?: string;
  turns: SessionTurn[];
  pendingClarification?: PendingClarification;
  lastCapture?: LastCapture;
}

function sessionId(userId: string, conversationId?: string): string {
  if (!conversationId) return userId;
  return `session-${createHash("sha256").update(conversationId).digest("hex").slice(0, 32)}`;
}

async function readSession(userId: string, conversationId?: string): Promise<SessionDoc | undefined> {
  try {
    const { resource } = await sessions()
      .item(sessionId(userId, conversationId), userId)
      .read<SessionDoc>();
    return resource;
  } catch {
    return undefined;
  }
}

export async function getRecentTurns(userId: string, conversationId?: string): Promise<SessionTurn[]> {
  return (await readSession(userId, conversationId))?.turns ?? [];
}

export async function appendTurn(
  userId: string,
  role: "user" | "assistant",
  text: string,
  conversationId?: string,
  detail: Pick<SessionTurn, "intent" | "outcome" | "references"> = {}
): Promise<void> {
  const current = await readSession(userId, conversationId);
  const turns = current?.turns ?? [];
  turns.push({ role, text: text.slice(0, 1200), at: new Date().toISOString(), ...detail });
  await sessions().items.upsert({
    ...current,
    id: sessionId(userId, conversationId),
    userId,
    conversationId,
    turns: turns.slice(-MAX_TURNS),
  });
}

export function isUndoCommand(text: string): boolean {
  return /^(undo|undo that|delete that)[\s.!]*$/i.test(text.trim());
}

export async function getLastCapture(
  userId: string,
  conversationId?: string
): Promise<LastCapture | undefined> {
  return (await readSession(userId, conversationId))?.lastCapture;
}

export async function setLastCapture(
  userId: string,
  conversationId: string | undefined,
  lastCapture?: LastCapture
): Promise<void> {
  const current = await readSession(userId, conversationId);
  await sessions().items.upsert({
    ...current,
    id: sessionId(userId, conversationId),
    userId,
    conversationId,
    turns: current?.turns ?? [],
    lastCapture,
  });
}

export const OPEN_QUESTION_TTL_MS = 15 * 60_000;
const OPEN_QUESTION_SCOPE = "open-question";

export function openQuestionExpired(
  pending: PendingClarification,
  now = Date.now()
): boolean {
  return now - Date.parse(pending.createdAt) > OPEN_QUESTION_TTL_MS;
}

/** Newest unexpired question, preferring this chat and falling back to the person. */
export function pickOpenQuestion(
  local: PendingClarification | undefined,
  shared: PendingClarification | undefined,
  now = Date.now()
): PendingClarification | undefined {
  return [local, shared]
    .filter((item): item is PendingClarification => item !== undefined)
    .filter((item) => !openQuestionExpired(item, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export async function getPendingClarification(
  userId: string,
  conversationId?: string
): Promise<PendingClarification | undefined> {
  return (await readSession(userId, conversationId))?.pendingClarification;
}

export async function getOpenQuestion(
  userId: string,
  conversationId?: string
): Promise<PendingClarification | undefined> {
  const local = conversationId
    ? await getPendingClarification(userId, conversationId)
    : undefined;
  const shared = await getPendingClarification(userId, OPEN_QUESTION_SCOPE);
  return pickOpenQuestion(local, shared);
}

export async function setPendingClarification(
  userId: string,
  conversationId: string | undefined,
  pendingClarification?: PendingClarification
): Promise<void> {
  const current = await readSession(userId, conversationId);
  await sessions().items.upsert({
    ...current,
    id: sessionId(userId, conversationId),
    userId,
    conversationId,
    turns: current?.turns ?? [],
    pendingClarification,
  });
  if (conversationId !== OPEN_QUESTION_SCOPE) {
    const shared = await readSession(userId, OPEN_QUESTION_SCOPE);
    await sessions().items.upsert({
      ...shared,
      id: sessionId(userId, OPEN_QUESTION_SCOPE),
      userId,
      conversationId: OPEN_QUESTION_SCOPE,
      turns: shared?.turns ?? [],
      pendingClarification,
    });
  }
}
