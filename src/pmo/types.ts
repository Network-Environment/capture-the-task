export const PMO_MAX_COLUMNS = 8;
export const PMO_MAX_FIELDS = 6;
export const PMO_MAX_ITEMS = 80;
export const PMO_LABEL_MAX = 80;
export const PMO_FIELD_VALUE_MAX = 400;
export const PMO_TITLE_MAX = 80;
export const PMO_PURPOSE_MAX = 400;
export const PMO_CLOSE_TTL_SECONDS = 90 * 24 * 60 * 60;

export const KANBAN_COLUMN_LABELS = ["To do", "Doing", "Blocked", "Done"] as const;

export type PmoBoardStatus = "open" | "closed";
export type PmoDocKind = "board" | "item";
export type PmoItemSourceKind = "chat" | "meeting" | "agent";

export interface PmoSchemaPart {
  id: string;
  label: string;
}

export interface PmoBoard {
  id: string;
  boardId: string;
  kind: "board";
  title: string;
  purpose: string;
  status: PmoBoardStatus;
  createdBy: string;
  columns: PmoSchemaPart[];
  fields: PmoSchemaPart[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  ttl?: number;
}

export interface PmoItem {
  id: string;
  boardId: string;
  kind: "item";
  title: string;
  detail?: string;
  columnId: string;
  ownerPersonId?: string;
  due?: string;
  lastProgressAt?: string;
  progressNote?: string;
  fieldValues: Record<string, string>;
  workId?: string;
  source?: { kind: PmoItemSourceKind; id?: string };
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

export type PmoDoc = PmoBoard | PmoItem;
