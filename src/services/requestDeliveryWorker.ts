import type {
  CloudAdapter,
  ConversationReference,
  TurnContext,
} from "botbuilder";
import { deliver } from "../channels/deliver";
import { outboundCard } from "../channels/teamsCard";
import { toPlainText } from "../channels/types";
import {
  deferAgentRequestDelivery,
  markAgentRequestDelivered,
  nextUndeliveredResult,
  type QueuedAgentRequest,
} from "./requestQueue";

const POLL_MS = Number(process.env.DELIVERY_POLL_MS ?? 2_000);
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export function startRequestDeliveryWorker(
  adapter: CloudAdapter,
  botAppId: string
): void {
  if (timer) return;
  timer = setInterval(() => void tickDelivery(adapter, botAppId), POLL_MS);
  void tickDelivery(adapter, botAppId);
  console.log(`[delivery-worker] polling every ${POLL_MS}ms`);
}

export function stopRequestDeliveryWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
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
