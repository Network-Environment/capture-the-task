import {
  type CloudAdapter,
  type ConversationReference,
  type TurnContext,
} from "botbuilder";
import { processCapture, type Outbound } from "../pipeline";
import { createTodoTask, getGraphUserToken, graphAccessForUser } from "./graphTasks";
import { logActivity } from "./activityLog";
import { alertAdmin } from "./alerts";
import { classifyFailure } from "../runtime/errors";
import { beat } from "../runtime/health";
import {
  beginRequestRun,
  claimNextAgentRequest,
  completeAgentRequest,
  getAgentRequest,
  listDueQueuedRequests,
  markAgentRequestFailed,
  quarantineAgentRequest,
  retryAgentRequest,
  saveRequestCheckpoint,
  type QueuedAgentRequest,
} from "./requestQueue";
import { openIncident } from "./recoveryIncidents";
import { RunFencedError, isUnknownMutation, sealPendingMutations, type MutationLedger } from "./runFence";

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
let lastTickAt = Date.now();

export function requestWorkerHealthy(now = Date.now()): boolean {
  if (startTimer) return true;
  if (!timer) return false;
  if (running && now - lastTickAt > REQUEST_DEADLINE_MS + 30_000) return false;
  return now - lastTickAt < POLL_MS * 4 + REQUEST_DEADLINE_MS;
}

async function reportStaleQueue(): Promise<void> {
  try {
    const stale = await listDueQueuedRequests();
    for (const request of stale) {
      await openIncident({
        source: "stale-queue",
        subject: request.id,
        kind: "queue",
        summary: `Queued request ${request.id} has been waiting since ${request.createdAt}.`,
        requestId: request.id,
      });
      await alertAdmin(
        `Queued request ${request.id} on ${request.channel} has been waiting since ${request.createdAt}. The user already received an acknowledgement.`
      );
    }
  } catch (err) {
    console.error("[request-worker] stale-queue check failed:", err);
  }
}

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
  lastTickAt = Date.now();
  beat("request-worker", POLL_MS * 4 + REQUEST_DEADLINE_MS);
  try {
    const request = await claimNextAgentRequest();
    await reportStaleQueue();
    if (request) await processRequest(adapter, botAppId, request);
  } catch (err) {
    console.error("[request-worker] tick failed:", err);
  } finally {
    running = false;
  }
}

export function shouldRerunAfterDetail(
  title: string,
  previousText: string,
  latestText: string | undefined
): boolean {
  return title === "Need one detail" && Boolean(latestText) && latestText !== previousText;
}

async function processRequest(
  adapter: CloudAdapter,
  botAppId: string,
  request: QueuedAgentRequest
): Promise<void> {
  const controller = new AbortController();
  let ledger: MutationLedger | undefined;
  try {
    const current = await beginRequestRun((await getAgentRequest(request.id)) ?? request);
    ledger = {
      checkpoint: current.checkpoint ?? {
        runId: current.activeRunId ?? current.id,
        generation: current.generation ?? 1,
        completedIntents: [],
        mutations: [],
      },
      persist: async (next) => {
        ledger!.checkpoint = next;
        await saveRequestCheckpoint(current.id, next);
      },
    };
    const run = async (item: QueuedAgentRequest) => {
      if (item.channel === "teams") return processTeamsRequest(adapter, botAppId, item, controller.signal, ledger);
      const graph = await graphAccessForUser(adapter, botAppId, item.userId);
      return processCapture({
        userId: item.userId,
        channel: "imessage",
        text: item.text,
        conversationId: item.conversationId,
        policy: item.policy,
        conversationRef: item.conversationRef,
        getGraphToken: graph?.getGraphToken,
        createTask: graph?.createTask,
        traceId: item.activeRunId,
        runId: item.activeRunId,
        signal: controller.signal,
        ledger,
      });
    };
    let out = await withDeadline(run(current), REQUEST_DEADLINE_MS, request.id);
    const latest = await getAgentRequest(request.id);
    if (latest?.activeRunId && latest.activeRunId !== current.activeRunId) throw new RunFencedError(current.activeRunId ?? request.id);
    if (latest && !latest.checkpoint?.mutations.length && latest.text !== current.text) {
      out = await withDeadline(run(latest), REQUEST_DEADLINE_MS, request.id);
    } else if (latest && latest.text !== current.text) {
      out = {
        ...out,
        body: `${out.body}\n\nI also kept the follow-up you sent while this was running.`,
      };
    } else if (latest && shouldRerunAfterDetail(out.title, current.text, latest.text)) {
      out = await withDeadline(run(latest), REQUEST_DEADLINE_MS, request.id);
    }
    controller.abort();
    await completeAgentRequest(latest ?? current, out);
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
    controller.abort();
    const message = (err as Error).message;
    let failed = (await getAgentRequest(request.id)) ?? request;
    if (ledger) {
      const sealed = sealPendingMutations(ledger.checkpoint);
      ledger.checkpoint = sealed;
      failed = { ...failed, checkpoint: sealed };
    }
    // A request that ran out its deadline is terminal: retrying it would stall
    // the worker again and starve everyone behind it.
    const kind = classifyFailure(isUnknownMutation(err) ? new Error("mutation may have succeeded") : err, {
      mutating: Boolean(failed.checkpoint?.mutations.some((row) => row.status !== "completed")),
    });
    let retrying = false;
    if (err instanceof RunFencedError) return;
    if (kind === "deadline" || kind === "unknown_outcome" || (kind === "permanent" && request.attempts >= 3)) {
      await quarantineAgentRequest(failed, message, kind === "permanent" ? "permanent" : kind);
    } else if (kind === "permanent") {
      await markAgentRequestFailed(failed, message);
    } else {
      retrying = await retryAgentRequest(failed, message);
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
  request: QueuedAgentRequest,
  signal?: AbortSignal,
  ledger?: MutationLedger
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
        getGraphToken: () => getGraphUserToken(ctx),
        traceId: request.activeRunId,
        runId: request.activeRunId,
        signal,
        ledger,
      });
    }
  );
  if (!result) throw new Error("Queued Teams request produced no result.");
  return result;
}
