/**
 * Short-window conversational state. This is the entire defense against
 * context rot: the ONLY chat history that ever reaches the model is the last
 * few turns, and Cosmos TTL (900s, set on the container) erases even that.
 */
import { CosmosClient } from "@azure/cosmos";
import { createHash } from "node:crypto";
import type { IntentPlan } from "./intent";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const sessions = cosmos
  .database(process.env.COSMOS_DB ?? "taskbrain")
  .container("sessions");

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

interface SessionDoc {
  id: string;
  userId: string;
  conversationId?: string;
  turns: SessionTurn[];
  pendingClarification?: PendingClarification;
}

function sessionId(userId: string, conversationId?: string): string {
  if (!conversationId) return userId;
  return `session-${createHash("sha256").update(conversationId).digest("hex").slice(0, 32)}`;
}

async function readSession(userId: string, conversationId?: string): Promise<SessionDoc | undefined> {
  try {
    const { resource } = await sessions
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
  await sessions.items.upsert({
    ...current,
    id: sessionId(userId, conversationId),
    userId,
    conversationId,
    turns: turns.slice(-MAX_TURNS),
  });
}

export async function getPendingClarification(
  userId: string,
  conversationId?: string
): Promise<PendingClarification | undefined> {
  return (await readSession(userId, conversationId))?.pendingClarification;
}

export async function setPendingClarification(
  userId: string,
  conversationId: string | undefined,
  pendingClarification?: PendingClarification
): Promise<void> {
  const current = await readSession(userId, conversationId);
  await sessions.items.upsert({
    ...current,
    id: sessionId(userId, conversationId),
    userId,
    conversationId,
    turns: current?.turns ?? [],
    pendingClarification,
  });
}
