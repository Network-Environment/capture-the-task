import {
  type CloudAdapter,
  type ConversationReference,
  type TurnContext,
} from "botbuilder";
import { processCapture, type Outbound } from "../pipeline";
import { createTodoTask } from "./graphTasks";
import { logActivity } from "./activityLog";
import {
  claimNextAgentRequest,
  completeAgentRequest,
  markAgentRequestFailed,
  retryAgentRequest,
  type QueuedAgentRequest,
} from "./requestQueue";

const POLL_MS = Number(process.env.REQUEST_POLL_MS ?? 5_000);
/**
 * A request that wedges the worker is re-claimed on the next boot, so the app
 * never stays up long enough to drain it. The grace period lets the container
 * pass its health probe first, and the deadline bounds any single request.
 */
const START_DELAY_MS = Number(process.env.REQUEST_WORKER_START_DELAY_MS ?? 45_000);
const REQUEST_DEADLINE_MS = Number(process.env.REQUEST_DEADLINE_MS ?? 240_000);

let timer: ReturnType<typeof setInterval> | undefined;
let startTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;

class RequestDeadline extends Error {
  constructor(id: string, ms: number) {
    super(`request ${id} exceeded its ${ms}ms deadline`);
    this.name = "RequestDeadline";
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, id: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new RequestDeadline(id, ms)), ms);
    work.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export function startRequestWorker(adapter: CloudAdapter, botAppId: string): void {
  if (timer || startTimer) return;
  startTimer = setTimeout(() => {
    startTimer = undefined;
    timer = setInterval(() => void tick(adapter, botAppId), POLL_MS);
    void tick(adapter, botAppId);
  }, START_DELAY_MS);
  console.log(
    `[request-worker] starting in ${START_DELAY_MS}ms, then polling every ${POLL_MS}ms, concurrency=1`
  );
}

export function stopRequestWorker(): void {
  if (timer) clearInterval(timer);
  if (startTimer) clearTimeout(startTimer);
  timer = undefined;
  startTimer = undefined;
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
    const work =
      request.channel === "teams"
        ? processTeamsRequest(adapter, botAppId, request)
        : processCapture({
            userId: request.userId,
            channel: "imessage",
            text: request.text,
            conversationId: request.conversationId,
            policy: request.policy,
            conversationRef: request.conversationRef,
          });
    const out = await withDeadline(work, REQUEST_DEADLINE_MS, request.id);
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
    // A request that ran out its deadline is terminal: retrying it would stall
    // the worker again and starve everyone behind it.
    let retrying = false;
    if (err instanceof RequestDeadline) {
      await markAgentRequestFailed(request, message);
    } else {
      retrying = await retryAgentRequest(request, message);
    }
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
