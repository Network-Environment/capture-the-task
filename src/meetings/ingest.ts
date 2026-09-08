import { embed } from "../services/router";
import { logActivity } from "../services/activityLog";
import { rememberLesson } from "../services/agentMemory";
import { ORG_LESSON_USER } from "./access";
import {
  downloadVtt,
  getMeetingMeta,
  getTranscriptDelta,
  listEnabledUsers,
  type GraphTranscript,
} from "./graph";
import { applyMatches, orgLessonTexts } from "./match";
import {
  claimQueuedTranscripts,
  getCheckpoint,
  getTranscriptAvailability,
  listOpenCommitments,
  meetingExists,
  meetingTtlSeconds,
  recordTranscriptAvailability,
  renderMeetingMarkdown,
  saveCheckpoint,
  saveHealth,
  setTranscriptAvailabilityStatus,
  transcriptAvailabilityId,
  upsertCommitment,
  upsertMeeting,
  writeMeetingMarkdown,
} from "./store";
import { summarizeTranscript } from "./summarize";
import type {
  IngestResult,
  MeetingDoc,
  TranscriptAvailabilityDoc,
} from "./types";
import { capTranscript, isTooShort, parseVtt } from "./vtt";

const ORGANIZERS_PER_RUN = Number(process.env.MEETING_ORGANIZERS_PER_RUN ?? 25);
const BACKFILL_DAYS = 30;
const QUEUE_PER_RUN = Number(process.env.MEETING_SUMMARIES_PER_RUN ?? 2);

export function sliceOrganizers<T>(users: T[], start: number, n = ORGANIZERS_PER_RUN): { slice: T[]; next: number } {
  if (!users.length) return { slice: [], next: 0 };
  const i = ((start % users.length) + users.length) % users.length;
  const slice = [...users.slice(i), ...users.slice(0, i)].slice(0, n);
  return { slice, next: (i + slice.length) % users.length };
}

export function withinBackfillWindow(createdDateTime?: string, now = Date.now()): boolean {
  if (!createdDateTime) return false;
  const created = Date.parse(createdDateTime);
  return Number.isFinite(created) && created >= now - BACKFILL_DAYS * 86400_000;
}

export function mergeDiscoveryItems(
  liveItems: GraphTranscript[],
  backfillItems: GraphTranscript[],
  hasExistingDelta: boolean,
  now = Date.now()
): GraphTranscript[] {
  const merged = new Map(
    (hasExistingDelta ? liveItems : []).map((t) => [t.id, t])
  );
  for (const t of backfillItems) {
    if (withinBackfillWindow(t.createdDateTime, now)) merged.set(t.id, t);
  }
  return [...merged.values()];
}

export async function processAvailableTranscript(
  item: TranscriptAvailabilityDoc
): Promise<{ status: "summarized" | "skipped_short" | "duplicate"; matched: number }> {
  if (await meetingExists(item.transcriptId)) {
    await setTranscriptAvailabilityStatus(item, "summarized", {
      completedAt: new Date().toISOString(),
    });
    return { status: "duplicate", matched: 0 };
  }

  const vtt = await downloadVtt(item.organizerId, item.meetingId, item.transcriptId);
  const spoken = capTranscript(parseVtt(vtt));
  if (isTooShort(spoken)) {
    await setTranscriptAvailabilityStatus(item, "skipped_short", {
      completedAt: new Date().toISOString(),
      error: "Transcript has fewer than 40 spoken words.",
    });
    return { status: "skipped_short", matched: 0 };
  }

  const meta = await getMeetingMeta(item.organizerId, item.meetingId);
  const summary = await summarizeTranscript({
    transcript: spoken,
    titleHint: meta?.subject ?? item.titleHint,
    organizerName: item.organizerName,
  });

  const now = new Date().toISOString();
  const id =
    item.transcriptId.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64) ||
    `mtg-${Date.now()}`;
  const path = `${now.slice(0, 7)}/${id}.md`;
  const ttl = meetingTtlSeconds();
  const embedText = `${summary.title}\n${summary.summary}\n${summary.decisions.join(" ")}\n${summary.actions.map((a) => a.text).join(" ")}`;
  const vector = await embed(embedText, {
    origin: "admin_summary",
    channel: "internal",
    trigger: "meeting_embedding",
  });

  const doc: MeetingDoc = {
    id,
    organizerId: item.organizerId,
    organizerName: item.organizerName,
    transcriptId: item.transcriptId,
    meetingId: item.meetingId,
    startAt: meta?.startDateTime ?? item.createdDateTime,
    title: summary.title,
    categories: summary.categories,
    summary: summary.summary,
    decisions: summary.decisions,
    actions: summary.actions,
    risks: summary.risks,
    openQuestions: summary.openQuestions,
    attendees: summary.attendees,
    path,
    createdAt: now,
    ttl,
    embedding: vector,
  };

  await writeMeetingMarkdown(path, renderMeetingMarkdown(doc));
  await upsertMeeting(doc);

  const open = await listOpenCommitments();
  const { upserts, matched } = applyMatches(open, summary, id, summary.title);
  for (const c of upserts) await upsertCommitment(c);

  for (const text of orgLessonTexts(summary, matched)) {
    await rememberLesson(ORG_LESSON_USER, "self", text);
  }

  await setTranscriptAvailabilityStatus(item, "summarized", {
    completedAt: now,
    meetingDocId: id,
    error: undefined,
  });
  void logActivity({
    type: "meeting_summary",
    agent: "meeting-worker",
    origin: "admin_summary",
    channel: "internal",
    detail: {
      transcriptId: item.transcriptId,
      title: summary.title,
      matched,
      actions: summary.actions.length,
      requestedBy: item.requestedBy,
    },
  });

  return { status: "summarized", matched };
}

export async function processQueuedTranscripts(
  log: { info?: (...a: unknown[]) => void } = console
): Promise<IngestResult> {
  const result: IngestResult = {
    scanned: 0,
    ingested: 0,
    skipped: 0,
    matched: 0,
    processed: 0,
    errors: [],
  };
  for (const item of await claimQueuedTranscripts(QUEUE_PER_RUN)) {
    result.scanned++;
    try {
      const processed = await processAvailableTranscript(item);
      result.processed!++;
      if (processed.status === "summarized") {
        result.ingested++;
        result.matched += processed.matched;
      } else {
        result.skipped++;
      }
    } catch (err) {
      const message = (err as Error).message;
      result.errors.push(
        `${item.organizerName ?? item.organizerId}: ${message}`.slice(0, 180)
      );
      await setTranscriptAvailabilityStatus(item, "failed", {
        retryCount: Number(item.retryCount ?? 0) + 1,
        error: message.slice(0, 500),
      });
      void logActivity({
        type: "error",
        agent: "meeting-worker",
        origin: "admin_summary",
        channel: "internal",
        detail: { transcriptId: item.transcriptId, message },
      });
    }
  }
  log.info?.(
    `[meeting-worker] processed=${result.processed} summarized=${result.ingested} skipped=${result.skipped} errors=${result.errors.length}`
  );
  return result;
}

async function discoverItem(
  user: { id: string; displayName?: string },
  t: GraphTranscript
): Promise<"created" | "existing" | "skipped"> {
  if (!t.meetingId) return "skipped";
  const id = transcriptAvailabilityId(t.id);
  const existing = await getTranscriptAvailability(user.id, id);
  if (existing) return "existing";
  const summarized = await meetingExists(t.id);
  const meta = await getMeetingMeta(user.id, t.meetingId);
  return recordTranscriptAvailability(
    {
      organizerId: user.id,
      organizerName: user.displayName,
      transcriptId: t.id,
      meetingId: t.meetingId,
      createdDateTime: meta?.startDateTime ?? t.createdDateTime,
      titleHint: meta?.subject,
    },
    summarized
  );
}

export async function runMeetingIngest(
  log: { info?: (...a: unknown[]) => void } = console
): Promise<IngestResult> {
  const result: IngestResult = {
    scanned: 0,
    ingested: 0,
    skipped: 0,
    matched: 0,
    discovered: 0,
    errors: [],
  };
  const users = await listEnabledUsers();
  const cursorDoc = await getCheckpoint("_scan");
  const start = Number(cursorDoc?.deltaLink ?? 0);
  const { slice, next: nextCursor } = sliceOrganizers(users, start);

  for (const user of slice) {
    result.scanned++;
    try {
      const cp = await getCheckpoint(user.id);
      const errorsBefore = result.errors.length;
      const { items, deltaLink } = await getTranscriptDelta(user.id, cp?.deltaLink);
      let discoveryItems = items;

      // Existing delta links no longer contain recent history. Do one
      // independent metadata-only backfill, then preserve the live delta.
      if (!cp?.backfillCompletedAt) {
        const backfill =
          cp?.deltaLink != null
            ? (await getTranscriptDelta(user.id)).items
            : items;
        discoveryItems = mergeDiscoveryItems(
          items,
          backfill,
          cp?.deltaLink != null
        );
      }

      for (const t of discoveryItems) {
        try {
          const status = await discoverItem(user, t);
          if (status === "created") result.discovered!++;
          else result.skipped++;
        } catch (err) {
          result.errors.push(`${user.displayName ?? user.id}: ${(err as Error).message}`.slice(0, 180));
        }
      }
      await saveCheckpoint({
        id: user.id,
        organizerId: user.id,
        deltaLink: deltaLink ?? cp?.deltaLink,
        backfillCompletedAt:
          cp?.backfillCompletedAt ??
          (result.errors.length === errorsBefore
            ? new Date().toISOString()
            : undefined),
        lastOkAt: new Date().toISOString(),
        lastError: undefined,
      });
    } catch (err) {
      const msg = (err as Error).message;
      result.errors.push(`${user.displayName ?? user.id}: ${msg}`.slice(0, 180));
      const prior = await getCheckpoint(user.id);
      await saveCheckpoint({
        id: user.id,
        organizerId: user.id,
        deltaLink: prior?.deltaLink,
        backfillCompletedAt: prior?.backfillCompletedAt,
        lastError: msg.slice(0, 300),
      });
    }
  }

  await saveCheckpoint({
    id: "_scan",
    organizerId: "_scan",
    deltaLink: String(nextCursor),
    lastOkAt: new Date().toISOString(),
  });
  await saveHealth({
    id: "latest",
    organizerId: "_system",
    lastRunAt: new Date().toISOString(),
    scanned: result.scanned,
    ingested: result.ingested,
    skipped: result.skipped,
    matched: result.matched,
    discovered: result.discovered,
    errors: result.errors.slice(0, 12),
  });
  void logActivity({
    type: "meeting_discovery",
    agent: "meeting-discovery",
    origin: "meeting_discovery",
    channel: "internal",
    detail: {
      scanned: result.scanned,
      discovered: result.discovered,
      skipped: result.skipped,
      errors: result.errors.length,
    },
  });
  log.info?.(
    `[meeting-discovery] scanned=${result.scanned} discovered=${result.discovered} existing=${result.skipped} errors=${result.errors.length}`
  );
  return result;
}
