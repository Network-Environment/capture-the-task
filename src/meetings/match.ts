import type { CommitmentDoc, MeetingAction, MeetingSummary } from "./types";
import { commitmentTtlSeconds } from "./store";
import { resolvePerson } from "../org/resolve";
import type { OrgPerson } from "../org/types";

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

export function overlapScore(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

export function ownerKey(action: Pick<MeetingAction, "ownerId" | "ownerName">): string {
  return (action.ownerId || action.ownerName || "unassigned").toLowerCase().slice(0, 80);
}

/** High-confidence same-work match for an existing open commitment. */
export function findMatch(
  open: CommitmentDoc[],
  action: MeetingAction,
  attendeeKeys: Set<string>,
  personId?: string
): CommitmentDoc | undefined {
  const key = ownerKey(action);
  const candidates = open.filter(
    (c) =>
      (personId && c.personId === personId) ||
      c.ownerKey === key ||
      (personId && c.ownerKey === `person:${personId}`) ||
      (action.ownerName && c.ownerName.toLowerCase() === action.ownerName.toLowerCase())
  );
  let best: CommitmentDoc | undefined;
  let score = 0;
  for (const c of candidates) {
    const s = overlapScore(c.text, action.text);
    if (s > score) {
      score = s;
      best = c;
    }
  }
  if (best && score >= 0.45) return best;

  // Later meeting mentioned the work without restating the owner.
  if (attendeeKeys.size) {
    const fromAttendees = open.filter((c) => attendeeKeys.has(c.ownerKey));
    best = undefined;
    score = 0;
    for (const c of fromAttendees) {
      const s = overlapScore(c.text, action.text);
      if (s > score) {
        score = s;
        best = c;
      }
    }
    if (best && score >= 0.6) return best;
  }
  return undefined;
}

export function applyMatches(
  open: CommitmentDoc[],
  summary: MeetingSummary,
  sourceMeetingId: string,
  sourceTitle: string,
  people: OrgPerson[] = []
): { upserts: CommitmentDoc[]; matched: number } {
  const now = new Date().toISOString();
  const ttl = commitmentTtlSeconds();
  const attendeeKeys = new Set(summary.attendees.map((a) => a.toLowerCase()));
  const upserts: CommitmentDoc[] = [];
  let matched = 0;
  const used = new Set<string>();

  for (const action of summary.actions) {
    const person = resolvePerson(people, action);
    const hit = findMatch(
      open.filter((c) => !used.has(c.id)),
      action,
      attendeeKeys,
      person?.id
    );
    if (hit) {
      used.add(hit.id);
      matched++;
      upserts.push({
        ...hit,
        personId: person?.id ?? hit.personId,
        status: "done",
        updatedAt: now,
        ttl: 14 * 86400,
      });
      continue;
    }
    const key = person ? `person:${person.id}` : ownerKey(action);
    upserts.push({
      id: `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerKey: key,
      ownerName: person?.displayName ?? action.ownerName,
      ownerId: person?.entraId ?? action.ownerId,
      personId: person?.id,
      text: action.text,
      due: action.due,
      status: "open",
      sourceMeetingId,
      sourceTitle,
      createdAt: now,
      updatedAt: now,
      ttl,
    });
  }
  return { upserts, matched };
}

export function orgLessonTexts(summary: MeetingSummary, matched: number): string[] {
  const out: string[] = [];
  if (summary.categories[0]) {
    out.push(`Org meetings often cluster around "${summary.categories[0]}"; watch follow-through there.`);
  }
  const owners = [...new Set(summary.actions.map((a) => a.ownerName))].slice(0, 3);
  if (owners.length) {
    out.push(`Commitments this cycle named: ${owners.join(", ")}.`);
  }
  if (matched > 0) {
    out.push(`${matched} prior commitment(s) were referenced again and marked done.`);
  }
  return out.slice(0, 2);
}
