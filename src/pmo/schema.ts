import { normalizeOrgName } from "../org/resolve";
import {
  KANBAN_COLUMN_LABELS,
  PMO_FIELD_VALUE_MAX,
  PMO_LABEL_MAX,
  PMO_MAX_COLUMNS,
  PMO_MAX_FIELDS,
  type PmoBoard,
  type PmoSchemaPart,
} from "./types";

export const SCHEMA_REQUIRED_MESSAGE =
  "Ask the user for the board name, columns, and any extra fields in one question. Do not invent a schema.";

export function schemaPartId(label: string, used: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "col";
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n++;
  }
  used.add(id);
  return id;
}

export function parseSchemaParts(
  labels: unknown,
  kind: "column" | "field"
): PmoSchemaPart[] {
  const cap = kind === "column" ? PMO_MAX_COLUMNS : PMO_MAX_FIELDS;
  const raw = Array.isArray(labels) ? labels : labels == null ? [] : [labels];
  const used = new Set<string>();
  const parts: PmoSchemaPart[] = [];
  for (const entry of raw) {
    const label =
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object" && "label" in entry
          ? String((entry as { label: unknown }).label ?? "").trim()
          : "";
    if (!label) continue;
    if (label.length > PMO_LABEL_MAX) {
      throw new Error(`${kind} label exceeds ${PMO_LABEL_MAX} characters.`);
    }
    const existingId =
      entry && typeof entry === "object" && "id" in entry
        ? String((entry as { id: unknown }).id ?? "").trim()
        : "";
    let id: string;
    if (existingId && !used.has(existingId)) {
      used.add(existingId);
      id = existingId;
    } else {
      id = schemaPartId(label, used);
    }
    if (parts.some((part) => normalizeOrgName(part.label) === normalizeOrgName(label))) {
      continue;
    }
    parts.push({ id, label });
    if (parts.length > cap) {
      throw new Error(`A board may have at most ${cap} ${kind === "column" ? "columns" : "extra fields"}.`);
    }
  }
  return parts;
}

export function kanbanColumns(): PmoSchemaPart[] {
  return parseSchemaParts([...KANBAN_COLUMN_LABELS], "column");
}

export function wantsDefaultKanban(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const n = normalizeOrgName(value);
  return n === "kanban" || n === "normal kanban" || n === "default";
}

export function resolveBoardColumns(args: {
  columns?: unknown;
  kanban?: unknown;
}): PmoSchemaPart[] {
  if (wantsDefaultKanban(args.kanban)) return kanbanColumns();
  const columns = parseSchemaParts(args.columns, "column");
  if (!columns.length) throw new Error(SCHEMA_REQUIRED_MESSAGE);
  return columns;
}

export function findColumn(board: PmoBoard, column: string): PmoSchemaPart | undefined {
  const n = normalizeOrgName(column);
  return board.columns.find(
    (part) => part.id === column || normalizeOrgName(part.label) === n
  );
}

export function findField(board: PmoBoard, field: string): PmoSchemaPart | undefined {
  const n = normalizeOrgName(field);
  return board.fields.find(
    (part) => part.id === field || normalizeOrgName(part.label) === n
  );
}

export function isDoneColumn(board: PmoBoard, columnId: string): boolean {
  const col = board.columns.find((part) => part.id === columnId);
  const n = normalizeOrgName(col?.label ?? columnId);
  return n === "done" || n === "complete" || n === "completed" || n === "closed";
}

export function clipFieldValue(value: string): string {
  return value.trim().slice(0, PMO_FIELD_VALUE_MAX);
}

export function normalizeBoardTitle(title: string): string {
  return normalizeOrgName(title);
}

export function ttlRemainingLabel(ttlSeconds?: number, updatedAt?: string): string {
  if (!ttlSeconds || !updatedAt) return "—";
  const ends = Date.parse(updatedAt) + ttlSeconds * 1000;
  if (!Number.isFinite(ends)) return "—";
  const days = Math.max(0, Math.ceil((ends - Date.now()) / 86_400_000));
  return `${days}d`;
}
