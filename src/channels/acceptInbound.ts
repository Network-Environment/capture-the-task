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
import { recordConversationTurn } from "../services/sessionFold";
import { logActivity } from "../services/activityLog";

export async function acceptInboundMessage(input: {
  userId: string;
  channel: Channel;
  text: string;
  eventId: string;
  conversationId: string;
  displayNameHint?: string;
  scope?: "private" | "group";
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
    scope?: "private" | "group";
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
    scope: input.scope,
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
    scope: input.scope,
    userText: input.text,
    replyText: leased.replyText,
    trigger: "inbound_quality_gate",
  });
}

export async function recordAckTurn(input: {
  userId: string;
  channel: Channel;
  conversationId?: string;
  scope?: "private" | "group";
  userText: string;
  replyText: string;
  trigger: string;
}): Promise<void> {
  const scope = input.scope ?? (input.channel === "imessage" ? "private" : "group");
  await recordConversationTurn({
    userId: input.userId,
    role: "user",
    text: input.userText,
    conversationId: input.conversationId,
    scope,
    channel: input.channel,
    intent: "quality_help",
  });
  await recordConversationTurn({
    userId: input.userId,
    role: "assistant",
    text: input.replyText,
    body: input.replyText,
    conversationId: input.conversationId,
    scope,
    channel: input.channel,
    intent: "quality_help",
    outcome: "help",
  });
  void logActivity({
    type: "inbound_quality",
    userId: input.userId,
    origin: "user_message",
    channel: input.channel,
    trigger: input.trigger,
    detail: { disposition: "help", reason: "probe" },
  });
}
