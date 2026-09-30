import type {
  CloudAdapter,
  ConversationReference,
  TurnContext,
} from "botbuilder";
import { recordAckTurn } from "../channels/acceptInbound";
import { missedAckMessage } from "../channels/acknowledge";
import { deliver } from "../channels/deliver";
import { outboundCard } from "../channels/teamsCard";
import { toPlainText } from "../channels/types";
import {
  claimDuePendingAck,
  completeAckReceipt,
  deferPendingAck,
  type PendingAckReceipt,
} from "./inboundReceipts";
import {
  deferAgentRequestDelivery,
  markAgentRequestDelivered,
  nextUndeliveredResult,
  type QueuedAgentRequest,
} from "./requestQueue";

const POLL_MS = Number(process.env.DELIVERY_POLL_MS ?? 2_000);
const SWEEP_MS = 15_000;
let timer: ReturnType<typeof setInterval> | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let running = false;
let sweeping = false;

export function startRequestDeliveryWorker(
  adapter: CloudAdapter,
  botAppId: string
): void {
  if (timer) return;
  timer = setInterval(() => void tickDelivery(adapter, botAppId), POLL_MS);
  sweepTimer = setInterval(() => void sweepMissedAcks(adapter, botAppId), SWEEP_MS);
  void tickDelivery(adapter, botAppId);
  void sweepMissedAcks(adapter, botAppId);
  console.log(`[delivery-worker] polling every ${POLL_MS}ms, missed-ack sweep every ${SWEEP_MS}ms`);
}

export function stopRequestDeliveryWorker(): void {
  if (timer) clearInterval(timer);
  if (sweepTimer) clearInterval(sweepTimer);
  timer = undefined;
  sweepTimer = undefined;
}

export async function tickDelivery(
  adapter: CloudAdapter,
  botAppId: string
): Promise<void> {
  if (running) return;
  running = true;
  try {
    const request = await nextUndeliveredResult();
    if (request?.result) {
      await deliverResult(adapter, botAppId, request);
    }
  } catch (err) {
    console.error("[delivery-worker] tick failed:", err);
  } finally {
    running = false;
  }
}

async function deliverResult(
  adapter: CloudAdapter,
  botAppId: string,
  request: QueuedAgentRequest
): Promise<void> {
  try {
    let delivered = false;
    if (
      request.result &&
      request.channel === "teams" &&
      request.conversationRef.channel === "teams"
    ) {
      await adapter.continueConversationAsync(
        botAppId,
        request.conversationRef.teamsRef as Partial<ConversationReference>,
        async (ctx: TurnContext) => {
          await ctx.sendActivity({ attachments: [outboundCard(request.result!)] });
        }
      );
      delivered = true;
    } else if (
      request.result &&
      request.conversationRef.channel === "imessage"
    ) {
      delivered = await deliver(
        request.userId,
        toPlainText(
          request.result.title,
          request.result.body,
          request.result.tags
        ),
        request.conversationRef
      );
    }
    if (!delivered) throw new Error("No channel accepted the queued result.");
    await markAgentRequestDelivered(request);
  } catch (err) {
    await deferAgentRequestDelivery(request, (err as Error).message);
    console.error(`[delivery-worker] delivery deferred for ${request.id}:`, err);
  }
}

export async function sweepMissedAcks(
  adapter: CloudAdapter,
  botAppId: string
): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const receipt = await claimDuePendingAck();
    if (receipt) await recoverPendingAck(adapter, botAppId, receipt);
  } catch (err) {
    console.error("[delivery-worker] missed-ack sweep failed:", err);
  } finally {
    sweeping = false;
  }
}

async function recoverPendingAck(
  adapter: CloudAdapter,
  botAppId: string,
  receipt: PendingAckReceipt
): Promise<void> {
  const text = missedAckMessage(receipt.firstName, receipt.replyText);
  try {
    const delivered = await sendMissedAck(adapter, botAppId, receipt, text);
    if (!delivered) throw new Error("No channel accepted the missed acknowledgement.");
    await completeAckReceipt(receipt);
    await recordAckTurn({
      userId: receipt.userId,
      channel: receipt.channel,
      conversationId: receipt.conversationId,
      userText: receipt.userText,
      replyText: text,
      trigger: "missed_ack",
    });
  } catch (err) {
    const outcome = await deferPendingAck(receipt);
    console.error(
      `[delivery-worker] missed ack ${outcome} for ${receipt.id}:`,
      err
    );
  }
}

async function sendMissedAck(
  adapter: CloudAdapter,
  botAppId: string,
  receipt: PendingAckReceipt,
  text: string
): Promise<boolean> {
  const ref = receipt.conversationRef;
  if (
    ref?.channel === "teams" &&
    ref.teamsRef
  ) {
    await adapter.continueConversationAsync(
      botAppId,
      ref.teamsRef as Partial<ConversationReference>,
      async (ctx: TurnContext) => {
        await ctx.sendActivity(text);
      }
    );
    return true;
  }
  if (ref?.channel === "imessage") {
    return deliver(receipt.userId, text, ref);
  }
  return false;
}
