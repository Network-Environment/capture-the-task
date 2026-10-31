import { embed } from "../services/router";
import { canViewMeetings, denyMeetings } from "./access";
import { formatMeetingActions, isGenericActionAsk, pickMeetingForActions, pickTranscriptForActions } from "./actions";
import { processAvailableTranscript } from "./ingest";
import { listOpenCommitments, searchMeetings, upsertCommitment, claimTranscript, findMeetingByTranscript, listTranscriptAvailability, recentMeetingsWithActions, setTranscriptAvailabilityStatus } from "./store";
import type { CommitmentDoc } from "./types";
import type { ActivityAttribution } from "../services/activityLog";
import { projectCommitment } from "../graph/project";
import { completeWorkByCommitment } from "../work/assign";

function fmtMeeting(m: {
  title: string;
  startAt?: string;
  createdAt?: string;
  organizerName?: string;
  summary?: string;
  decisions?: string[];
  actions?: { ownerName: string; text: string; due?: string }[];
}): string {
  const when = (m.startAt ?? m.createdAt ?? "").slice(0, 10);
  const who = m.organizerName ?? "unknown organizer";
  const decisions = (m.decisions ?? []).slice(0, 4).map((d) => `  decision: ${d}`).join("\n");
  const actions = (m.actions ?? []).slice(0, 6).map((a) => `  action: ${a.ownerName} — ${a.text}${a.due ? ` (${a.due})` : ""}`).join("\n");
  return `[${when}] ${m.title} (${who})\n${m.summary ?? ""}\n${decisions}\n${actions}`.trim();
}

function isOverdue(c: CommitmentDoc, now = Date.now()): boolean {
  if (c.status !== "open" || !c.due) return false;
  const t = Date.parse(c.due);
  return Number.isFinite(t) && t < now;
}

export async function recallMeetings(
  userId: string,
  query: string,
  k = 6,
  attribution: Partial<ActivityAttribution> = {}
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const hits = await searchMeetings(
    await embed(query, { ...attribution, trigger: "meeting_recall" }),
    k
  );
  if (!hits.length) return "No matching meetings in the 90-day index.";
  return hits.map(fmtMeeting).join("\n---\n");
}

export async function answerMeetingActions(
  userId: string,
  query: string,
  attribution: Partial<ActivityAttribution> = {}
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const asked = query.trim();
  if (!asked) return "Say which meeting’s action items you want.";

  if (isGenericActionAsk(asked)) {
    const recent = await recentMeetingsWithActions(1);
    const discovered = pickTranscriptForActions(asked, await listTranscriptAvailability(40));
    const meetingAt = recent[0]?.startAt ?? recent[0]?.createdAt ?? "";
    const transcriptAt = discovered?.createdDateTime ?? "";
    const newerTranscript =
      discovered &&
      discovered.status !== "summarized" &&
      transcriptAt > meetingAt;
    if (recent[0] && !newerTranscript) return formatMeetingActions(recent[0]);
  } else {
    const hits = await searchMeetings(
      await embed(asked, { ...attribution, trigger: "meeting_actions" }),
      8
    );
    const picked = pickMeetingForActions(asked, hits);
    if (picked) return formatMeetingActions(picked);
  }

  const transcript = pickTranscriptForActions(asked, await listTranscriptAvailability(100));
  if (!transcript) return "No matching meeting transcript in the 90-day index.";
  const label = transcript.titleHint?.trim() || "that meeting";
  if (transcript.status === "summarized") {
    const meeting = await findMeetingByTranscript(transcript.transcriptId);
    if (meeting) return formatMeetingActions(meeting);
    return `${label} is summarized, but its action items are not available.`;
  }
  if (transcript.status === "processing") {
    return `${label} is being summarized. Ask again in a few minutes for the action items and due dates.`;
  }

  const claimed = await claimTranscript(transcript, userId);
  if (!claimed) {
    return `${label} is being summarized. Ask again in a few minutes for the action items and due dates.`;
  }
  try {
    const processed = await processAvailableTranscript(claimed);
    if (processed.status === "skipped_short") {
      return `${label} did not have enough speech to extract action items.`;
    }
    const meeting = await findMeetingByTranscript(claimed.transcriptId);
    if (meeting) return formatMeetingActions(meeting);
    if (processed.actions) {
      return formatMeetingActions({ title: processed.title || label, actions: processed.actions });
    }
    return `${label} was summarized, but no action items were captured.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blocked = /403|401|forbidden|authorization|unauthorized/i.test(message);
    await setTranscriptAvailabilityStatus(claimed, blocked ? "queued" : "failed", {
      requestedBy: userId,
      requestedAt: new Date().toISOString(),
      error: message.slice(0, 500),
      ...(blocked ? { availableAt: new Date().toISOString() } : {}),
    });
    if (blocked) {
      return `I found “${label}” and queued its summary. Ask again in a few minutes for the action items and due dates.`;
    }
    return `I found “${label}” but could not summarize it.`;
  }
}

export async function listFollowThrough(userId: string, owner?: string): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const key = owner?.toLowerCase();
  const open = await listOpenCommitments();
  const rows = open
    .filter((c) => !key || c.ownerKey.includes(key) || c.ownerName.toLowerCase().includes(key))
    .sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)));
  if (!rows.length) return "No open commitments.";
  return rows
    .map((c) => {
      const flag = isOverdue(c) ? "OVERDUE" : "open";
      return `${flag} | ${c.ownerName} | ${c.text}${c.due ? ` | due ${c.due}` : ""} | from ${c.sourceTitle}`;
    })
    .join("\n");
}

export async function markCommitmentDone(userId: string, idOrText: string): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const open = await listOpenCommitments();
  const q = idOrText.toLowerCase();
  const hit = open.find((c) => c.id === idOrText || c.text.toLowerCase().includes(q));
  if (!hit) return "No matching open commitment.";
  const completed: CommitmentDoc = {
    ...hit,
    status: "done",
    updatedAt: new Date().toISOString(),
    ttl: 14 * 86400,
  };
  await upsertCommitment(completed);
  const projected = await projectCommitment(completed);
  if (projected.errors.length) {
    console.error("[graph] commitment completion projection failed:", projected.errors);
  }
  await completeWorkByCommitment(hit.id, userId).catch((err) =>
    console.error("[work] complete from commitment failed:", err)
  );
  return `Marked done: ${hit.ownerName} — ${hit.text}`;
}
