import { createHash } from "node:crypto";
import type { Channel } from "../channels/types";
import {
  PENDING_ACK_LEASE_MS,
  pendingAckEligible,
  pendingAckGaveUp,
  pendingAckRetryDelayMs,
} from "../channels/acknowledge";
import type { StoredRef } from "./conversations";
import { logActivity } from "./activityLog";
import { cosmosContainer } from "./cosmos";

function receipts() {
  return cosmosContainer("inbound-receipts");
}

function receiptId(channel: Channel, eventId: string): string {
  return createHash("sha256").update(`${channel}:${eventId}`).digest("hex");
}

export async function claimInboundEvent(
  channel: Channel,
  eventId: string,
  userId: string
): Promise<boolean> {
  try {
    await receipts().items.create({
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
      const { resource } = await receipts().item(id, channel).read<{
        status?: string;
        receivedAt?: string;
        _etag?: string;
      }>();
      const stale =
        resource?.status === "failed" ||
        (resource?.status === "processing" &&
          Date.now() - Date.parse(resource.receivedAt ?? "") > 10 * 60_000);
      if (resource && stale) {
        await receipts().item(id, channel).replace(
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
    const { resource } = await receipts().item(id, channel).read<Record<string, unknown>>();
    if (!resource) return;
    await receipts().item(id, channel).replace({
      ...resource,
      status,
      finishedAt: new Date().toISOString(),
      ttl: status === "completed" ? 172800 : 300,
    });
  } catch (err) {
    console.error("[inbound-receipt] finish failed:", err);
  }
}

/** Social reply saved before send, so a crash can still be delivered. */
export interface PendingAckReceipt {
  id: string;
  channel: Channel;
  eventIdHash: string;
  userId: string;
  status: "pending-ack" | "completed" | "failed";
  receivedAt: string;
  userText: string;
  replyText: string;
  firstName?: string;
  conversationId?: string;
  conversationRef?: StoredRef;
  sendLeaseUntil?: string;
  recoveryAttempts?: number;
  nextAttemptAt?: string;
  ttl: number;
  _etag?: string;
}

const PENDING_ACK_TTL_SEC = 2 * 60 * 60;

export async function createPendingAck(input: {
  channel: Channel;
  eventId: string;
  userId: string;
  userText: string;
  replyText: string;
  firstName?: string;
  conversationId?: string;
  conversationRef?: StoredRef;
}): Promise<{ outcome: "created"; receipt: PendingAckReceipt } | { outcome: "exists" }> {
  const receipt: PendingAckReceipt = {
    id: receiptId(input.channel, input.eventId),
    channel: input.channel,
    eventIdHash: createHash("sha256").update(input.eventId).digest("hex"),
    userId: input.userId,
    status: "pending-ack",
    receivedAt: new Date().toISOString(),
    userText: input.userText.slice(0, 500),
    replyText: input.replyText,
    firstName: input.firstName,
    conversationId: input.conversationId,
    conversationRef: input.conversationRef,
    recoveryAttempts: 0,
    ttl: PENDING_ACK_TTL_SEC,
  };
  try {
    const { resource } = await receipts().items.create(receipt);
    return { outcome: "created", receipt: (resource as PendingAckReceipt | undefined) ?? receipt };
  } catch (err) {
    if ((err as { code?: number }).code !== 409) throw err;
    return { outcome: "exists" };
  }
}

export async function leaseAckSend(
  receipt: PendingAckReceipt,
  now = Date.now()
): Promise<PendingAckReceipt | undefined> {
  const leased: PendingAckReceipt = {
    ...receipt,
    sendLeaseUntil: new Date(now + PENDING_ACK_LEASE_MS).toISOString(),
  };
  try {
    const { resource } = await receipts()
      .item(receipt.id, receipt.channel)
      .replace(leased, {
        accessCondition: { type: "IfMatch", condition: receipt._etag ?? "" },
      });
    return (resource as unknown as PendingAckReceipt | undefined) ?? leased;
  } catch (err) {
    if ((err as { code?: number }).code !== 412) throw err;
    return undefined;
  }
}

export async function completeAckReceipt(receipt: PendingAckReceipt): Promise<void> {
  await receipts().item(receipt.id, receipt.channel).replace(
    {
      ...receipt,
      status: "completed",
      sendLeaseUntil: undefined,
      nextAttemptAt: undefined,
      finishedAt: new Date().toISOString(),
      ttl: 172800,
    },
    receipt._etag
      ? { accessCondition: { type: "IfMatch", condition: receipt._etag } }
      : undefined
  );
}

export async function claimDuePendingAck(now = new Date()): Promise<PendingAckReceipt | undefined> {
  const nowMs = now.getTime();
  // Equality on status only. This container has no composite index, so the
  // age and lease checks are applied in memory. Pending rows are rare.
  const { resources } = await receipts()
    .items.query<PendingAckReceipt>({
      query: `SELECT * FROM c WHERE c.status = "pending-ack"`,
    })
    .fetchAll();
  const due = resources
    .filter((candidate) => pendingAckEligible(candidate, nowMs))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  for (const candidate of due) {
    const leased = await leaseAckSend(candidate, nowMs);
    if (leased) return leased;
  }
  return undefined;
}

export async function deferPendingAck(
  receipt: PendingAckReceipt,
  now = Date.now()
): Promise<"retry" | "stopped"> {
  const attempts = (receipt.recoveryAttempts ?? 0) + 1;
  if (pendingAckGaveUp(attempts)) {
    await receipts().item(receipt.id, receipt.channel).replace(
      {
        ...receipt,
        status: "failed",
        recoveryAttempts: attempts,
        sendLeaseUntil: undefined,
        ttl: 300,
      },
      receipt._etag
        ? { accessCondition: { type: "IfMatch", condition: receipt._etag } }
        : undefined
    );
    return "stopped";
  }
  await receipts().item(receipt.id, receipt.channel).replace(
    {
      ...receipt,
      status: "pending-ack",
      recoveryAttempts: attempts,
      sendLeaseUntil: undefined,
      nextAttemptAt: new Date(now + pendingAckRetryDelayMs(attempts)).toISOString(),
    },
    receipt._etag
      ? { accessCondition: { type: "IfMatch", condition: receipt._etag } }
      : undefined
  );
  return "retry";
}
