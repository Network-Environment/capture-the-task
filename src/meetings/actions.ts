import { overlapScore } from "./match";
import type { MeetingAction, MeetingDoc, TranscriptAvailabilityDoc } from "./types";

const FILLER =
  /\b(action items?|actions|commitments?|committed|due dates?|deadlines?|who owns|owners?|assigned|follow[- ]?ups?|from the meeting|the meeting|what are|what were|what is|tell me|please|about|give me|show me|list)\b/gi;

const TIME_WORD = /^(today|yesterday|last|latest|recent|morning|afternoon|week|the|and|for|from|with|that|this)$/i;

export function actionAskWords(query: string): string[] {
  return query
    .replace(FILLER, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !TIME_WORD.test(word));
}

/** A question that names no meeting, only the request for actions or dates. */
export function isGenericActionAsk(query: string): boolean {
  return actionAskWords(query).length === 0;
}

export function formatMeetingActions(meeting: {
  title: string;
  startAt?: string;
  createdAt?: string;
  actions?: MeetingAction[];
}): string {
  const when = (meeting.startAt ?? meeting.createdAt ?? "").slice(0, 10);
  const heading = when ? `${meeting.title} (${when})` : meeting.title;
  const actions = meeting.actions ?? [];
  if (!actions.length) return `${heading}\nNo action items were captured.`;
  const lines = actions.map((action) => {
    const owner =
      action.ownerName && action.ownerName.toLowerCase() !== "unassigned"
        ? action.ownerName
        : "Unassigned";
    const due = action.due?.trim() ? action.due.trim() : "No date was said";
    return `${action.text} | ${owner} | ${due}`;
  });
  return `${heading}\n${lines.join("\n")}`;
}

function newestMeeting(meetings: MeetingDoc[]): MeetingDoc | undefined {
  return [...meetings].sort((a, b) =>
    (b.startAt ?? b.createdAt ?? "").localeCompare(a.startAt ?? a.createdAt ?? "")
  )[0];
}

export function pickMeetingForActions(query: string, meetings: MeetingDoc[]): MeetingDoc | undefined {
  if (!meetings.length) return undefined;
  if (isGenericActionAsk(query)) return newestMeeting(meetings);
  let best: { meeting: MeetingDoc; score: number } | undefined;
  for (const meeting of meetings) {
    const blob = [meeting.title, meeting.summary, ...(meeting.actions ?? []).map((action) => action.text)]
      .filter(Boolean)
      .join(" ");
    const score = Math.max(overlapScore(query, meeting.title), overlapScore(query, blob));
    if (!best || score > best.score) best = { meeting, score };
  }
  if (!best || best.score < 0.34) return undefined;
  return best.meeting;
}

function newestTranscript(docs: TranscriptAvailabilityDoc[]): TranscriptAvailabilityDoc | undefined {
  return [...docs].sort((a, b) => (b.createdDateTime ?? "").localeCompare(a.createdDateTime ?? ""))[0];
}

export function pickTranscriptForActions(
  query: string,
  docs: TranscriptAvailabilityDoc[]
): TranscriptAvailabilityDoc | undefined {
  const usable = docs.filter((doc) => doc.status !== "skipped_short");
  if (!usable.length) return undefined;
  if (isGenericActionAsk(query)) return newestTranscript(usable);
  let best: { doc: TranscriptAvailabilityDoc; score: number } | undefined;
  for (const doc of usable) {
    const blob = [doc.titleHint, doc.organizerName].filter(Boolean).join(" ");
    const score = overlapScore(query, blob);
    if (!best || score > best.score) best = { doc, score };
  }
  if (!best || best.score < 0.34) return undefined;
  return best.doc;
}
