import { CosmosClient } from "@azure/cosmos";
import { createHash } from "node:crypto";
import type { Channel } from "../channels/types";
import { logActivity } from "./activityLog";

const receipts = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
})
  .database(process.env.COSMOS_DB ?? "taskbrain")
  .container("inbound-receipts");

function receiptId(channel: Channel, eventId: string): string {
  return createHash("sha256").update(`${channel}:${eventId}`).digest("hex");
}

export async function claimInboundEvent(
  channel: Channel,
  eventId: string,
  userId: string
): Promise<boolean> {
  try {
    await receipts.items.create({
      id: receiptId(channel, eventId),
      channel,
      eventIdHash: createHash("sha256").update(eventId).digest("hex"),
      userId,
      status: "processing",
      receivedAt: new Date().toISOString(),
      ttl: 600,
    });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== 409) throw err;
    const id = receiptId(channel, eventId);
    try {
      const { resource } = await receipts.item(id, channel).read<{
        status?: string;
        receivedAt?: string;
        _etag?: string;
      }>();
      const stale =
        resource?.status === "failed" ||
        (resource?.status === "processing" &&
          Date.now() - Date.parse(resource.receivedAt ?? "") > 10 * 60_000);
      if (resource && stale) {
        await receipts.item(id, channel).replace(
          {
            ...resource,
            id,
            channel,
            userId,
            status: "processing",
            receivedAt: new Date().toISOString(),
            ttl: 600,
          },
          { accessCondition: { type: "IfMatch", condition: resource._etag ?? "" } }
        );
        return true;
      }
    } catch (readErr) {
      if ((readErr as { code?: number }).code !== 412) throw readErr;
    }
    void logActivity({
      type: "deduplication",
      userId,
      origin: "user_message",
      channel,
      trigger: "inbound_duplicate",
      detail: { duplicate: true },
    });
    return false;
  }
}

export async function finishInboundEvent(
  channel: Channel,
  eventId: string,
  status: "completed" | "failed"
): Promise<void> {
  const id = receiptId(channel, eventId);
  try {
    const { resource } = await receipts.item(id, channel).read<Record<string, unknown>>();
    if (!resource) return;
    await receipts.item(id, channel).replace({
      ...resource,
      status,
      finishedAt: new Date().toISOString(),
      ttl: status === "completed" ? 172800 : 300,
    });
  } catch (err) {
    console.error("[inbound-receipt] finish failed:", err);
  }
}
