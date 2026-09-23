import { createHash, randomUUID } from "node:crypto";
import { cosmosContainer } from "../services/cosmos";
import { parkAction } from "../services/approvals";
import type { AuthorizationContext } from "../services/intent";
import { findWork, upsertWork } from "../work/store";
import type { WorkStatus } from "../work/types";
import { listOpenCommitments, upsertCommitment } from "../meetings/store";
import { getGraphNode, patchGraphNode } from "../graph/store";
import type { GraphNodeStatus } from "../graph/types";
import { getPmoBoard, getPmoItem, upsertPmoDoc } from "../pmo/store";
import { isDoneColumn } from "../pmo/schema";
import { notifyPersonText } from "../work/fanout";
import type { WorkDestination } from "../work/types";
import {
  buildOrgFollowthrough,
  formatOrgFollowthrough,
  managerScopes,
  type OrgFollowthroughSnapshot,
} from "./followthrough";
import { resolvePerson } from "./resolve";
import { listOrgDirectory } from "./store";

export type CheckInStatus =
  | "sent"
  | "undelivered"
  | "responded"
  | "proposed"
  | "completed";

export interface CheckInItemRef {
  source: "work" | "commitment" | "graph" | "pmo";
  id: string;
  title: string;
  due?: string;
  status?: string;
  sourceId?: string;
}

export interface CheckInDoc {
  id: string;
  personId: string;
  userId?: string;
  runId: string;
  kind: "individual";
  status: CheckInStatus;
  items: CheckInItemRef[];
  askedAt: string;
  expiresAt: string;
  snapshotHash: string;
  delivery?: WorkDestination;
  response?: string;
  proposedAt?: string;
  completedAt?: string;
  ttl: number;
}

function checkIns() {
  return cosmosContainer("check-ins");
}

export async function saveCheckIn(doc: CheckInDoc): Promise<CheckInDoc> {
  const { resource } = await checkIns().items.upsert(doc);
  return resource as unknown as CheckInDoc;
}

export async function pendingCheckIn(personId: string): Promise<CheckInDoc | undefined> {
  const { resources } = await checkIns()
    .items.query<CheckInDoc>({
      query:
        "SELECT TOP 1 * FROM c WHERE c.personId = @person AND ARRAY_CONTAINS(@open, c.status) " +
        "AND c.expiresAt > @now ORDER BY c.askedAt DESC",
      parameters: [
        { name: "@person", value: personId },
        { name: "@open", value: ["sent", "responded", "proposed"] },
        { name: "@now", value: new Date().toISOString() },
      ],
    })
    .fetchAll();
  return resources[0];
}

export async function getCheckIn(id: string, personId: string): Promise<CheckInDoc | undefined> {
  try {
    const { resource } = await checkIns().item(id, personId).read<CheckInDoc>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

export async function listRecentCheckIns(limit = 80): Promise<CheckInDoc[]> {
  const { resources } = await checkIns()
    .items.query<CheckInDoc>({
      query: "SELECT TOP @limit * FROM c ORDER BY c.askedAt DESC",
      parameters: [{ name: "@limit", value: Math.max(1, Math.min(200, limit)) }],
    })
    .fetchAll();
  return resources;
}

export async function checkInPromptBlock(userId: string): Promise<string> {
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: userId });
  if (!person) return "";
  const pending = await pendingCheckIn(person.id).catch(() => undefined);
  if (!pending) return "";
  const items = pending.items
    .map((item) => `- ${item.source}:${item.id} ${item.title}${item.due ? ` due ${item.due}` : ""}`)
    .join("\n");
  return (
    `\n\nPending daily check-in ${pending.id} for ${person.displayName}. ` +
    "If this message is a progress reply, call propose_checkin_updates; do not update records directly.\n" +
    items
  );
}

export interface CheckInUpdate {
  source: CheckInItemRef["source"];
  id: string;
  status?: "open" | "accepted" | "blocked" | "done";
  due?: string | null;
  progressNote?: string;
}

export function matchCheckInUpdates(
  checkIn: Pick<CheckInDoc, "items">,
  updates: CheckInUpdate[]
): { matched: CheckInUpdate[]; hasUnknown: boolean } {
  const allowed = new Set(checkIn.items.map((item) => `${item.source}:${item.id}`));
  const matched = updates.filter((update) =>
    allowed.has(`${update.source}:${update.id}`)
  );
  return { matched, hasUnknown: matched.length !== updates.length };
}

export async function proposeCheckInUpdates(
  userId: string,
  input: { checkInId?: string; updates: CheckInUpdate[]; response?: string },
  authorization?: AuthorizationContext
): Promise<string> {
  const { person, checkIn } = await resolveOwnCheckIn(userId, input.checkInId);
  if (!person || !checkIn) return "No pending daily check-in for this user.";
  const { matched: updates, hasUnknown } = matchCheckInUpdates(checkIn, input.updates);
  if (!updates.length) {
    return "I could not match that reply to an item in your pending check-in. Name the item or its short id.";
  }
  if (hasUnknown) {
    return "One or more proposed updates were not on your pending check-in. Please clarify which listed item changed.";
  }
  const summary = updates
    .map((update) => {
      const item = checkIn.items.find(
        (row) => row.source === update.source && row.id === update.id
      );
      const changes = [
        update.status ? `status ${update.status}` : "",
        update.due !== undefined ? `due ${update.due ?? "cleared"}` : "",
        update.progressNote ? `note "${update.progressNote.slice(0, 120)}"` : "",
      ].filter(Boolean);
      return `${item?.title ?? update.id}: ${changes.join(", ")}`;
    })
    .join("; ");
  const pendingId = await parkAction(
    userId,
    "apply_checkin_updates",
    {
      personId: person.id,
      checkInId: checkIn.id,
      updates,
      response: input.response,
    },
    {
      effect: "shared_write",
      reason: "These changes update shared work records.",
      summary: `Daily check-in updates — ${summary}`,
      idempotencyKey: `${checkIn.id}:${snapshotHash(updates)}`,
      authorization,
    }
  );
  await saveCheckIn({
    ...checkIn,
    status: "proposed",
    response: input.response?.slice(0, 2000),
    proposedAt: new Date().toISOString(),
  });
  return `Proposed: ${summary}. Reply approve ${pendingId} to apply, or deny ${pendingId}.`;
}

export async function applyCheckInUpdates(
  userId: string,
  input: {
    personId: string;
    checkInId: string;
    updates: CheckInUpdate[];
    response?: string;
  }
): Promise<string> {
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: userId });
  if (!person || person.id !== input.personId) {
    return "This check-in belongs to another org person.";
  }
  const checkIn = await getCheckIn(input.checkInId, person.id);
  if (!checkIn) return "Check-in not found.";
  const allowed = new Set(checkIn.items.map((item) => `${item.source}:${item.id}`));
  const now = new Date().toISOString();
  const results: string[] = [];
  for (const update of input.updates) {
    if (!allowed.has(`${update.source}:${update.id}`)) {
      results.push(`${update.id}: rejected (not in check-in)`);
      continue;
    }
    try {
      await applyOneUpdate(person.id, userId, update, now);
      results.push(`${update.id}: updated`);
    } catch (err) {
      results.push(`${update.id}: ${(err as Error).message}`);
    }
  }
  await saveCheckIn({
    ...checkIn,
    status: "completed",
    response: input.response?.slice(0, 2000) ?? checkIn.response,
    completedAt: now,
  });
  return `Applied daily check-in updates: ${results.join("; ")}.`;
}

async function resolveOwnCheckIn(
  userId: string,
  checkInId?: string
): Promise<{ person?: Awaited<ReturnType<typeof listOrgDirectory>>["people"][number]; checkIn?: CheckInDoc }> {
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: userId });
  if (!person) return {};
  const checkIn = checkInId
    ? await getCheckIn(checkInId, person.id)
    : await pendingCheckIn(person.id);
  return { person, checkIn };
}

async function applyOneUpdate(
  personId: string,
  actorUserId: string,
  update: CheckInUpdate,
  now: string
): Promise<void> {
  if (update.source === "work") {
    const work = await findWork(update.id);
    if (!work || work.ownerPersonId !== personId) throw new Error("work item not found");
    await upsertWork({
      ...work,
      status: (update.status ?? work.status) as WorkStatus,
      due: update.due === undefined ? work.due : update.due ?? undefined,
      progressNote: update.progressNote?.slice(0, 500) ?? work.progressNote,
      lastProgressAt: now,
      updatedAt: now,
    });
    return;
  }
  if (update.source === "commitment") {
    const commitment = (await listOpenCommitments()).find(
      (row) => row.id === update.id && row.personId === personId
    );
    if (!commitment) throw new Error("commitment not found");
    await upsertCommitment({
      ...commitment,
      status: update.status === "done" ? "done" : commitment.status,
      due: update.due === undefined ? commitment.due : update.due ?? undefined,
      progressNote: update.progressNote?.slice(0, 500) ?? commitment.progressNote,
      lastProgressAt: now,
      updatedAt: now,
      ...(update.status === "done" ? { ttl: 14 * 86400 } : {}),
    });
    return;
  }
  if (update.source === "graph") {
    const node = await getGraphNode(update.id, actorUserId);
    if (!node || node.ownerPersonId !== personId) throw new Error("graph item not found");
    if (node.source && node.source.kind !== "graph") {
      throw new Error(`projected graph item must be updated at its ${node.source.kind} source`);
    }
    await patchGraphNode(
      node.id,
      {
        status: (update.status ?? node.status) as GraphNodeStatus,
        due: update.due,
        progressNote: update.progressNote?.slice(0, 500),
        lastProgressAt: now,
      },
      actorUserId,
      node.version
    );
    return;
  }
  const checkIn = await pendingCheckIn(personId);
  const ref = checkIn?.items.find((item) => item.source === "pmo" && item.id === update.id);
  if (!ref?.sourceId) throw new Error("PMO board reference missing");
  const [board, item] = await Promise.all([
    getPmoBoard(ref.sourceId),
    getPmoItem(update.id, ref.sourceId),
  ]);
  if (!board || !item || item.ownerPersonId !== personId) throw new Error("PMO item not found");
  let columnId = item.columnId;
  if (update.status === "done") {
    columnId =
      board.columns.find((column) =>
        ["done", "complete", "completed", "closed"].includes(column.label.trim().toLowerCase())
      )?.id ?? columnId;
    if (!isDoneColumn(board, columnId)) throw new Error("board has no done column");
  } else if (update.status === "blocked") {
    columnId =
      board.columns.find((column) => column.label.trim().toLowerCase() === "blocked")?.id ??
      columnId;
  }
  await upsertPmoDoc({
    ...item,
    columnId,
    due: update.due === undefined ? item.due : update.due ?? undefined,
    progressNote: update.progressNote?.slice(0, 500) ?? item.progressNote,
    lastProgressAt: now,
    updatedAt: now,
  });
}

export interface BriefingScope {
  team?: string;
  manager?: string;
}

export async function sendFollowthroughBriefings(
  requesterUserId: string,
  input: BriefingScope = {}
): Promise<string> {
  const dir = await listOrgDirectory();
  let scope:
    | { kind: "all" }
    | { kind: "team"; unitId: string }
    | { kind: "manager"; managerPersonId: string } = { kind: "all" };
  if (input.team) {
    const q = input.team.trim().toLowerCase();
    const unit = dir.units.find(
      (row) => row.status === "active" && (row.id === input.team || row.name.toLowerCase() === q)
    );
    if (!unit) return `No org team matching "${input.team}".`;
    scope = { kind: "team", unitId: unit.id };
  } else if (input.manager) {
    const manager = resolvePerson(dir.people, {
      ownerId: input.manager,
      ownerName: input.manager,
    });
    if (!manager) return `No org person matching "${input.manager}".`;
    scope = { kind: "manager", managerPersonId: manager.id };
  }
  const snapshot = await buildOrgFollowthrough(dir, scope);
  const runId = `cir-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 36 * 3600_000).toISOString();
  const failures: string[] = [];
  let sent = 0;

  for (const row of snapshot.people) {
    const priority = row.risks.map((risk) => risk.item);
    const chosen = (priority.length ? priority : row.workload.items).slice(0, 8);
    const refs: CheckInItemRef[] = chosen.map((item) => ({
      source: item.source,
      id: item.id,
      title: item.title,
      due: item.due,
      status: item.status,
      sourceId: item.sourceId,
    }));
    const body = individualBrief(row, refs);
    const delivery = await notifyPersonText(row.person, body);
    const status: CheckInStatus = delivery.error ? "undelivered" : "sent";
    if (delivery.error) failures.push(`${row.person.displayName}: ${delivery.error}`);
    else sent++;
    await saveCheckIn({
      id: `${runId}-${row.person.id}`,
      personId: row.person.id,
      userId: row.person.entraId,
      runId,
      kind: "individual",
      status,
      items: refs,
      askedAt: now.toISOString(),
      expiresAt,
      snapshotHash: snapshotHash(refs),
      delivery,
      ttl: 30 * 86400,
    });
  }

  const scopedIds = new Set(snapshot.people.map((row) => row.person.id));
  for (const manager of managerScopes(dir).filter((row) => scopedIds.has(row.id))) {
    const report: OrgFollowthroughSnapshot = {
      generatedAt: snapshot.generatedAt,
      people: snapshot.people.filter(
        (row) =>
          row.person.id === manager.id ||
          row.person.managerPersonId === manager.id
      ),
    };
    const delivery = await notifyPersonText(
      manager,
      `Daily manager follow-through — you and your direct reports\n\n${formatOrgFollowthrough(report)}`
    );
    if (delivery.error) failures.push(`${manager.displayName} manager report: ${delivery.error}`);
  }

  const failureText = failures.length ? ` Delivery issues: ${failures.join("; ")}.` : "";
  return `Daily follow-through run ${runId}: ${sent}/${snapshot.people.length} individual asks delivered.${failureText} Requested by ${requesterUserId}.`;
}

function individualBrief(
  row: OrgFollowthroughSnapshot["people"][number],
  items: CheckInItemRef[]
): string {
  const risk = row.risks.length
    ? row.risks
        .slice(0, 6)
        .map(
          (entry) =>
            `- [${entry.risks.join("+")}] ${entry.item.title}${entry.item.due ? ` (due ${entry.item.due.slice(0, 10)})` : ""}`
        )
        .join("\n")
    : items.length
      ? items.map((item) => `- ${item.title}${item.due ? ` (due ${item.due.slice(0, 10)})` : ""}`).join("\n")
      : "- Nothing open on your TaskBrain plate.";
  return (
    `Daily TaskBrain check-in for ${row.person.displayName}\n\n${risk}\n\n` +
    "Reply with what changed, what is blocked, what is done, or a new due date. " +
    "TaskBrain will show proposed record updates for your confirmation."
  );
}

function snapshotHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}
