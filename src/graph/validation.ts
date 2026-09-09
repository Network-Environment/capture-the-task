import type {
  CreateGraphEdge,
  CreateGraphNode,
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodePatch,
  GraphNodeStatus,
  GraphNodeType,
} from "./types";

export const GRAPH_MAX_NODES = 100;
export const GRAPH_MAX_EDGES = 250;
export const GRAPH_MAX_DEPTH = 2;

const nodeTypes = new Set<GraphNodeType>(["project", "task", "person", "meeting", "evidence"]);
const statuses = new Set<GraphNodeStatus>([
  "planned",
  "active",
  "blocked",
  "done",
  "cancelled",
  "open",
  "stale",
]);

const allowedEdges: Record<GraphEdgeType, [GraphNodeType[], GraphNodeType[]]> = {
  part_of: [["task", "project"], ["project"]],
  assigned_to: [["task", "project"], ["person"]],
  depends_on: [["task", "project"], ["task", "project"]],
  originated_from: [["task", "project"], ["meeting", "evidence"]],
  supports: [["evidence", "meeting"], ["task", "project"]],
  related_to: [
    ["project", "task", "person", "meeting", "evidence"],
    ["project", "task", "person", "meeting", "evidence"],
  ],
};

export function validateNodeInput(input: CreateGraphNode): void {
  if (!nodeTypes.has(input.type)) throw new Error(`Invalid graph node type: ${input.type}`);
  if (!input.title?.trim()) throw new Error("Graph node title is required.");
  if (input.title.trim().length > 240) throw new Error("Graph node title must be 240 characters or less.");
  if (input.description && input.description.length > 8_000) {
    throw new Error("Graph node description must be 8,000 characters or less.");
  }
  if (input.status && !statuses.has(input.status)) throw new Error(`Invalid graph status: ${input.status}`);
  if (input.due && Number.isNaN(Date.parse(input.due))) throw new Error("Graph due date must be ISO-8601.");
  if (input.visibility === "private" && !input.privateOwnerId) {
    throw new Error("Private graph nodes require privateOwnerId.");
  }
}

export function validateEdgeInput(
  input: CreateGraphEdge,
  from: Pick<GraphNode, "id" | "type">,
  to: Pick<GraphNode, "id" | "type">
): void {
  if (from.id === to.id) throw new Error("A graph node cannot link to itself.");
  const rule = allowedEdges[input.type];
  if (!rule) throw new Error(`Invalid graph edge type: ${input.type}`);
  if (!rule[0].includes(from.type) || !rule[1].includes(to.type)) {
    throw new Error(`${input.type} cannot connect ${from.type} to ${to.type}.`);
  }
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw new Error("Graph edge confidence must be between 0 and 1.");
  }
  if (input.evidence && input.evidence.length > 2_000) {
    throw new Error("Graph edge evidence must be 2,000 characters or less.");
  }
}

export function clampGraphDepth(depth: number): number {
  const value = Number.isFinite(depth) ? depth : 1;
  return Math.max(0, Math.min(GRAPH_MAX_DEPTH, Math.floor(value)));
}

export function clampGraphLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(GRAPH_MAX_NODES, Math.floor(limit || 40)));
}

export function visibleTo(node: GraphNode, userId: string): boolean {
  return node.visibility === "workspace" || node.privateOwnerId === userId;
}

export function deterministicGraphId(kind: string, sourceId: string): string {
  const safeKind = kind.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const safeId = sourceId.toLowerCase().replace(/[^a-z0-9._:-]/g, "-").slice(0, 180);
  return `${safeKind}:${safeId}`;
}

export function deterministicEdgeId(fromId: string, type: string, toId: string): string {
  return `${fromId}|${type}|${toId}`.toLowerCase().replace(/[^a-z0-9|._:-]/g, "-").slice(0, 250);
}

export function dependencyWouldCycle(
  fromId: string,
  toId: string,
  existing: Pick<GraphEdge, "fromId" | "toId" | "type" | "reviewState">[]
): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of existing) {
    if (edge.type !== "depends_on" || edge.reviewState !== "accepted") continue;
    outgoing.set(edge.fromId, [...(outgoing.get(edge.fromId) ?? []), edge.toId]);
  }
  const pending = [toId];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (id === fromId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }
  return false;
}

export function mergeGraphNodePatch(
  current: GraphNode,
  patch: GraphNodePatch
): CreateGraphNode {
  return {
    ...current,
    id: current.id,
    title: patch.title ?? current.title,
    description:
      patch.description === undefined ? current.description : patch.description ?? undefined,
    status: patch.status === undefined ? current.status : patch.status,
    ownerPersonId:
      patch.ownerPersonId === undefined ? current.ownerPersonId : patch.ownerPersonId ?? undefined,
    due: patch.due === undefined ? current.due : patch.due ?? undefined,
    source: current.source,
    provenance: current.provenance,
  };
}

export function findDependencyCycles(
  edges: Pick<GraphEdge, "fromId" | "toId">[]
): string[][] {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    next.set(edge.fromId, [...(next.get(edge.fromId) ?? []), edge.toId]);
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const walk = (id: string) => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const target of next.get(id) ?? []) walk(target);
    stack.pop();
    active.delete(id);
  };
  for (const id of next.keys()) walk(id);
  return cycles;
}
