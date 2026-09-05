/**
 * Short-window conversational state. This is the entire defense against
 * context rot: the ONLY chat history that ever reaches the model is the last
 * few turns, and Cosmos TTL (900s, set on the container) erases even that.
 */
import { CosmosClient } from "@azure/cosmos";

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
}

export async function getRecentTurns(userId: string): Promise<SessionTurn[]> {
  try {
    const { resource } = await sessions.item(userId, userId).read<{
      turns: SessionTurn[];
    }>();
    return resource?.turns ?? [];
  } catch {
    return [];
  }
}

export async function appendTurn(
  userId: string,
  role: "user" | "assistant",
  text: string
): Promise<void> {
  const turns = await getRecentTurns(userId);
  turns.push({ role, text: text.slice(0, 500), at: new Date().toISOString() });
  await sessions.items.upsert({
    id: userId,
    userId,
    turns: turns.slice(-MAX_TURNS),
  });
}
