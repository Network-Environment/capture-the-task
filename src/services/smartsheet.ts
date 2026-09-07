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
      "\n\nKnown Smartsheet catalog: none configured. Search by sheet name " +
      "with smartsheet__search (quote multi-word terms). Never guess sheet IDs."
    );
  }
  const lines = sheets.map((s) => {
    const id = s.sheetId ? ` sheetId=${s.sheetId}` : "";
    const ws = s.workspaceId ? ` workspaceId=${s.workspaceId}` : "";
    const purpose = s.purpose ? ` — ${s.purpose}` : "";
    return `- "${s.alias}"${id}${ws}${purpose}`;
  });
  return (
    "\n\nKnown Smartsheet catalog (use these ids when they match; otherwise search):\n" +
    lines.join("\n")
  );
}

const PMO_RE =
  /\b(smartsheet|pmo|risk register|project tracker|workspace|sheet id|update the row|add a row|status of)\b/i;

export function isPmoRequest(text: string): boolean {
  if (PMO_RE.test(text)) return true;
  const lower = text.toLowerCase();
  return catalogSheets().some((s) => s.alias && lower.includes(s.alias.toLowerCase()));
}

/** Personal-note recall vs live PMO/tools. */
export function agentProfileFor(kind: "action" | string, text: string): string | undefined {
  if (kind !== "action") return undefined;
  return isPmoRequest(text) ? "pmo" : undefined;
}

export interface SheetRowHit {
  sheetId: string;
  sheetName: string;
  rowId: string;
  text: string;
  owner?: string;
  statusColumnId?: number;
  dueColumnId?: number;
  notesColumnId?: number;
}

const MATCH_THRESHOLD = 0.55;

export function pickBestRow(
  title: string,
  rows: SheetRowHit[],
  owner?: string
): { row: SheetRowHit; score: number } | undefined {
  let best: { row: SheetRowHit; score: number } | undefined;
  for (const row of rows) {
    let score = overlapScore(title, row.text);
    if (owner && row.owner && owner.toLowerCase() === row.owner.toLowerCase()) score += 0.15;
    if (!best || score > best.score) best = { row, score };
  }
  if (!best || best.score < MATCH_THRESHOLD) return undefined;
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
  const sheetId = String(args.sheetId ?? args.sheet_id ?? "");
  const sheetName = catalogSheets().find((s) => s.sheetId && s.sheetId === sheetId)?.alias;
  const rows = (Array.isArray(args.rows) ? args.rows : []) as Record<string, unknown>[];
  const rowBits = rows.slice(0, 4).map((r) => {
    const id = r.id ?? r.rowId ?? "?";
    const cells = Array.isArray(r.cells) ? (r.cells as { columnId?: unknown; value?: unknown }[]) : [];
    const changes = cells
      .map((c) => `col ${c.columnId}: ${String(c.value ?? "").slice(0, 80)}`)
      .join("; ");
    return `row ${id}${changes ? ` → ${changes}` : ""}`;
  });
  const where = sheetName ? `${sheetName} (${sheetId || "no id"})` : sheetId || "sheet unspecified";
  const action = tool.endsWith("add_rows") ? "Add row(s)" : tool.endsWith("update_rows") ? "Update row(s)" : tool;
  const body = rowBits.length ? rowBits.join("\n") : JSON.stringify(args).slice(0, 400);
  return `**${action}** on ${where}\n${body}`;
}

export function approvalMessage(id: string, tool: string, args: Record<string, unknown>): string {
  const detail = tool.startsWith("smartsheet__")
    ? formatWriteApproval(tool, args)
    : `**${tool}**\n\`\`\`\n${JSON.stringify(args, null, 2).slice(0, 800)}\n\`\`\``;
  return (
    `Write action held for approval:\n${detail}\n\n` +
    `Reply **approve ${id}** or **deny ${id}** (expires in 1 hour).`
  );
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

export function parseSheetForRows(raw: string, sheetId: string, sheetName: string): SheetRowHit[] {
  try {
    const parsed = JSON.parse(raw) as {
      name?: string;
      columns?: { id: number; title?: string }[];
      rows?: { id: number; cells?: { columnId: number; displayValue?: string; value?: unknown }[] }[];
    };
    const cols = parsed.columns ?? [];
    const status = cols.find((c) => columnNameLooksLike(c.title ?? "", ["status", "state"]));
    const due = cols.find((c) => columnNameLooksLike(c.title ?? "", ["due", "date"]));
    const notes = cols.find((c) => columnNameLooksLike(c.title ?? "", ["note", "comment", "update", "remark"]));
    const primary = cols[0];
    const ownerCol = cols.find((c) => columnNameLooksLike(c.title ?? "", ["owner", "assigned", "raci"]));
    const hits: SheetRowHit[] = [];
    for (const row of parsed.rows ?? []) {
      const cellText = (row.cells ?? [])
        .map((c) => String(c.displayValue ?? c.value ?? ""))
        .filter(Boolean)
        .join(" ");
      const ownerCell = ownerCol
        ? row.cells?.find((c) => c.columnId === ownerCol.id)
        : undefined;
      hits.push({
        sheetId,
        sheetName: parsed.name ?? sheetName,
        rowId: String(row.id),
        text: cellText || (primary ? String(row.cells?.find((c) => c.columnId === primary.id)?.displayValue ?? "") : ""),
        owner: ownerCell ? String(ownerCell.displayValue ?? ownerCell.value ?? "") : undefined,
        statusColumnId: status?.id,
        dueColumnId: due?.id,
        notesColumnId: notes?.id,
      });
    }
    return hits;
  } catch {
    return [];
  }
}

/**
 * After a task is captured, search Smartsheet and park update_rows only when
 * one existing row is a clear match and we can infer at least one cell change.
 * Never add_rows here.
 */
export async function maybeProposeSheetUpdate(
  userId: string,
  task: { title: string; detail?: string; due?: string }
): Promise<string | undefined> {
  if (!process.env.SMARTSHEET_API_TOKEN) return undefined;
  try {
    const q = `"${task.title.replace(/"/g, "")}"`;
    const searchRaw = await callMcpTool("smartsheet__search", { query: q });
    if (searchRaw.startsWith("Tool ") || searchRaw.includes("not found")) return undefined;

    const hits = parseSearchHits(searchRaw);
    const catalogIds = new Set(catalogSheets().map((s) => s.sheetId).filter(Boolean) as string[]);
    const sheetIds = [
      ...new Set(
        hits
          .map((h) => h.sheetId)
          .filter((id): id is string => !!id && (!catalogIds.size || catalogIds.has(id)))
      ),
    ].slice(0, 2);

    const extraCatalog = catalogSheets()
      .map((s) => s.sheetId)
      .filter((id): id is string => !!id && !sheetIds.includes(id))
      .slice(0, Math.max(0, 2 - sheetIds.length));
    const toLoad = [...sheetIds, ...extraCatalog].slice(0, 2);
    if (!toLoad.length) return undefined;

    const rows: SheetRowHit[] = [];
    for (const sid of toLoad) {
      const alias = catalogSheets().find((s) => s.sheetId === sid)?.alias ?? sid;
      const raw = await callMcpTool("smartsheet__get_sheet", { sheetId: sid });
      rows.push(...parseSheetForRows(raw, sid, alias));
    }

    const best = pickBestRow(task.title, rows);
    if (!best) return undefined;
    const cells = inferCellUpdates(best.row, task);
    if (!cells.length) {
      return `\nRelated Smartsheet row ${best.row.rowId} on ${best.row.sheetName} — say if you want it updated.`;
    }

    const args = {
      sheetId: best.row.sheetId,
      rows: [{ id: Number(best.row.rowId) || best.row.rowId, cells }],
    };
    const id = await parkAction(userId, "smartsheet__update_rows", args);
    return (
      `\nProposed Smartsheet update (not applied): ${best.row.sheetName} row ${best.row.rowId}. ` +
      `Reply **approve ${id}** or **deny ${id}**.`
    );
  } catch (err) {
    console.error("[smartsheet] inferred match failed (non-fatal):", err);
    return undefined;
  }
}
