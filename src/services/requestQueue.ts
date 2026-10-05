import { createHash } from "node:crypto";
import type { ConversationReference } from "botbuilder";
import type { Channel } from "../channels/types";
import type { ChannelPolicy } from "./intent";
import { cosmosContainer } from "./cosmos";
import type { Outbound } from "../pipeline";

const BUCKET = "agent";
const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60_000;

export type RequestStatus = "queued" | "processing" | "completed" | "failed";

export interface QueuedAgentRequest {
  id: string;
  bucket: typeof BUCKET;
  userId: string;
  channel: Channel;
  text: string;
  eventId: string;
  conversationId: string;
  conversationRef:
    | { channel: "teams"; teamsRef: Partial<ConversationReference> }
    | { channel: "imessage"; phone: string; spaceId?: string };
  policy: ChannelPolicy;
  status: RequestStatus;
  attempts: number;
  createdAt: string;
  availableAt: string;
  claimedAt?: string;
  leaseUntil?: string;
  finishedAt?: string;
  lastError?: string;
  resultPreview?: string;
  result?: Outbound;
  deliveredAt?: string;
  deliveryAttempts?: number;
  deliveryLeaseUntil?: string;
  nextDeliveryAt?: string;
  ttl: number;
  _etag?: string;
}

function requests() {
  return cosmosContainer("agent-requests");
}

export function requestId(channel: Channel, eventId: string): string {
  return `rq-${createHash("sha256").update(`${channel}:${eventId}`).digest("hex").slice(0, 24)}`;
}

export function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function mergeRequestText(existing: string, extra: string): string {
  const next = extra.trim();
  if (!next || existing.trim() === next || existing.endsWith(`\n${next}`)) return existing;
  return `${existing.trim()}\n${next}`;
}

export async function getAgentRequest(id: string): Promise<QueuedAgentRequest | undefined> {
  try {
    const { resource } = await requests().item(id, BUCKET).read<QueuedAgentRequest>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

export async function attachToInFlight(
  userId: string,
  conversationId: string,
  text: string
): Promise<{ request: QueuedAgentRequest; disposition: "attached" | "duplicate" } | undefined> {
  const { resources } = await requests()
    .items.query<QueuedAgentRequest>({
      query:
        "SELECT TOP 1 * FROM c WHERE c.bucket = @bucket AND c.userId = @user " +
        "AND c.conversationId = @conv AND c.status IN ('queued', 'processing') " +
        "ORDER BY c.createdAt DESC",
      parameters: [
        { name: "@bucket", value: BUCKET },
        { name: "@user", value: userId },
        { name: "@conv", value: conversationId },
      ],
    })
    .fetchAll();
  const open = resources[0];
  if (!open) return undefined;
  const merged = mergeRequestText(open.text, text);
  if (merged === open.text) return { request: open, disposition: "duplicate" };
  try {
    const { resource } = await requests()
      .item(open.id, BUCKET)
      .replace(
        { ...open, text: merged },
        { accessCondition: { type: "IfMatch", condition: open._etag ?? "" } }
      );
    return {
      request: (resource as unknown as QueuedAgentRequest | undefined) ?? { ...open, text: merged },
      disposition: "attached",
    };
  } catch (err) {
    if ((err as { code?: number }).code !== 412) throw err;
    return undefined;
  }
}

export type EnqueueDisposition = "created" | "duplicate" | "attached";

export async function enqueueAgentRequest(
  input: Omit<
    QueuedAgentRequest,
    | "id"
    | "bucket"
    | "status"
    | "attempts"
    | "createdAt"
    | "availableAt"
    | "ttl"
    | "_etag"
  >
): Promise<{ request: QueuedAgentRequest; created: boolean; disposition: EnqueueDisposition }> {
  const attached = await attachToInFlight(input.userId, input.conversationId, input.text);
  if (attached) {
    return { request: attached.request, created: false, disposition: attached.disposition };
  }
  const now = new Date().toISOString();
  const request: QueuedAgentRequest = {
    ...input,
    id: requestId(input.channel, input.eventId),
    bucket: BUCKET,
    status: "queued",
    attempts: 0,
    createdAt: now,
    availableAt: now,
    ttl: 604800,
  };
  try {
    const { resource } = await requests().items.create(request);
    return { request: resource ?? request, created: true, disposition: "created" };
  } catch (err) {
    if ((err as { code?: number }).code !== 409) throw err;
    const { resource } = await requests()
      .item(request.id, BUCKET)
      .read<QueuedAgentRequest>();
    return { request: resource ?? request, created: false, disposition: "duplicate" };
  }
}

export async function claimNextAgentRequest(
  now = new Date()
): Promise<QueuedAgentRequest | undefined> {
  const nowIso = now.toISOString();
  const { resources } = await requests()
    .items.query<QueuedAgentRequest>({
      query: `SELECT TOP 5 * FROM c
        WHERE c.bucket = @bucket
          AND (
            (c.status = "queued" AND c.availableAt <= @now)
            OR (c.status = "processing" AND c.leaseUntil < @now)
          )
        ORDER BY c.createdAt ASC`,
      parameters: [
        { name: "@bucket", value: BUCKET },
        { name: "@now", value: nowIso },
      ],
    })
    .fetchAll();

  for (const candidate of resources) {
    if (candidate.attempts >= MAX_ATTEMPTS) {
      await markAgentRequestFailed(candidate, "Request lease expired after maximum attempts.");
      continue;
    }
    const claimed: QueuedAgentRequest = {
      ...candidate,
      status: "processing",
      attempts: candidate.attempts + 1,
      claimedAt: nowIso,
      leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
      lastError: undefined,
    };
    try {
      const { resource } = await requests()
        .item(candidate.id, BUCKET)
        .replace(claimed, {
          accessCondition: {
            type: "IfMatch",
            condition: candidate._etag ?? "",
          },
        });
      return (resource as unknown as QueuedAgentRequest | undefined) ?? claimed;
    } catch (err) {
      if ((err as { code?: number }).code !== 412) throw err;
    }
  }
  return undefined;
}

export async function completeAgentRequest(
  request: QueuedAgentRequest,
  result: Outbound
): Promise<void> {
  await replaceRequest(request, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    leaseUntil: undefined,
    result,
    resultPreview: result.summaryLine.slice(0, 500),
    deliveryAttempts: 0,
    nextDeliveryAt: new Date().toISOString(),
    ttl: 604800,
  });
}

export async function nextUndeliveredResult(
  now = new Date()
): Promise<QueuedAgentRequest | undefined> {
  const { resources } = await requests()
    .items.query<QueuedAgentRequest>({
      query: `SELECT TOP 5 * FROM c
        WHERE c.bucket = @bucket
          AND c.status IN ("completed", "failed")
          AND IS_DEFINED(c.result)
          AND NOT IS_DEFINED(c.deliveredAt)
          AND c.nextDeliveryAt <= @now
          AND (
            NOT IS_DEFINED(c.deliveryLeaseUntil)
            OR c.deliveryLeaseUntil < @now
          )
        ORDER BY c.finishedAt ASC`,
      parameters: [
        { name: "@bucket", value: BUCKET },
        { name: "@now", value: now.toISOString() },
      ],
    })
    .fetchAll();
  for (const candidate of resources) {
    const claimed = {
      ...candidate,
      deliveryAttempts: (candidate.deliveryAttempts ?? 0) + 1,
      deliveryLeaseUntil: new Date(now.getTime() + 2 * 60_000).toISOString(),
    };
    try {
      const { resource } = await requests()
        .item(candidate.id, BUCKET)
        .replace(claimed, {
          accessCondition: {
            type: "IfMatch",
            condition: candidate._etag ?? "",
          },
        });
      return (resource as unknown as QueuedAgentRequest | undefined) ?? claimed;
    } catch (err) {
      if ((err as { code?: number }).code !== 412) throw err;
    }
  }
  return undefined;
}

export async function markAgentRequestDelivered(
  request: QueuedAgentRequest
): Promise<void> {
  await replaceRequest(request, {
    deliveredAt: new Date().toISOString(),
    deliveryLeaseUntil: undefined,
    ttl: 172800,
  });
}

export async function deferAgentRequestDelivery(
  request: QueuedAgentRequest,
  error: string
): Promise<void> {
  const attempts = request.deliveryAttempts ?? 1;
  await replaceRequest(request, {
    deliveryLeaseUntil: undefined,
    nextDeliveryAt: new Date(
      Date.now() + Math.min(15 * 60_000, retryDelayMs(attempts))
    ).toISOString(),
    lastError: `Delivery: ${error}`.slice(0, 500),
  });
}

export async function retryAgentRequest(
  request: QueuedAgentRequest,
  error: string
): Promise<boolean> {
  if (request.attempts >= MAX_ATTEMPTS) {
    await markAgentRequestFailed(request, error);
    return false;
  }
  await replaceRequest(request, {
    status: "queued",
    availableAt: new Date(Date.now() + retryDelayMs(request.attempts)).toISOString(),
    leaseUntil: undefined,
    lastError: error.slice(0, 500),
  });
  return true;
}

export async function markAgentRequestFailed(
  request: QueuedAgentRequest,
  error: string
): Promise<void> {
  const result: Outbound = {
    title: "Request failed",
    body:
      `Request \`${request.id}\` could not finish safely. ` +
      "Nothing was intentionally discarded; please retry or contact an administrator.",
    tags: [],
    summaryLine: `Request failed: ${error}`.slice(0, 500),
  };
  await replaceRequest(request, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    leaseUntil: undefined,
    lastError: error.slice(0, 500),
    result,
    resultPreview: result.summaryLine,
    deliveryAttempts: 0,
    nextDeliveryAt: new Date().toISOString(),
    ttl: 604800,
  });
}

/** A due request that is still queued after the user was told work had started. */
export const STALE_QUEUED_REQUEST_MS = 2 * 60_000;

export function queuedRequestIsStale(
  request: Pick<QueuedAgentRequest, "status" | "createdAt" | "availableAt">,
  now = new Date(),
  thresholdMs = STALE_QUEUED_REQUEST_MS
): boolean {
  if (request.status !== "queued") return false;
  const available = Date.parse(request.availableAt);
  const created = Date.parse(request.createdAt);
  if (!Number.isFinite(available) || !Number.isFinite(created)) return false;
  if (available > now.getTime()) return false;
  return now.getTime() - created >= thresholdMs;
}

export async function listDueQueuedRequests(now = new Date()): Promise<QueuedAgentRequest[]> {
  const cutoff = new Date(now.getTime() - STALE_QUEUED_REQUEST_MS).toISOString();
  const { resources } = await requests()
    .items.query<QueuedAgentRequest>({
      query: `SELECT c.id, c.userId, c.channel, c.status, c.createdAt, c.availableAt FROM c
        WHERE c.bucket = @bucket
          AND c.status = "queued"
          AND c.availableAt <= @now
          AND c.createdAt <= @cutoff`,
      parameters: [
        { name: "@bucket", value: BUCKET },
        { name: "@now", value: now.toISOString() },
        { name: "@cutoff", value: cutoff },
      ],
    })
    .fetchAll();
  return resources.filter((request) => queuedRequestIsStale(request, now));
}

async function replaceRequest(
  request: QueuedAgentRequest,
  patch: Partial<QueuedAgentRequest>
): Promise<void> {
  await requests()
    .item(request.id, BUCKET)
    .replace(
      { ...request, ...patch },
      request._etag
        ? {
            accessCondition: {
              type: "IfMatch",
              condition: request._etag,
            },
          }
        : undefined
    );
}
