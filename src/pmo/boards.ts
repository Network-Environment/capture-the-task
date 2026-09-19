import { randomUUID } from "node:crypto";
import { canViewMeetings, denyMeetings } from "../meetings/access";
import { listOrgDirectory } from "../org/store";
import { resolvePerson } from "../org/resolve";
import { assignWork, completeWork } from "../work/assign";
import { findWorkBySource } from "../work/store";
import {
  clipFieldValue,
  findColumn,
  findField,
  isDoneColumn,
  kanbanColumns,
  normalizeBoardTitle,
  parseSchemaParts,
  resolveBoardColumns,
  SCHEMA_REQUIRED_MESSAGE,
} from "./schema";
import {
  findOpenBoardByTitle,
  findPmoItem,
  getPmoBoard,
  listPmoBoards as listBoardDocs,
  listPmoItems,
  upsertPmoDoc,
} from "./store";
import {
  PMO_CLOSE_TTL_SECONDS,
  PMO_MAX_COLUMNS,
  PMO_MAX_FIELDS,
  PMO_MAX_ITEMS,
  PMO_PURPOSE_MAX,
  PMO_TITLE_MAX,
  type PmoBoard,
  type PmoBoardStatus,
  type PmoItem,
  type PmoSchemaPart,
} from "./types";

function newBoardId(): string {
  return `brd-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function newItemId(): string {
  return `itm-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

async function requireViewer(userId: string): Promise<string | undefined> {
  if (!canViewMeetings(userId)) return denyMeetings();
  return undefined;
}

export async function resolveBoard(idOrTitle: string): Promise<PmoBoard | undefined> {
  const byId = await getPmoBoard(idOrTitle);
  if (byId) return byId;
  const n = normalizeBoardTitle(idOrTitle);
  const all = await listBoardDocs();
  return (
    all.find((board) => board.status === "open" && normalizeBoardTitle(board.title) === n) ??
    all.find((board) => normalizeBoardTitle(board.title) === n)
  );
}

function itemCounts(board: PmoBoard, items: PmoItem[]): string {
  return board.columns
    .map((col) => `${col.label}: ${items.filter((item) => item.columnId === col.id).length}`)
    .join(", ");
}

export function formatBoard(board: PmoBoard, items: PmoItem[], people: { id: string; displayName: string }[]): string {
  const name = (id?: string) => people.find((p) => p.id === id)?.displayName ?? id ?? "unassigned";
  const extra = (item: PmoItem) =>
    board.fields
      .map((field) => {
        const value = item.fieldValues[field.id];
        return value ? `${field.label}=${value}` : "";
      })
      .filter(Boolean)
      .join("; ");
  const groups = board.columns.map((col) => {
    const rows = items.filter((item) => item.columnId === col.id);
    const lines = rows.length
      ? rows.map((item) => {
          const bits = [
            item.title,
            name(item.ownerPersonId),
            item.due ? `due ${item.due.slice(0, 10)}` : "",
            extra(item),
            item.id,
          ].filter(Boolean);
          return `  - ${bits.join(" · ")}`;
        })
      : ["  (empty)"];
    return `${col.label}\n${lines.join("\n")}`;
  });
  const fields = board.fields.length
    ? ` Extra fields: ${board.fields.map((field) => field.label).join(", ")}.`
    : "";
  return (
    `${board.title} (${board.id}, ${board.status})${board.purpose ? ` — ${board.purpose}` : ""}.` +
    ` Columns: ${board.columns.map((col) => col.label).join(" / ")}.` +
    fields +
    `\n${groups.join("\n")}`
  );
}

export async function openPmoBoard(
  userId: string,
  input: { title?: string; purpose?: string; columns?: unknown; fields?: unknown; kanban?: unknown }
): Promise<string> {
  const denied = await requireViewer(userId);
  if (denied) return denied;
  const title = String(input.title ?? "").trim().slice(0, PMO_TITLE_MAX);
  if (!title) return "A board title is required.";
  const existing = await findOpenBoardByTitle(title);
  if (existing) {
    const items = await listPmoItems(existing.id);
    return `Using existing open board ${existing.id}: ${existing.title}. ${itemCounts(existing, items)}.`;
  }
  let columns: PmoSchemaPart[];
  try {
    columns = resolveBoardColumns({ columns: input.columns, kanban: input.kanban });
  } catch (err) {
    return (err as Error).message;
  }
  const fields = parseSchemaParts(input.fields, "field");
  const now = new Date().toISOString();
  const id = newBoardId();
  const board: PmoBoard = {
    id,
    boardId: id,
    kind: "board",
    title,
    purpose: String(input.purpose ?? "").trim().slice(0, PMO_PURPOSE_MAX),
    status: "open",
    createdBy: userId,
    columns,
    fields,
    createdAt: now,
    updatedAt: now,
  };
  await upsertPmoDoc(board);
  return `Opened board ${board.id}: ${board.title}. Columns: ${board.columns.map((c) => c.label).join(" / ")}.`;
}

export async function listPmoBoardsForUser(
  userId: string,
  status: PmoBoardStatus | "all" = "open"
): Promise<string> {
  const denied = await requireViewer(userId);
  if (denied) return denied;
  const boards =
    status === "all"
      ? await listBoardDocs()
      : await listBoardDocs(status);
  if (!boards.length) return status === "closed" ? "No archived PMO boards." : "No open PMO boards.";
  const lines: string[] = [];
  for (const board of boards) {
    const items = await listPmoItems(board.id);
    lines.push(
      `${board.status === "open" ? "Active" : "Archived"} ${board.id}: ${board.title} — ${itemCounts(board, items)}`
    );
  }
  return lines.join("\n");
}

export async function listPmoBoardForUser(userId: string, idOrTitle: string): Promise<string> {
  const denied = await requireViewer(userId);
  if (denied) return denied;
  const board = await resolveBoard(idOrTitle);
  if (!board) return `No PMO board matching "${idOrTitle}".`;
  const [items, dir] = await Promise.all([listPmoItems(board.id), listOrgDirectory()]);
  return formatBoard(board, items, dir.people);
}

async function resolveOwner(owner?: string): Promise<{ id?: string; error?: string; entraId?: string; name?: string }> {
  if (!owner?.trim()) return {};
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: owner, ownerName: owner });
  if (!person) return { error: `No org person matching "${owner}". Add them on /admin/org first.` };
  return { id: person.id, entraId: person.entraId, name: person.displayName };
}

async function syncWork(
  userId: string,
  board: PmoBoard,
  item: PmoItem,
  previousOwner?: string
): Promise<string[]> {
  const notes: string[] = [];
  const sourceId = item.id;
  if (item.ownerPersonId && previousOwner && previousOwner !== item.ownerPersonId && item.workId) {
    try {
      notes.push(await completeWork(item.workId, userId));
    } catch (err) {
      notes.push(`Could not close prior work: ${(err as Error).message}`);
    }
  }
  if (item.ownerPersonId && isDoneColumn(board, item.columnId) && (item.workId || (await findWorkBySource(sourceId)))) {
    const work = item.workId ?? (await findWorkBySource(sourceId))?.id;
    if (work) {
      try {
        notes.push(await completeWork(work, userId));
      } catch (err) {
        notes.push(`Could not complete work: ${(err as Error).message}`);
      }
    }
    return notes;
  }
  if (!item.ownerPersonId || isDoneColumn(board, item.columnId)) return notes;
  const dir = await listOrgDirectory();
  const person = dir.people.find((p) => p.id === item.ownerPersonId);
  if (!person) return notes;
  if (!person.entraId) {
    notes.push(`${person.displayName} has no Entra id, so queues were not updated.`);
    return notes;
  }
  try {
    const work = await assignWork({
      owner: person.entraId,
      title: item.title,
      detail: item.detail ?? `PMO board ${board.title}`,
      due: item.due,
      source: "agent",
      sourceId,
      requesterUserId: userId,
    });
    if (item.workId !== work.id) {
      item.workId = work.id;
      await upsertPmoDoc(item);
    }
    const dest = work.destinations.map((d) => (d.error ? `${d.kind} (${d.error})` : d.kind)).join(", ");
    notes.push(`Queued via ${dest || "none"} as ${work.id}.`);
  } catch (err) {
    notes.push(`Fan-out skipped: ${(err as Error).message}`);
  }
  return notes;
}

export async function addPmoItem(
  userId: string,
  input: {
    board?: string;
    title?: string;
    detail?: string;
    column?: string;
    owner?: string;
    due?: string;
    fields?: unknown;
  }
): Promise<string> {
  const denied = await requireViewer(userId);
  if (denied) return denied;
  const board = await resolveBoard(String(input.board ?? ""));
  if (!board) return "Name the open board to add this item to.";
  if (board.status !== "open") return `${board.title} is archived.`;
  const items = await listPmoItems(board.id);
  if (items.length >= PMO_MAX_ITEMS) return `This board already has ${PMO_MAX_ITEMS} items.`;
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) return "An item title is required.";
  const column = findColumn(board, String(input.column ?? board.columns[0]?.id ?? ""));
  if (!column) return `Column must be one of: ${board.columns.map((c) => c.label).join(", ")}.`;
  const owner = await resolveOwner(input.owner ? String(input.owner) : undefined);
  if (owner.error) return owner.error;
  const now = new Date().toISOString();
  const item: PmoItem = {
    id: newItemId(),
    boardId: board.id,
    kind: "item",
    title,
    detail: input.detail ? String(input.detail).trim().slice(0, 2000) : undefined,
    columnId: column.id,
    ownerPersonId: owner.id,
    due: input.due ? String(input.due).slice(0, 10) : undefined,
    fieldValues: parseFieldValues(board, input.fields),
    createdAt: now,
    updatedAt: now,
  };
  await upsertPmoDoc(item);
  const notes = await syncWork(userId, board, item);
  return `Added ${item.id} to ${board.title} / ${column.label}.${notes.length ? " " + notes.join(" ") : ""}`;
}

function parseFieldValues(board: PmoBoard, raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = findField(board, key);
    if (!field || value == null) continue;
    const text = clipFieldValue(String(value));
    if (text) out[field.id] = text;
  }
  return out;
}

export async function updatePmoItem(
  userId: string,
  input: {
    board?: string;
    item?: string;
    title?: string;
    detail?: string;
    column?: string;
    owner?: string;
    due?: string;
    fields?: unknown;
  }
): Promise<string> {
  const denied = await requireViewer(userId);
  if (denied) return denied;
  const board = await resolveBoard(String(input.board ?? ""));
  if (!board) return "Name the board that holds this item.";
  if (board.status !== "open") return `${board.title} is archived.`;
  const item = await findPmoItem(board.id, String(input.item ?? ""));
  if (!item) return `No item matching "${input.item ?? ""}" on ${board.title}.`;
  const previousOwner = item.ownerPersonId;
  if (input.title) item.title = String(input.title).trim().slice(0, 200);
  if (input.detail !== undefined) item.detail = String(input.detail).trim().slice(0, 2000) || undefined;
  if (input.column) {
    const column = findColumn(board, String(input.column));
    if (!column) return `Column must be one of: ${board.columns.map((c) => c.label).join(", ")}.`;
    item.columnId = column.id;
  }
  if (input.owner !== undefined) {
    if (!String(input.owner).trim()) {
      item.ownerPersonId = undefined;
    } else {
      const owner = await resolveOwner(String(input.owner));
      if (owner.error) return owner.error;
      item.ownerPersonId = owner.id;
    }
  }
  if (input.due !== undefined) item.due = input.due ? String(input.due).slice(0, 10) : undefined;
  if (input.fields) item.fieldValues = { ...item.fieldValues, ...parseFieldValues(board, input.fields) };
  item.updatedAt = new Date().toISOString();
  await upsertPmoDoc(item);
  const notes = await syncWork(userId, board, item, previousOwner);
  const col = board.columns.find((c) => c.id === item.columnId)?.label ?? item.columnId;
  return `Updated ${item.id} on ${board.title} (${col}).${notes.length ? " " + notes.join(" ") : ""}`;
}

export async function addPmoColumn(
  userId: string,
  input: { board?: string; label?: string; kind?: string }
): Promise<string> {
  const denied = await requireViewer(userId);
  if (denied) return denied;
  const board = await resolveBoard(String(input.board ?? ""));
  if (!board) return "Name the open board to change.";
  if (board.status !== "open") return `${board.title} is archived.`;
  const kind = String(input.kind ?? "column") === "field" ? "field" : "column";
  const added = parseSchemaParts([String(input.label ?? "")], kind);
  if (!added.length) return `A ${kind} label is required.`;
  const part = added[0];
  if (kind === "column") {
    if (board.columns.some((c) => c.id === part.id || normalizeBoardTitle(c.label) === normalizeBoardTitle(part.label))) {
      return `${part.label} is already a column on ${board.title}.`;
    }
    if (board.columns.length >= PMO_MAX_COLUMNS) return `A board may have at most ${PMO_MAX_COLUMNS} columns.`;
    board.columns = [...board.columns, part];
  } else {
    if (board.fields.some((c) => c.id === part.id || normalizeBoardTitle(c.label) === normalizeBoardTitle(part.label))) {
      return `${part.label} is already a field on ${board.title}.`;
    }
    if (board.fields.length >= PMO_MAX_FIELDS) return `A board may have at most ${PMO_MAX_FIELDS} extra fields.`;
    board.fields = [...board.fields, part];
  }
  board.updatedAt = new Date().toISOString();
  await upsertPmoDoc(board);
  return `Added ${kind} "${part.label}" to ${board.title}.`;
}

export async function archivePmoBoard(board: PmoBoard): Promise<PmoBoard> {
  const now = new Date().toISOString();
  const items = await listPmoItems(board.id);
  board.status = "closed";
  board.closedAt = now;
  board.updatedAt = now;
  board.ttl = PMO_CLOSE_TTL_SECONDS;
  await upsertPmoDoc(board);
  for (const item of items) {
    item.ttl = PMO_CLOSE_TTL_SECONDS;
    item.updatedAt = now;
    await upsertPmoDoc(item);
  }
  return board;
}

export async function closePmoBoard(userId: string, idOrTitle: string): Promise<string> {
  const denied = await requireViewer(userId);
  if (denied) return denied;
  const board = await resolveBoard(idOrTitle);
  if (!board) return `No PMO board matching "${idOrTitle}".`;
  if (board.status === "closed") return `${board.title} is already archived.`;
  const archived = await archivePmoBoard(board);
  return `Archived ${archived.id}: ${archived.title}. It remains listed for 90 days.`;
}

export { kanbanColumns, SCHEMA_REQUIRED_MESSAGE };
