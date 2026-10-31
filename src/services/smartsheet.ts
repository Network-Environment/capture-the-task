/**
 * Smartsheet is the live PMO system of record. This module never copies sheet
 * rows into Cosmos. It only: (1) injects a tiny alias catalog into the pmo
 * prompt, (2) decides when a message is PMO vs personal-note recall, (3)
 * after a captured task, proposes a parked update_rows on a high-confidence
 * existing row. Writes always go through approvals (confirmTools).
 */
import { loadConfig } from "../config";
import { overlapScore } from "../meetings/match";
import { callMcpTool } from "../tools/mcpClient";
import { parkAction } from "./approvals";
import type { AuthorizationContext } from "./intent";

export interface SheetCatalogEntry {
  alias: string;
  sheetId?: string;
  workspaceId?: string;
  purpose?: string;
}

interface SmartsheetConfig {
  sheets?: SheetCatalogEntry[];
}

const cfg = loadConfig<SmartsheetConfig>("smartsheet");

export function catalogSheets(): SheetCatalogEntry[] {
  return (cfg.sheets ?? []).filter((s) => s.alias);
}

export function catalogPromptBlock(): string {
  const sheets = catalogSheets();
  if (!sheets.length) {
    return (
      "\n\nKnown Smartsheet catalog: none configured. Search by the user's words " +
      "with smartsheet__search and smartsheet__get_sheet_summary. Use the closest sheet, row, and column. Never invent sheet IDs."
    );
  }
  const lines = sheets.map((s) => {
    const id = s.sheetId ? ` sheetId=${s.sheetId}` : "";
    const ws = s.workspaceId ? ` workspaceId=${s.workspaceId}` : "";
    const purpose = s.purpose ? ` — ${s.purpose}` : "";
    return `- "${s.alias}"${id}${ws}${purpose}`;
  });
  return (
    "\n\nKnown Smartsheet catalog (closest sheet name is enough; use an id when it matches, otherwise search):\n" +
    lines.join("\n")
  );
}

const EPHEMERAL_BOARD_RE =
  /\b(?:taskbrain|ephemeral|eph|internal|local)\s+(?:pmo\s+)?(?:board|card)\b|\b(?:open|create|add to|update|close|list)\s+(?:the\s+|an?\s+)?(?:pmo\s+)?(?:board|card)\b/i;
const SMARTSHEET_RE =
  /\b(smartsheet|smartsheet\.com|sheet id|sheet url|sheet permalink|risk register|project tracker|workspace|update the row|add a row)\b/i;

export function isPmoRequest(text: string): boolean {
  if (EPHEMERAL_BOARD_RE.test(text)) return false;
  if (SMARTSHEET_RE.test(text)) return true;
  const lower = text.toLowerCase();
  return catalogSheets().some((s) => s.alias && lower.includes(s.alias.toLowerCase()));
}

/** Personal-note recall vs live PMO/tools. */
export function agentProfileFor(kind: "action" | string, text: string): string | undefined {
  if (kind !== "action") return undefined;
  return isPmoRequest(text) ? "pmo" : undefined;
}

export interface SheetColumn {
  id?: number;
  index?: number;
  title: string;
  type?: string;
  options: string[];
}

export interface SheetRowHit {
  sheetId: string;
  sheetName: string;
  rowId: string;
  text: string;
  primaryText?: string;
  owner?: string;
  columns?: SheetColumn[];
  statusColumnId?: number;
  dueColumnId?: number;
  notesColumnId?: number;
}

export interface SheetChange {
  status?: string;
  due?: string;
  note?: string;
  column?: string;
  value?: string;
}

/** Below this, the closest name is still an unrelated row and must not be written. */
export const CLOSEST_FLOOR = 0.34;

export function nameScore(query: string, candidate: string): number {
  const base = overlapScore(query, candidate);
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2);
  const leftWords = words(query);
  const rightWords = words(candidate);
  let prefixHits = 0;
  for (const word of leftWords) {
    if (rightWords.some((token) => token.startsWith(word) || word.startsWith(token))) prefixHits++;
  }
  const prefix = leftWords.length ? prefixHits / leftWords.length : 0;
  const left = query.trim().toLowerCase();
  const right = candidate.trim().toLowerCase();
  const contains =
    left.length > 2 && right.length > 2 && (right.includes(left) || left.includes(right)) ? 1 : 0;
  return Math.max(base, prefix, contains);
}

export function pickBestRow(
  title: string,
  rows: SheetRowHit[],
  owner?: string
): { row: SheetRowHit; score: number } | undefined {
  let best: { row: SheetRowHit; score: number } | undefined;
  for (const row of rows) {
    const primary = row.primaryText || row.text;
    let score = Math.max(nameScore(title, primary), nameScore(title, row.text));
    if (owner && row.owner && owner.toLowerCase() === row.owner.toLowerCase()) score += 0.15;
    if (!best || score > best.score) best = { row, score };
  }
  if (!best || best.score < CLOSEST_FLOOR) return undefined;
  return best;
}

function columnNameLooksLike(name: string, needles: string[]): boolean {
  const n = name.toLowerCase();
  return needles.some((x) => n.includes(x));
}

export function inferCellUpdates(
  hit: SheetRowHit,
  task: { title: string; detail?: string; due?: string }
): { columnId: number; value: string }[] {
  const cells: { columnId: number; value: string }[] = [];
  const blob = `${task.title} ${task.detail ?? ""}`.toLowerCase();
  if (hit.dueColumnId && task.due) cells.push({ columnId: hit.dueColumnId, value: task.due });
  if (hit.statusColumnId && /\b(done|complete|closed|mitigated|resolved)\b/.test(blob)) {
    cells.push({ columnId: hit.statusColumnId, value: "Complete" });
  }
  if (hit.notesColumnId) {
    cells.push({
      columnId: hit.notesColumnId,
      value: `TaskBrain captured: ${task.title} (${new Date().toISOString().slice(0, 10)})`,
    });
  }
  return cells;
}

export function formatWriteApproval(tool: string, args: Record<string, unknown>): string {
  const action = tool.endsWith("add_rows") ? "Add row(s)" : tool.endsWith("update_rows") ? "Update row(s)" : tool;
  const display = asRecord(args._display);
  if (display) {
    const sheetName = String(display.sheetName ?? "Smartsheet");
    const rowLabel = String(display.rowLabel ?? "").trim();
    const changes = (Array.isArray(display.changes) ? display.changes : [])
      .slice(0, 6)
      .flatMap((item) => {
        const change = asRecord(item);
        if (!change) return [];
        const column = String(change.column ?? "").trim();
        const value = String(change.value ?? "").trim();
        return column ? [`${column}: ${value.slice(0, 120)}`] : [];
      });
    return `**${action}** on ${sheetName}${rowLabel ? `\n${rowLabel}` : ""}${changes.length ? `\n${changes.join("\n")}` : ""}`;
  }
  const sheetId = String(args.sheetId ?? args.sheet_id ?? "");
  const sheetName = catalogSheets().find((s) => s.sheetId && s.sheetId === sheetId)?.alias;
  const rows = (Array.isArray(args.rows) ? args.rows : []) as Record<string, unknown>[];
  const rowBits = rows.slice(0, 4).map((r) => {
    const id = r.id ?? r.rowId ?? "?";
    const cells = Array.isArray(r.cells) ? (r.cells as { columnId?: unknown; value?: unknown; title?: unknown }[]) : [];
    const changes = cells
      .map((c) => `${c.title ? String(c.title) : `col ${c.columnId}`}: ${String(c.value ?? "").slice(0, 80)}`)
      .join("; ");
    return `row ${id}${changes ? ` → ${changes}` : ""}`;
  });
  const where = sheetName ? `${sheetName} (${sheetId || "no id"})` : sheetId || "sheet unspecified";
  const body = rowBits.length ? rowBits.join("\n") : JSON.stringify(args).slice(0, 400);
  return `**${action}** on ${where}\n${body}`;
}

export function approvalMessage(id: string, tool: string, args: Record<string, unknown>): string {
  const detail = tool.startsWith("smartsheet__")
    ? formatWriteApproval(tool, args)
    : readableChange(args);
  return (
    `This change is waiting for you.\n${detail}\n\n` +
    `Reply **approve ${id}** or **deny ${id}** (expires in 1 hour).`
  );
}

function readableChange(args: Record<string, unknown>): string {
  const lines = Object.entries(args)
    .filter(([key, value]) => key !== "authorization" && value != null && typeof value !== "object")
    .slice(0, 6)
    .map(([key, value]) => `${key.replaceAll("_", " ")}: ${String(value).slice(0, 160)}`);
  return lines.length ? lines.join("\n") : "Shared records will be updated.";
}

interface ParsedSearchHit {
  sheetId?: string;
  rowId?: string;
  text: string;
  objectType?: string;
}

export function parseSearchHits(raw: string): ParsedSearchHit[] {
  const out: ParsedSearchHit[] = [];
  const pushObj = (o: Record<string, unknown>) => {
    const text = String(o.text ?? o.title ?? o.name ?? o.objectName ?? "").trim();
    const sheetId = o.sheetId ?? o.parentObjectId ?? o.containerId;
    const rowId = o.objectId ?? o.rowId ?? o.id;
    const objectType = String(o.objectType ?? o.type ?? "");
    if (text || sheetId || rowId) {
      out.push({
        text,
        sheetId: sheetId != null ? String(sheetId) : undefined,
        rowId: rowId != null ? String(rowId) : undefined,
        objectType,
      });
    }
  };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown[] }).results)
        ? (parsed as { results: unknown[] }).results
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown[] }).items)
          ? (parsed as { items: unknown[] }).items
          : [];
    for (const item of list) {
      if (item && typeof item === "object") pushObj(item as Record<string, unknown>);
    }
    if (out.length) return out;
  } catch {
    /* fall through to regex */
  }
  const idRe = /(?:sheetId|parentObjectId)["'\s:=]+(\d{8,})/gi;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(raw))) out.push({ text: raw.slice(Math.max(0, m.index - 80), m.index + 120), sheetId: m[1] });
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function columnTitle(col: Record<string, unknown>): string {
  return String(col.title ?? col.name ?? col.columnName ?? "");
}

function columnId(col: Record<string, unknown>): number | undefined {
  const n = Number(col.id ?? col.columnId);
  return Number.isFinite(n) ? n : undefined;
}

function rowIdOf(row: Record<string, unknown>): string {
  return String(row.row_id ?? row.rowId ?? row.id ?? "");
}

function cellsOf(row: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(row.cells)) {
    return row.cells.filter((c) => c && typeof c === "object") as Record<string, unknown>[];
  }
  const map = asRecord(row.cells) ?? asRecord(row.values) ?? asRecord(row.data);
  if (!map) return [];
  return Object.entries(map).map(([title, value]) => ({ title, displayValue: value, value }));
}

function cellText(cell: Record<string, unknown>): string {
  return String(cell.displayValue ?? cell.value ?? cell.title ?? "").trim();
}

function columnOptions(col: Record<string, unknown>): string[] {
  const raw = col.options ?? col.picklist ?? col.enum;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((option) => {
      if (typeof option === "string") return option.trim();
      const record = asRecord(option);
      return String(record?.label ?? record?.value ?? record?.name ?? "").trim();
    })
    .filter(Boolean);
}

function sheetColumnFromRecord(col: Record<string, unknown>): SheetColumn {
  return {
    id: columnId(col),
    index: Number.isFinite(Number(col.index)) ? Number(col.index) : undefined,
    title: columnTitle(col),
    type: col.type ? String(col.type) : undefined,
    options: columnOptions(col),
  };
}

const PRIMARY_TITLES = ["task", "project", "initiative", "name", "item", "risk", "workstream"];

function primaryColumn(columns: SheetColumn[]): SheetColumn | undefined {
  for (const needle of PRIMARY_TITLES) {
    const hit = columns.find((column) => column.title.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return columns[0];
}

function decorateHit(
  hit: SheetRowHit,
  columns: SheetColumn[],
  cells: { title: string; value: string }[]
): SheetRowHit {
  const primary = primaryColumn(columns);
  const primaryValue = primary
    ? cells.find((cell) => cell.title.toLowerCase() === primary.title.toLowerCase())?.value
    : undefined;
  const status = columns.find((column) => columnNameLooksLike(column.title, ["status", "state", "phase", "stage"]));
  const due = columns.find(
    (column) =>
      columnNameLooksLike(column.title, ["due", "finish", "deadline", "date"]) &&
      !/start|begin/i.test(column.title)
  );
  const notes = columns.find((column) =>
    columnNameLooksLike(column.title, ["note", "comment", "update", "remark"])
  );
  return {
    ...hit,
    primaryText: primaryValue || hit.text,
    columns,
    statusColumnId: status?.id ?? hit.statusColumnId,
    dueColumnId: due?.id ?? hit.dueColumnId,
    notesColumnId: notes?.id ?? hit.notesColumnId,
  };
}

/**
 * Smartsheet MCP currently renders get_sheet_summary as a compact YAML-like
 * table rather than JSON. Keep this parser deliberately narrow to that public
 * contract and fall back to the JSON parser for older servers.
 */
function parseTextColumns(raw: string): SheetColumn[] {
  const blocks = raw.split(/^\s*-\s+index:\s*/m).slice(1);
  const columns: SheetColumn[] = [];
  for (const block of blocks) {
    const index = Number(block.match(/^(\d+)/)?.[1]);
    if (!Number.isFinite(index)) continue;
    const title = block.match(/\btitle:\s*(.+)/)?.[1]?.trim() ?? "";
    if (!title) continue;
    const id = block.match(/\bid:\s*(\d+)/)?.[1];
    const type = block.match(/\btype:\s*(\S+)/)?.[1];
    const optionLine = block.match(/\boptions:\s*(.+)/)?.[1];
    const options = optionLine
      ? optionLine.split(/[,|]/).map((option) => option.trim()).filter(Boolean)
      : [];
    columns.push({
      index,
      id: id ? Number(id) : undefined,
      title,
      type,
      options,
    });
  }
  return columns;
}

function parseTextSheetSummary(
  raw: string,
  fallbackSheetId: string,
  fallbackSheetName: string
): SheetRowHit[] {
  const sheetId = raw.match(/^sheet_id:\s*(\d+)/m)?.[1] ?? fallbackSheetId;
  const sheetName = raw.match(/^sheet_name:\s*(.+)$/m)?.[1]?.trim() ?? fallbackSheetName;
  const rowsStart = raw.search(/^rows\[\d+/m);
  if (rowsStart < 0) return [];
  const columns = parseTextColumns(raw.slice(0, rowsStart));
  const byIndex = new Map(columns.map((column) => [column.index, column]));
  const rowText = raw.slice(rowsStart);
  const rowRe = /^\s*-\s+row_id:\s*(\d+)([\s\S]*?)(?=^\s*-\s+row_id:|$(?![\s\S]))/gm;
  const hits: SheetRowHit[] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(rowText))) {
    const cells: { title: string; value: string }[] = [];
    let owner: string | undefined;
    const cellRe = /^\s+(\d+)\t(.+)$/gm;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[2]))) {
      const index = Number(cellMatch[1]);
      const value = cellMatch[2].trim();
      if (!value) continue;
      const title = byIndex.get(index)?.title ?? `column ${index}`;
      cells.push({ title, value });
      if (columnNameLooksLike(title, ["owner", "assigned", "raci"])) owner = value;
    }
    hits.push(
      decorateHit(
        {
          sheetId,
          sheetName,
          rowId: rowMatch[1],
          text: cells.map((cell) => `${cell.title}: ${cell.value}`).join(" "),
          owner,
        },
        columns,
        cells
      )
    );
  }
  return hits;
}

export function parseSheetForRows(raw: string, sheetId: string, sheetName: string): SheetRowHit[] {
  const textRows = parseTextSheetSummary(raw, sheetId, sheetName);
  if (textRows.length) return textRows;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const root = asRecord(parsed) ?? {};
    const inner = asRecord(root.data) ?? asRecord(root.sheet) ?? root;
    const cols = (
      (Array.isArray(inner.columns) ? inner.columns : undefined) ??
      (Array.isArray(inner.available_columns) ? inner.available_columns : undefined) ??
      (Array.isArray(inner.availableColumns) ? inner.availableColumns : [])
    ).flatMap((c) => (asRecord(c) ? [asRecord(c)!] : []));
    const columns = cols.map(sheetColumnFromRecord);
    const ownerCol = cols.find((c) =>
      columnNameLooksLike(columnTitle(c), ["owner", "assigned", "raci"])
    );
    const rowsRaw = Array.isArray(inner.rows) ? inner.rows : [];
    const hits: SheetRowHit[] = [];
    for (const item of rowsRaw) {
      const row = asRecord(item);
      if (!row) continue;
      const cells = cellsOf(row);
      const titled = cells
        .map((cell) => ({
          title: String(cell.title ?? cell.columnTitle ?? ""),
          value: cellText(cell),
        }))
        .filter((cell) => cell.value);
      const text = titled.map((cell) => `${cell.title}: ${cell.value}`).filter(Boolean).join(" ");
      const ownerCell = ownerCol
        ? cells.find((c) => Number(c.columnId) === columnId(ownerCol)) ??
          cells.find((c) => columnNameLooksLike(String(c.title ?? ""), [columnTitle(ownerCol).toLowerCase()]))
        : undefined;
      const id = rowIdOf(row);
      if (!id && !text) continue;
      hits.push(
        decorateHit(
          {
            sheetId: String(inner.sheet_id ?? inner.sheetId ?? inner.id ?? sheetId),
            sheetName: String(inner.name ?? inner.sheet_name ?? inner.sheetName ?? sheetName),
            rowId: id || String(hits.length),
            text,
            owner: ownerCell ? cellText(ownerCell) : undefined,
          },
          columns,
          titled
        )
      );
    }
    return hits;
  } catch {
    return [];
  }
}

function titleHas(title: string, needle: string): boolean {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const needleWords = needle.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return needleWords.every((word) => words.some((token) => token === word || token.startsWith(word)));
}

const COLUMN_FAMILIES: { words: RegExp; titles: string[] }[] = [
  {
    words: /\b(done|complete|completed|closed|mitigated|resolved|status|state|phase|stage)\b/i,
    titles: ["status", "state", "phase", "stage", "progress"],
  },
  {
    words: /\b(due|date|finish|deadline|push|target|end)\b/i,
    titles: ["due", "finish", "deadline", "end date", "target date", "date", "end", "target"],
  },
  {
    words: /\b(note|notes|comment|comments|remark|remarks)\b/i,
    titles: ["note", "comment", "remark", "update"],
  },
];

export function looseSearchQuery(text: string): string {
  return text
    .replace(/["“”]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter((word) => word.length > 2 && !/^(the|and|for|with|from|that|this|row|sheet)$/i.test(word))
    .slice(0, 8)
    .join(" ");
}

export function parseColumns(raw: string): SheetColumn[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const root = asRecord(parsed) ?? {};
      const inner = asRecord(root.data) ?? root;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(inner.columns)
          ? inner.columns
          : Array.isArray(inner.available_columns)
            ? inner.available_columns
            : Array.isArray(inner.availableColumns)
              ? inner.availableColumns
              : [];
      const columns = list.flatMap((item) => (asRecord(item) ? [sheetColumnFromRecord(asRecord(item)!)] : []));
      if (columns.length) return columns.filter((column) => column.title);
    } catch {
      /* text format below */
    }
  }
  return parseTextColumns(raw);
}

export function mergeColumns(summary: SheetColumn[], live: SheetColumn[]): SheetColumn[] {
  if (!live.length) return summary;
  return live.map((column) => {
    const prior = summary.find((item) => item.title.toLowerCase() === column.title.toLowerCase());
    return {
      ...prior,
      ...column,
      options: column.options.length ? column.options : prior?.options ?? [],
    };
  });
}

export function pickColumn(
  hint: string,
  columns: SheetColumn[]
): { column: SheetColumn; score: number } | undefined {
  const dueLike = /\b(due|date|finish|deadline|push|target)\b/i.test(hint) && !/\bstart\b/i.test(hint);
  let best: { column: SheetColumn; score: number } | undefined;
  for (const column of columns) {
    const title = column.title.toLowerCase();
    let score = nameScore(hint, column.title);
    for (const family of COLUMN_FAMILIES) {
      if (family.words.test(hint) && family.titles.some((needle) => titleHas(title, needle))) {
        score = Math.max(score, 0.8);
      }
    }
    if (dueLike && /\bstart|begin\b/.test(title) && !/\b(due|finish|deadline|end|target)\b/.test(title)) {
      score -= 0.15;
    }
    if (!best || score > best.score) best = { column, score };
  }
  if (!best || best.score < CLOSEST_FLOOR) return undefined;
  return best;
}

export function columnWriteValue(requested: string, column: SheetColumn): string {
  if (column.options.length) {
    let bestOption: { option: string; score: number } | undefined;
    for (const option of column.options) {
      const score = nameScore(requested, option);
      if (!bestOption || score > bestOption.score) bestOption = { option, score };
    }
    if (bestOption && bestOption.score >= CLOSEST_FLOOR) return bestOption.option;
    if (/\b(done|complete|completed|closed)\b/i.test(requested)) {
      const done = column.options.find((option) => /complete|done|closed/i.test(option));
      if (done) return done;
    }
  }
  if (
    /\b(done|complete|completed|closed|mitigated|resolved)\b/i.test(requested) &&
    /status|state|phase|stage/i.test(column.title)
  ) {
    return "Complete";
  }
  return requested.trim();
}

export type SheetUpdateChoice =
  | {
      ok: true;
      row: SheetRowHit;
      cells: { columnId: number; value: string }[];
      display: { sheetName: string; rowLabel: string; changes: { column: string; value: string }[] };
      args: Record<string, unknown>;
    }
  | { ok: false; reason: string; row?: SheetRowHit };

function pushCell(
  column: SheetColumn | undefined,
  value: string,
  cells: { columnId: number; value: string }[],
  changes: { column: string; value: string }[],
  missed: string[]
): void {
  if (!column) {
    missed.push(value);
    return;
  }
  if (column.id == null) {
    missed.push(column.title);
    return;
  }
  const written = columnWriteValue(value, column);
  cells.push({ columnId: column.id, value: written });
  changes.push({ column: column.title, value: written });
}

export function chooseSheetUpdate(
  query: string,
  rows: SheetRowHit[],
  columns: SheetColumn[],
  change: SheetChange,
  sheetHint?: string
): SheetUpdateChoice {
  let pool = rows;
  if (sheetHint?.trim()) {
    const names = [...new Set(rows.map((row) => row.sheetName).filter(Boolean))];
    let bestName: { name: string; score: number } | undefined;
    for (const name of names) {
      const score = nameScore(sheetHint, name);
      if (!bestName || score > bestName.score) bestName = { name, score };
    }
    if (!bestName || bestName.score < CLOSEST_FLOOR) {
      return { ok: false, reason: `No sheet resembles “${sheetHint.trim()}”.` };
    }
    pool = rows.filter((row) => row.sheetName === bestName?.name);
  }
  const best = pickBestRow(query, pool);
  if (!best) return { ok: false, reason: `No row resembles “${query.trim()}”.` };
  const cols = columns.length ? columns : best.row.columns ?? [];
  const cells: { columnId: number; value: string }[] = [];
  const changes: { column: string; value: string }[] = [];
  const missed: string[] = [];
  if (change.status?.trim()) {
    pushCell(pickColumn(change.status, cols)?.column, change.status, cells, changes, missed);
  }
  if (change.due?.trim()) {
    const column = pickColumn("due date", cols)?.column;
    if (!column) missed.push("due date");
    else if (column.id == null) missed.push(column.title);
    else {
      cells.push({ columnId: column.id, value: change.due.trim() });
      changes.push({ column: column.title, value: change.due.trim() });
    }
  }
  if (change.note?.trim()) {
    pushCell(pickColumn("notes", cols)?.column, change.note, cells, changes, missed);
  }
  if (change.column?.trim() && change.value?.trim()) {
    pushCell(pickColumn(change.column, cols)?.column, change.value, cells, changes, missed);
  }
  const rowLabel = (best.row.primaryText || best.row.text).slice(0, 140);
  if (!change.status && !change.due && !change.note && !(change.column && change.value)) {
    return {
      ok: false,
      reason: `Closest row is ${best.row.sheetName} · ${rowLabel}. Say the new status, date, or field value and I will prepare the approval.`,
      row: best.row,
    };
  }
  if (!cells.length) {
    return {
      ok: false,
      reason: `Found ${best.row.sheetName} · ${rowLabel}, but no column could be updated${missed.length ? ` (${missed.join(", ")})` : ""}.`,
      row: best.row,
    };
  }
  const display = { sheetName: best.row.sheetName, rowLabel, changes };
  return {
    ok: true,
    row: best.row,
    cells,
    display,
    args: {
      sheet_id: Number(best.row.sheetId) || best.row.sheetId,
      rows: [{ id: Number(best.row.rowId) || best.row.rowId, cells }],
      _display: display,
      ...(missed.length ? { _unmatched: missed } : {}),
    },
  };
}

const SHEETS_TO_LOAD = 4;

async function searchHits(text: string): Promise<ParsedSearchHit[]> {
  const query = looseSearchQuery(text);
  if (!query) return [];
  const raw = await callMcpTool("smartsheet__search", { query });
  if (raw.startsWith("Tool ") || raw.startsWith("INVALID_ARGUMENTS")) return [];
  return parseSearchHits(raw);
}

function rankedSheetIds(query: string, hits: ParsedSearchHit[]): string[] {
  const ordered: string[] = [];
  const scores = new Map<string, number>();
  for (const hit of hits) {
    if (!hit.sheetId) continue;
    const score = nameScore(query, hit.text || "");
    scores.set(hit.sheetId, Math.max(scores.get(hit.sheetId) ?? 0, score));
    if (!ordered.includes(hit.sheetId)) ordered.push(hit.sheetId);
  }
  for (const sheet of catalogSheets()) {
    if (!sheet.sheetId) continue;
    const score = nameScore(query, sheet.alias);
    if (score < CLOSEST_FLOOR) continue;
    scores.set(sheet.sheetId, Math.max(scores.get(sheet.sheetId) ?? 0, score));
    if (!ordered.includes(sheet.sheetId)) ordered.push(sheet.sheetId);
  }
  return ordered
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    .slice(0, SHEETS_TO_LOAD);
}

async function loadSheet(sheetId: string): Promise<{ rows: SheetRowHit[]; columns: SheetColumn[] }> {
  const alias = catalogSheets().find((sheet) => sheet.sheetId === sheetId)?.alias ?? sheetId;
  const raw = await callMcpTool("smartsheet__get_sheet_summary", {
    sheet_id: Number(sheetId) || sheetId,
  });
  const rows = parseSheetForRows(raw, sheetId, alias);
  let columns = rows[0]?.columns ?? parseColumns(raw);
  const columnRaw = await callMcpTool("smartsheet__get_columns", {
    sheet_id: Number(sheetId) || sheetId,
  }).catch(() => "");
  if (columnRaw && !columnRaw.startsWith("Tool ") && !columnRaw.startsWith("INVALID_ARGUMENTS")) {
    const live = parseColumns(columnRaw);
    if (live.length) columns = mergeColumns(columns, live);
  }
  for (const row of rows) row.columns = columns;
  return { rows, columns };
}

export async function resolveSheetUpdate(input: {
  query: string;
  sheet?: string;
  status?: string;
  due?: string;
  note?: string;
  column?: string;
  value?: string;
}): Promise<SheetUpdateChoice> {
  const query = input.query.trim();
  if (!query) return { ok: false, reason: "Say which project or row to update." };
  if (!process.env.SMARTSHEET_API_TOKEN) return { ok: false, reason: "Smartsheet is not connected." };
  const hits = [
    ...(await searchHits(query)),
    ...(input.sheet ? await searchHits(input.sheet) : []),
  ];
  const sheetIds = rankedSheetIds(`${query} ${input.sheet ?? ""}`, hits);
  if (!sheetIds.length) return { ok: false, reason: `No sheet resembles “${input.sheet?.trim() || query}”.` };
  const rows: SheetRowHit[] = [];
  let columns: SheetColumn[] = [];
  for (const sheetId of sheetIds) {
    const loaded = await loadSheet(sheetId);
    rows.push(...loaded.rows);
    columns = columns.concat(loaded.columns);
  }
  return chooseSheetUpdate(query, rows, [], {
    status: input.status,
    due: input.due,
    note: input.note,
    column: input.column,
    value: input.value,
  }, input.sheet);
}

export async function parkSheetUpdate(
  userId: string,
  choice: Extract<SheetUpdateChoice, { ok: true }>,
  authorization: AuthorizationContext
): Promise<{ id: string; message: string }> {
  const unmatched = Array.isArray(choice.args._unmatched)
    ? (choice.args._unmatched as string[])
    : [];
  const id = await parkAction(userId, "smartsheet__update_rows", choice.args, {
    effect: "shared_write",
    reason: "This changes a live Smartsheet row.",
    summary: formatWriteApproval("smartsheet__update_rows", choice.args),
    authorization,
  });
  const extra = unmatched.length ? `\nNo column matched: ${unmatched.join(", ")}.` : "";
  return { id, message: approvalMessage(id, "smartsheet__update_rows", choice.args) + extra };
}

/**
 * After a task is captured, search Smartsheet and park update_rows only when
 * the closest existing row is a real match and at least one cell can change.
 * Never add_rows here. A miss stays quiet.
 */
export async function maybeProposeSheetUpdate(
  userId: string,
  task: { title: string; detail?: string; due?: string },
  authorization: AuthorizationContext
): Promise<string | undefined> {
  if (!process.env.SMARTSHEET_API_TOKEN) return undefined;
  try {
    const blob = `${task.title} ${task.detail ?? ""}`;
    const choice = await resolveSheetUpdate({
      query: task.title,
      due: task.due,
      status: /\b(done|complete|closed|mitigated|resolved)\b/i.test(blob) ? "done" : undefined,
    });
    if (!choice.ok) {
      if (!choice.row) return undefined;
      return `\nRelated Smartsheet row on ${choice.row.sheetName}: ${choice.row.primaryText || choice.row.text} — say if you want it updated.`;
    }
    const parked = await parkSheetUpdate(userId, choice, authorization);
    return `\n${parked.message}`;
  } catch (err) {
    console.error("[smartsheet] inferred match failed (non-fatal):", err);
    return undefined;
  }
}
