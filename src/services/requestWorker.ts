import {
  type CloudAdapter,
  type ConversationReference,
  type TurnContext,
} from "botbuilder";
import { processCapture, type Outbound } from "../pipeline";
import { createTodoTask } from "./graphTasks";
import { deliver } from "../channels/deliver";
import { outboundCard } from "../channels/teamsCard";
import { toPlainText } from "../channels/types";
import { logActivity } from "./activityLog";
import {
  claimNextAgentRequest,
  completeAgentRequest,
  deferAgentRequestDelivery,
  markAgentRequestDelivered,
  nextUndeliveredResult,
  retryAgentRequest,
  type QueuedAgentRequest,
} from "./requestQueue";

const POLL_MS = 1_000;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export function startRequestWorker(adapter: CloudAdapter, botAppId: string): void {
  if (timer) return;
  timer = setInterval(() => void tick(adapter, botAppId), POLL_MS);
  void tick(adapter, botAppId);
  console.log("[request-worker] durable queue polling every 1s, concurrency=1");
}

export function stopRequestWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function tick(
  adapter: CloudAdapter,
  botAppId: string
): Promise<void> {
  if (running) return;
  running = true;
  try {
    const request = await claimNextAgentRequest();
    if (request) await processRequest(adapter, botAppId, request);

    const undelivered = await nextUndeliveredResult();
    if (undelivered?.result) {
      await deliverResult(adapter, botAppId, undelivered, undelivered.result);
    }
  } catch (err) {
    console.error("[request-worker] tick failed:", err);
  } finally {
    running = false;
  }
}

async function processRequest(
  adapter: CloudAdapter,
  botAppId: string,
  request: QueuedAgentRequest
): Promise<void> {
  try {
    const out =
      request.channel === "teams"
        ? await processTeamsRequest(adapter, botAppId, request)
        : await processCapture({
            userId: request.userId,
            channel: "imessage",
            text: request.text,
            conversationId: request.conversationId,
            policy: request.policy,
            conversationRef: request.conversationRef,
          });
    await completeAgentRequest(request, out);
    void logActivity({
      type: "request_queue",
      userId: request.userId,
      origin: "user_message",
      channel: request.channel,
      trigger: "request_completed",
      detail: {
        requestId: request.id,
        attempts: request.attempts,
        waitMs: Date.now() - Date.parse(request.createdAt),
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    const retrying = await retryAgentRequest(request, message);
    console.error(
      `[request-worker] ${request.id} ${retrying ? "retrying" : "failed"}:`,
      err
    );
    void logActivity({
      type: "request_queue",
      userId: request.userId,
      origin: "user_message",
      channel: request.channel,
      trigger: retrying ? "request_retry" : "request_failed",
      detail: {
        requestId: request.id,
        attempts: request.attempts,
        message: message.slice(0, 300),
      },
    });
    if (!retrying) {
      await deliverFailure(adapter, botAppId, request).catch(() => undefined);
    }
  }
}

async function processTeamsRequest(
  adapter: CloudAdapter,
  botAppId: string,
  request: QueuedAgentRequest
): Promise<Outbound> {
  if (request.conversationRef.channel !== "teams") {
    throw new Error("Queued Teams request has no Teams conversation reference.");
  }
  const teamsRef = request.conversationRef.teamsRef;
  let result: Outbound | undefined;
  await adapter.continueConversationAsync(
    botAppId,
    teamsRef as Partial<ConversationReference>,
    async (ctx: TurnContext) => {
      result = await processCapture({
        userId: request.userId,
        channel: "teams",
        text: request.text,
        conversationId: request.conversationId,
        policy: request.policy,
        conversationRef: teamsRef,
        createTask: (title, detail, due) =>
          createTodoTask(ctx, title, detail, due),
      });
    }
  );
  if (!result) throw new Error("Queued Teams request produced no result.");
  return result;
}

async function deliverResult(
  adapter: CloudAdapter,
  botAppId: string,
  request: QueuedAgentRequest,
  out: Outbound
): Promise<void> {
  try {
    let delivered = false;
    if (
      request.channel === "teams" &&
      request.conversationRef.channel === "teams"
    ) {
      await adapter.continueConversationAsync(
        botAppId,
        request.conversationRef.teamsRef as Partial<ConversationReference>,
        async (ctx: TurnContext) => {
          await ctx.sendActivity({ attachments: [outboundCard(out)] });
        }
      );
      delivered = true;
    } else if (request.conversationRef.channel === "imessage") {
      delivered = await deliver(
        request.userId,
        toPlainText(out.title, out.body, out.tags),
        request.conversationRef
      );
    }
    if (!delivered) throw new Error("No channel accepted the queued result.");
    await markAgentRequestDelivered(request);
  } catch (err) {
    await deferAgentRequestDelivery(request, (err as Error).message);
    console.error(`[request-worker] delivery deferred for ${request.id}:`, err);
  }
}

async function deliverFailure(
  adapter: CloudAdapter,
  botAppId: string,
  request: QueuedAgentRequest
): Promise<void> {
  const message =
    `Request ${request.id} failed after ${request.attempts} attempts. ` +
    "Nothing was intentionally discarded; please retry the request.";
  if (request.channel === "teams" && request.conversationRef.channel === "teams") {
    await adapter.continueConversationAsync(
      botAppId,
      request.conversationRef.teamsRef as Partial<ConversationReference>,
      async (ctx: TurnContext) => {
        await ctx.sendActivity(message);
      }
    );
    return;
  }
  await deliver(request.userId, message, request.conversationRef);
}
