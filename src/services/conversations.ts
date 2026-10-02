/**
 * Conversation reference store — channel-aware.
 * One document per (user, channel) plus a "latest" pointer, so proactive
 * delivery can target the channel the user last spoke on, or a specific one.
 */
import { ConversationReference } from "botbuilder";
import { Channel } from "../channels/types";
import { cosmosContainer } from "./cosmos";

function convs() {
  return cosmosContainer("conversations");
}

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
      convs().items.upsert({ id: `${userId}:${stored.channel}`, userId, ...stored, updatedAt: now }),
      convs().items.upsert({ id: `${userId}:latest`, userId, ...stored, updatedAt: now }),
    ]);
  } catch (err) {
    console.error("[conversations] save failed (non-fatal):", err);
  }
}

export interface ConversationChannel {
  userId: string;
  channel: Channel;
  updatedAt?: string;
  phone?: string;
}

/** Channel refs already stored, excluding the latest-pointer documents. */
export async function listConversationChannels(): Promise<ConversationChannel[]> {
  const { resources } = await convs().items
    .query<ConversationChannel & { id?: string }>({
      query: "SELECT c.userId, c.id, c.channel, c.updatedAt, c.phone FROM c",
    })
    .fetchAll();
  const rows: ConversationChannel[] = [];
  for (const row of resources) {
    if (!row.userId || row.id?.endsWith(":latest")) continue;
    const channel =
      row.channel === "imessage" || row.channel === "teams"
        ? row.channel
        : row.id?.endsWith(":imessage")
          ? "imessage"
          : row.id?.endsWith(":teams")
            ? "teams"
            : undefined;
    if (!channel) continue;
    rows.push({
      userId: row.userId,
      channel,
      updatedAt: row.updatedAt,
      phone: row.phone,
    });
  }
  return rows;
}

export async function getConversationRef(
  userId: string,
  channel?: Channel
): Promise<StoredRef | undefined> {
  try {
    const { resource } = await convs()
      .item(`${userId}:${channel ?? "latest"}`, userId)
      .read<StoredRef>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}
