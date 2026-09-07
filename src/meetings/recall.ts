import { embed } from "../services/router";
import { canViewMeetings, denyMeetings } from "./access";
import { listOpenCommitments, searchMeetings, upsertCommitment } from "./store";
import type { CommitmentDoc } from "./types";

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

export async function recallMeetings(userId: string, query: string, k = 6): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const hits = await searchMeetings(await embed(query), k);
  if (!hits.length) return "No matching meetings in the 90-day index.";
  return hits.map(fmtMeeting).join("\n---\n");
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
  await upsertCommitment({
    ...hit,
    status: "done",
    updatedAt: new Date().toISOString(),
    ttl: 14 * 86400,
  });
  return `Marked done: ${hit.ownerName} — ${hit.text}`;
}
