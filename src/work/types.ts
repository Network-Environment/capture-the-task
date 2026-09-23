import type { ExecutionQueue } from "../org/types";

export type WorkSource = "chat" | "meeting" | "agent";
export type WorkStatus = "open" | "accepted" | "blocked" | "done" | "cancelled";
export type WorkEffort = 1 | 2 | 3 | 5 | 8;
export type DestinationKind = "teams" | "todo" | "planner" | "smartsheet" | "email" | "imessage";

export interface WorkDestination {
  kind: DestinationKind;
  id?: string;
  extra?: string;
  error?: string;
}

export interface WorkAssignment {
  id: string;
  ownerPersonId: string;
  entraId?: string;
  title: string;
  detail?: string;
  due?: string;
  effort?: WorkEffort;
  lastProgressAt?: string;
  progressNote?: string;
  source: WorkSource;
  sourceId?: string;
  requesterUserId?: string;
  status: WorkStatus;
  destinations: WorkDestination[];
  createdAt: string;
  updatedAt: string;
}

export function newWorkId(): string {
  return `wrk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function queueToDestination(queue: ExecutionQueue): DestinationKind {
  return queue;
}
