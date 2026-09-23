import { canViewMeetings, denyMeetings } from "../meetings/access";
import { upsertCommitment, listOpenCommitments } from "../meetings/store";
import type { CommitmentDoc } from "../meetings/types";
import { projectCommitment } from "../graph/project";
import { listOrgDirectory } from "../org/store";
import { resolvePerson } from "../org/resolve";
import { defaultQueues } from "../org/prefs";
import { commentPlannerNudge, completeDestinations, fanOutWork, notifyOwnerCard, notifyUserText } from "./fanout";
import { findWork, findWorkBySource, getWork, listOpenWork, listOverdueWork, upsertWork } from "./store";
import {
  newWorkId,
  type WorkAssignment,
  type WorkEffort,
  type WorkSource,
} from "./types";

export interface AssignWorkInput {
  owner: string;
  title: string;
  detail?: string;
  due?: string;
  effort?: WorkEffort;
  source?: WorkSource;
  sourceId?: string;
  requesterUserId?: string;
}

export async function assignWork(input: AssignWorkInput): Promise<WorkAssignment> {
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: input.owner, ownerName: input.owner });
  if (!person) throw new Error(`No org person matching "${input.owner}". Add them on /admin/org first.`);

  if (input.sourceId) {
    const existing = await findWorkBySource(input.sourceId);
    if (existing && existing.status !== "done" && existing.status !== "cancelled") return existing;
  }

  const now = new Date().toISOString();
  const draft: WorkAssignment = {
    id: newWorkId(),
    ownerPersonId: person.id,
    entraId: person.entraId,
    title: input.title.trim().slice(0, 200),
    detail: input.detail?.trim().slice(0, 2000) || undefined,
    due: input.due?.slice(0, 10) || undefined,
    effort: input.effort,
    source: input.source ?? "agent",
    sourceId: input.sourceId,
    requesterUserId: input.requesterUserId,
    status: "open",
    destinations: [],
    createdAt: now,
    updatedAt: now,
  };
  await upsertWork(draft);
  return fanOutWork(person, draft);
}

export async function assignFromCommitment(c: CommitmentDoc): Promise<WorkAssignment | undefined> {
  if (c.status !== "open" || !c.personId) return undefined;
  const dir = await listOrgDirectory();
  const person = dir.people.find((p) => p.id === c.personId);
  if (!person) return undefined;
  return assignWork({
    owner: person.entraId || person.displayName,
    title: c.text,
    due: c.due,
    source: "meeting",
    sourceId: c.id,
    requesterUserId: person.entraId,
  });
}

export async function assignWorkForUser(userId: string, input: AssignWorkInput): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  try {
    const work = await assignWork({ ...input, requesterUserId: input.requesterUserId ?? userId });
    const dir = await listOrgDirectory();
    const person = dir.people.find((p) => p.id === work.ownerPersonId);
    const hint = person && !person.executionQueues?.length
      ? " Queues defaulted to Teams — say how they actually work so I can store it on the org record."
      : "";
    const dest = work.destinations
      .map((d) => (d.error ? `${d.kind} (${d.error})` : d.kind))
      .join(", ");
    return `Assigned ${work.id} to ${person?.displayName ?? work.ownerPersonId}: ${work.title}. Destinations: ${dest || "none"}.${hint}`;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function nudgeWork(idOrTitle: string, notice = "Still open"): Promise<string> {
  const work = await resolveOpenWork(idOrTitle);
  if (!work) return "No matching open work item.";
  const dir = await listOrgDirectory();
  const person = dir.people.find((p) => p.id === work.ownerPersonId);
  if (!person) return "Owner is no longer in the org directory.";
  const dest = await notifyOwnerCard(person, work, notice);
  await commentPlannerNudge(work);
  await upsertWork({
    ...work,
    destinations: [...work.destinations.filter((d) => d.kind !== dest.kind), dest],
    updatedAt: new Date().toISOString(),
  });
  return `Nudged ${person.displayName} on ${work.title} via ${dest.kind}${dest.error ? ` (${dest.error})` : ""}.`;
}

export async function completeWork(idOrTitle: string, actorUserId?: string): Promise<string> {
  const work = await resolveOpenWork(idOrTitle);
  if (!work) return "No matching open work item.";
  await completeDestinations(work);
  const done = await upsertWork({
    ...work,
    status: "done",
    updatedAt: new Date().toISOString(),
  });
  if (done.sourceId) {
    await closeLinkedCommitment(done.sourceId);
  }
  if (done.requesterUserId && done.requesterUserId !== actorUserId) {
    await notifyUserText(done.requesterUserId, `Done: ${done.title}`);
  }
  return `Completed ${done.id}: ${done.title}`;
}

export async function completeWorkByCommitment(commitmentId: string, actorUserId: string): Promise<void> {
  const work = await findWorkBySource(commitmentId);
  if (!work || work.status === "done") return;
  await completeDestinations(work);
  await upsertWork({ ...work, status: "done", updatedAt: new Date().toISOString() });
  if (work.requesterUserId && work.requesterUserId !== actorUserId) {
    await notifyUserText(work.requesterUserId, `Done: ${work.title}`);
  }
}

export async function acceptWork(id: string, ownerPersonId?: string): Promise<string> {
  const work = ownerPersonId ? await getWork(id, ownerPersonId) : await findWork(id);
  if (!work) return "Work item not found.";
  if (work.status === "done") return `Already done: ${work.title}`;
  await upsertWork({ ...work, status: "accepted", updatedAt: new Date().toISOString() });
  return `Accepted: ${work.title}`;
}

export async function snoozeWork(id: string, ownerPersonId?: string): Promise<string> {
  const work = ownerPersonId ? await getWork(id, ownerPersonId) : await findWork(id);
  if (!work) return "Work item not found.";
  const base = work.due ? Date.parse(`${work.due.slice(0, 10)}T12:00:00`) : Date.now();
  const next = new Date((Number.isFinite(base) ? base : Date.now()) + 86400_000).toISOString().slice(0, 10);
  await upsertWork({ ...work, due: next, status: "open", updatedAt: new Date().toISOString() });
  return `Snoozed until ${next}: ${work.title}`;
}

export async function handleWorkCardAction(
  action: string,
  workId: string,
  ownerPersonId: string | undefined,
  actorUserId: string
): Promise<string> {
  if (action === "accept") return acceptWork(workId, ownerPersonId);
  if (action === "snooze") return snoozeWork(workId, ownerPersonId);
  if (action === "done") {
    const work = ownerPersonId ? await getWork(workId, ownerPersonId) : await findWork(workId);
    if (!work) return "Work item not found.";
    return completeWork(work.id, actorUserId);
  }
  return "Unknown work action.";
}

export async function nudgeOverdueWork(): Promise<number> {
  const overdue = await listOverdueWork();
  let n = 0;
  for (const w of overdue) {
    try {
      await nudgeWork(w.id, "Overdue");
      n++;
    } catch (err) {
      console.error("[work] overdue nudge failed:", w.id, err);
    }
  }
  return n;
}

async function closeLinkedCommitment(commitmentId: string): Promise<void> {
  const open = await listOpenCommitments();
  const hit = open.find((c) => c.id === commitmentId);
  if (!hit) return;
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
}

async function resolveOpenWork(idOrTitle: string): Promise<WorkAssignment | undefined> {
  const byId = await findWork(idOrTitle);
  if (byId && byId.status !== "done" && byId.status !== "cancelled") return byId;
  const q = idOrTitle.toLowerCase();
  const open = await listOpenWork();
  return open.find((w) => w.title.toLowerCase().includes(q));
}
