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
  getCheckpoint,
  listOpenCommitments,
  meetingExists,
  meetingTtlSeconds,
  renderMeetingMarkdown,
  saveCheckpoint,
  saveHealth,
  upsertCommitment,
  upsertMeeting,
  writeMeetingMarkdown,
} from "./store";
import { summarizeTranscript } from "./summarize";
import type { IngestResult, MeetingDoc } from "./types";
import { capTranscript, isTooShort, parseVtt } from "./vtt";

const ORGANIZERS_PER_RUN = Number(process.env.MEETING_ORGANIZERS_PER_RUN ?? 25);

export function sliceOrganizers<T>(users: T[], start: number, n = ORGANIZERS_PER_RUN): { slice: T[]; next: number } {
  if (!users.length) return { slice: [], next: 0 };
  const i = ((start % users.length) + users.length) % users.length;
  const slice = [...users.slice(i), ...users.slice(0, i)].slice(0, n);
  return { slice, next: (i + slice.length) % users.length };
}

export async function ingestTranscript(
  organizer: { id: string; displayName?: string },
  t: GraphTranscript
): Promise<{ status: "ingested" | "skipped" | "duplicate"; matched: number }> {
  if (await meetingExists(t.id)) return { status: "duplicate", matched: 0 };
  const meetingId = t.meetingId;
  if (!meetingId) return { status: "skipped", matched: 0 };

  const vtt = await downloadVtt(organizer.id, meetingId, t.id);
  const spoken = capTranscript(parseVtt(vtt));
  if (isTooShort(spoken)) return { status: "skipped", matched: 0 };

  const meta = await getMeetingMeta(organizer.id, meetingId);
  const summary = await summarizeTranscript({
    transcript: spoken,
    titleHint: meta?.subject,
    organizerName: organizer.displayName,
  });

  const now = new Date().toISOString();
  const id = t.id.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64) || `mtg-${Date.now()}`;
  const path = `${now.slice(0, 7)}/${id}.md`;
  const ttl = meetingTtlSeconds();
  const embedText = `${summary.title}\n${summary.summary}\n${summary.decisions.join(" ")}\n${summary.actions.map((a) => a.text).join(" ")}`;
  const vector = await embed(embedText);

  const doc: MeetingDoc = {
    id,
    organizerId: organizer.id,
    organizerName: organizer.displayName,
    transcriptId: t.id,
    meetingId,
    startAt: meta?.startDateTime ?? t.createdDateTime,
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

  void logActivity({
    type: "capture",
    agent: "meeting-ingest",
    detail: { transcriptId: t.id, title: summary.title, matched, actions: summary.actions.length },
  });

  return { status: "ingested", matched };
}

export async function runMeetingIngest(log: { info?: (...a: unknown[]) => void } = console): Promise<IngestResult> {
  const result: IngestResult = { scanned: 0, ingested: 0, skipped: 0, matched: 0, errors: [] };
  const users = await listEnabledUsers();
  const cursorDoc = await getCheckpoint("_scan");
  const start = Number(cursorDoc?.deltaLink ?? 0);
  const { slice, next: nextCursor } = sliceOrganizers(users, start);

  for (const user of slice) {
    result.scanned++;
    try {
      const cp = await getCheckpoint(user.id);
      const { items, deltaLink } = await getTranscriptDelta(user.id, cp?.deltaLink);
      for (const t of items) {
        try {
          const { status, matched } = await ingestTranscript(user, t);
          if (status === "ingested") {
            result.ingested++;
            result.matched += matched;
          } else result.skipped++;
        } catch (err) {
          result.errors.push(`${user.displayName ?? user.id}: ${(err as Error).message}`.slice(0, 180));
        }
      }
      await saveCheckpoint({
        id: user.id,
        organizerId: user.id,
        deltaLink: deltaLink ?? cp?.deltaLink,
        lastOkAt: new Date().toISOString(),
        lastError: undefined,
      });
    } catch (err) {
      const msg = (err as Error).message;
      result.errors.push(`${user.displayName ?? user.id}: ${msg}`.slice(0, 180));
      await saveCheckpoint({
        id: user.id,
        organizerId: user.id,
        deltaLink: (await getCheckpoint(user.id))?.deltaLink,
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
    errors: result.errors.slice(0, 12),
  });
  log.info?.(
    `[meeting-ingest] scanned=${result.scanned} ingested=${result.ingested} skipped=${result.skipped} errors=${result.errors.length}`
  );
  return result;
}
