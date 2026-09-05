/**
 * Conversation reference store — channel-aware.
 * One document per (user, channel) plus a "latest" pointer, so proactive
 * delivery can target the channel the user last spoke on, or a specific one.
 */
import { CosmosClient } from "@azure/cosmos";
import { ConversationReference } from "botbuilder";
import { Channel } from "../channels/types";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const convs = cosmos
  .database(process.env.COSMOS_DB ?? "taskbrain")
  .container("conversations");

export interface StoredRef {
  channel: Channel;
  teamsRef?: Partial<ConversationReference>;
  phone?: string;
  spaceId?: string;
}

type RefInput =
  | Partial<ConversationReference> // legacy Teams call shape
  | { channel: "imessage"; phone: string; spaceId?: string };

export async function saveConversationRef(userId: string, ref: RefInput): Promise<void> {
  const stored: StoredRef =
    "channel" in ref && ref.channel === "imessage"
      ? { channel: "imessage", phone: ref.phone, spaceId: ref.spaceId }
      : { channel: "teams", teamsRef: ref as Partial<ConversationReference> };
  const now = new Date().toISOString();
  try {
    await Promise.all([
      convs.items.upsert({ id: `${userId}:${stored.channel}`, userId, ...stored, updatedAt: now }),
      convs.items.upsert({ id: `${userId}:latest`, userId, ...stored, updatedAt: now }),
    ]);
  } catch (err) {
    console.error("[conversations] save failed (non-fatal):", err);
  }
}

export async function getConversationRef(
  userId: string,
  channel?: Channel
): Promise<StoredRef | undefined> {
  try {
    const { resource } = await convs
      .item(`${userId}:${channel ?? "latest"}`, userId)
      .read<StoredRef>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}
