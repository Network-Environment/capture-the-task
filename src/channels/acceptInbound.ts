/**
 * Shared inbound acknowledgement for every interactive channel.
 * A greeting or probe is answered here and not queued. Everything else is
 * composed first, then enqueued, then acknowledged.
 */
import { attachedAck, composeAcknowledgement, fallbackAck, type AckDraft } from "./acknowledge";
import type { Channel } from "./types";
import type { StoredRef } from "../services/conversations";
import { socialOnlyKind } from "../services/inboundQuality";
import {
  completeAckReceipt,
  createPendingAck,
  leaseAckSend,
} from "../services/inboundReceipts";
import type { EnqueueDisposition } from "../services/requestQueue";
import { appendTurn } from "../services/session";
import { logActivity } from "../services/activityLog";

export async function acceptInboundMessage(input: {
  userId: string;
  channel: Channel;
  text: string;
  eventId: string;
  conversationId: string;
  displayNameHint?: string;
  conversationRef: StoredRef;
  send: (text: string) => Promise<unknown>;
  enqueue: () => Promise<EnqueueDisposition>;
}): Promise<void> {
  const draft = await draftAcknowledgement(input);
  if (draft.kind === "reply") {
    await sendSocialReply(input, draft);
    return;
  }
  const disposition = await input.enqueue();
  if (disposition === "duplicate") return;
  const line = disposition === "attached" ? attachedAck(draft.firstName) : draft.text;
  await input.send(line);
}

async function draftAcknowledgement(input: {
  userId: string;
  channel: Channel;
  text: string;
  displayNameHint?: string;
}): Promise<AckDraft> {
  try {
    return await composeAcknowledgement(input);
  } catch (err) {
    console.error("[ack] compose failed:", err);
    const social = socialOnlyKind(input.text);
    const kind = social ? "reply" : "receipt";
    return { kind, social, text: fallbackAck(kind, social) };
  }
}

async function sendSocialReply(
  input: {
    userId: string;
    channel: Channel;
    text: string;
    eventId: string;
    conversationId: string;
    conversationRef: StoredRef;
    send: (text: string) => Promise<unknown>;
  },
  draft: AckDraft
): Promise<void> {
  const created = await createPendingAck({
    channel: input.channel,
    eventId: input.eventId,
    userId: input.userId,
    userText: input.text,
    replyText: draft.text,
    firstName: draft.firstName,
    conversationId: input.conversationId,
    conversationRef: input.conversationRef,
  });
  if (created.outcome === "exists") return;
  const leased = await leaseAckSend(created.receipt);
  if (!leased) return;
  try {
    await input.send(leased.replyText);
  } catch (err) {
    console.error("[ack] social send failed; sweeper will recover:", err);
    return;
  }
  try {
    await completeAckReceipt(leased);
  } catch (err) {
    console.error("[ack] social complete failed:", err);
    return;
  }
  await recordAckTurn({
    userId: input.userId,
    channel: input.channel,
    conversationId: input.conversationId,
    userText: input.text,
    replyText: leased.replyText,
    trigger: "inbound_quality_gate",
  });
}

export async function recordAckTurn(input: {
  userId: string;
  channel: Channel;
  conversationId?: string;
  userText: string;
  replyText: string;
  trigger: string;
}): Promise<void> {
  try {
    await appendTurn(input.userId, "user", input.userText, input.conversationId, {
      intent: "quality_help",
    });
    await appendTurn(input.userId, "assistant", input.replyText, input.conversationId, {
      intent: "quality_help",
      outcome: "help",
    });
  } catch (err) {
    console.error("[ack] session write failed:", err);
  }
  void logActivity({
    type: "inbound_quality",
    userId: input.userId,
    origin: "user_message",
    channel: input.channel,
    trigger: input.trigger,
    detail: { disposition: "help", reason: "probe" },
  });
}
