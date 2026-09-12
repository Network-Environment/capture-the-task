import { type Container } from "@azure/cosmos";
import { randomUUID } from "node:crypto";
import { embed } from "../services/router";
import { cosmosContainer } from "../services/cosmos";
import type { ActivityAttribution } from "../services/activityLog";
import type {
  CreateGraphEdge,
  CreateGraphNode,
  GraphEdge,
  GraphFilters,
  GraphNode,
  GraphNodePatch,
  GraphPayload,
  GraphProvenance,
  GraphReviewState,
  GraphStats,
} from "./types";
import {
  clampGraphDepth,
  clampGraphLimit,
  deterministicEdgeId,
  deterministicGraphId,
  dependencyWouldCycle,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  mergeGraphNodePatch,
  validateEdgeInput,
  validateNodeInput,
  visibleTo,
} from "./validation";

function nodes() {
  return cosmosContainer("graph-nodes");
}
function edges() {
  return cosmosContainer("graph-edges");
}

export function graphEnabled(): boolean {
  return /^true$/i.test(process.env.EXECUTION_GRAPH_ENABLED ?? "");
}

export function graphWorkspaceId(): string {
  return process.env.GRAPH_WORKSPACE_ID?.trim() || "org";
}

export function graphWritesEnabled(): boolean {
  return /^true$/i.test(process.env.EXECUTION_GRAPH_WRITES_ENABLED ?? "");
}

function requireEnabled(): void {
  if (!graphEnabled()) throw new Error("Execution graph is disabled.");
}

function defaultStatus(type: CreateGraphNode["type"]): GraphNode["status"] {
  if (type === "task") return "open";
  if (type === "project") return "planned";
  return undefined;
}

function nodeText(input: Pick<CreateGraphNode, "title" | "description" | "status" | "due">): string {
  return [input.title, input.description, input.status, input.due].filter(Boolean).join("\n");
}

export async function putGraphNode(
  input: CreateGraphNode,
  actorId: string,
  attribution: Partial<ActivityAttribution> = {},
  options: { skipEmbedding?: boolean; embedding?: number[]; expectedVersion?: number } = {}
): Promise<GraphNode> {
  requireEnabled();
  validateNodeInput(input);
  const workspaceId = graphWorkspaceId();
  const id =
    input.id ??
    (input.source
      ? deterministicGraphId(input.source.kind, input.source.id)
      : deterministicGraphId(input.type, randomUUID()));
  const existing = await readNodeRaw(id);
  if (
    options.expectedVersion !== undefined &&
    existing?.version !== options.expectedVersion
  ) {
    throw new Error(`Graph node changed since it was loaded (current version ${existing?.version ?? 0}).`);
  }
  const now = new Date().toISOString();
  const draft: GraphNode = {
    ...existing,
    id,
    workspaceId,
    docType: "node",
    type: input.type,
    title: input.title.trim(),
    description:
      "description" in input ? input.description?.trim() || undefined : existing?.description,
    status:
      "status" in input ? input.status ?? defaultStatus(input.type) : existing?.status ?? defaultStatus(input.type),
    ownerPersonId:
      "ownerPersonId" in input ? input.ownerPersonId : existing?.ownerPersonId,
    due: "due" in input ? input.due : existing?.due,
    visibility: input.visibility ?? existing?.visibility ?? "workspace",
    privateOwnerId: input.privateOwnerId ?? existing?.privateOwnerId,
    source: input.source ?? existing?.source,
    provenance: input.provenance ?? existing?.provenance ?? "human",
    createdBy: existing?.createdBy ?? actorId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    ttl: "ttl" in input ? input.ttl : existing?.ttl,
  };
  if (existing && sameNodeContent(existing, draft)) return existing;
  const textUnchanged =
    existing &&
    nodeText(existing) === nodeText(draft) &&
    Boolean(existing.embedding?.length);
  const embedding =
    options.embedding ??
    (options.skipEmbedding
      ? existing?.embedding
      : textUnchanged
        ? existing.embedding
        : await embed(nodeText(draft), { ...attribution, trigger: "graph_index" }));
  const node: GraphNode = { ...draft, embedding };
  if (existing) {
    await nodes().item(id, workspaceId).replace(node, {
      accessCondition: { type: "IfMatch", condition: existing._etag ?? "" },
    });
  } else {
    await nodes().items.create(node);
  }
  return node;
}

export async function patchGraphNode(
  id: string,
  patch: GraphNodePatch,
  actorId: string,
  expectedVersion?: number,
  attribution: Partial<ActivityAttribution> = {}
): Promise<GraphNode> {
  requireEnabled();
  const current = await getGraphNode(id, actorId);
  if (!current) throw new Error(`Graph node not found: ${id}`);
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new Error(`Graph node changed since it was loaded (current version ${current.version}).`);
  }
  return putGraphNode(
    mergeGraphNodePatch(current, patch),
    actorId,
    attribution,
    { expectedVersion: current.version }
  );
}

async function readNodeRaw(id: string): Promise<GraphNode | undefined> {
  try {
    const { resource } = await nodes().item(id, graphWorkspaceId()).read<GraphNode>();
    return resource;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return undefined;
    throw err;
  }
}

export async function getGraphNode(id: string, userId: string): Promise<GraphNode | undefined> {
  requireEnabled();
  const node = await readNodeRaw(id);
  return node && visibleTo(node, userId) ? node : undefined;
}

async function edgeList(reviewStates: GraphReviewState[] = ["accepted"]): Promise<GraphEdge[]> {
  const placeholders = reviewStates.map((_, i) => `@review${i}`);
  const { resources } = await edges().items
    .query<GraphEdge>({
      query: `SELECT * FROM c WHERE c.workspaceId = @workspaceId
        AND c.reviewState IN (${placeholders.join(",")})`,
      parameters: [
        { name: "@workspaceId", value: graphWorkspaceId() },
        ...reviewStates.map((value, i) => ({ name: `@review${i}`, value })),
      ],
    })
    .fetchAll();
  return resources;
}

export async function putGraphEdge(input: CreateGraphEdge, actorId: string): Promise<GraphEdge> {
  requireEnabled();
  const from = await readNodeRaw(input.fromId);
  const to = await readNodeRaw(input.toId);
  if (!from || !to) throw new Error("Both graph edge endpoints must exist.");
  if (
    input.provenance !== "system" &&
    (!visibleTo(from, actorId) || !visibleTo(to, actorId))
  ) {
    throw new Error("Graph relationship target is not visible to this user.");
  }
  validateEdgeInput(input, from, to);
  const reviewState =
    input.reviewState ?? (input.provenance === "agent" ? "proposed" : "accepted");
  if (input.type === "depends_on" && reviewState === "accepted") {
    await assertNoDependencyCycle(input.fromId, input.toId);
  }
  const id = input.id ?? deterministicEdgeId(input.fromId, input.type, input.toId);
  let existing: GraphEdge | undefined;
  try {
    existing = (await edges().item(id, graphWorkspaceId()).read<GraphEdge>()).resource;
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
  }
  const now = new Date().toISOString();
  const edge: GraphEdge = {
    ...existing,
    id,
    workspaceId: graphWorkspaceId(),
    docType: "edge",
    fromId: input.fromId,
    toId: input.toId,
    type: input.type,
    reviewState,
    provenance: input.provenance ?? existing?.provenance ?? "human",
    evidence: input.evidence?.trim() || existing?.evidence,
    confidence: input.confidence ?? existing?.confidence,
    ttl: "ttl" in input ? input.ttl : existing?.ttl,
    createdBy: existing?.createdBy ?? actorId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
  };
  if (
    existing &&
    existing.reviewState === edge.reviewState &&
    existing.provenance === edge.provenance &&
    existing.evidence === edge.evidence &&
    existing.confidence === edge.confidence &&
    existing.ttl === edge.ttl
  ) {
    return existing;
  }
  if (existing) {
    await edges().item(id, graphWorkspaceId()).replace(edge, {
      accessCondition: { type: "IfMatch", condition: existing._etag ?? "" },
    });
  } else {
    await edges().items.create(edge);
  }
  return edge;
}

export async function reviewGraphEdge(
  id: string,
  reviewState: "accepted" | "rejected",
  actorId: string,
  expectedVersion?: number
): Promise<GraphEdge> {
  requireEnabled();
  const { resource } = await edges().item(id, graphWorkspaceId()).read<GraphEdge>();
  if (!resource) throw new Error(`Graph edge not found: ${id}`);
  if (expectedVersion !== undefined && resource.version !== expectedVersion) {
    throw new Error(`Graph edge changed since it was loaded (current version ${resource.version}).`);
  }
  if (reviewState === "accepted" && resource.type === "depends_on") {
    await assertNoDependencyCycle(resource.fromId, resource.toId, resource.id);
  }
  const updated = {
    ...resource,
    reviewState,
    updatedAt: new Date().toISOString(),
    version: resource.version + 1,
    reviewedBy: actorId,
  };
  await edges().item(id, graphWorkspaceId()).replace(updated, {
    accessCondition: { type: "IfMatch", condition: resource._etag ?? "" },
  });
  return updated;
}

/** Keep a single-valued structural relationship (owner or parent project) in sync. */
export async function setGraphSingleRelationship(
  fromId: string,
  type: "assigned_to" | "part_of",
  toId: string | undefined,
  actorId: string,
  provenance: GraphProvenance,
  evidence: string,
  ttl?: number
): Promise<GraphEdge | undefined> {
  requireEnabled();
  const current = (await edgeList(["accepted", "proposed"])).filter(
    (edge) => edge.fromId === fromId && edge.type === type
  );
  const now = new Date().toISOString();
  for (const edge of current) {
    if (edge.toId === toId && edge.reviewState === "accepted") continue;
    await edges().item(edge.id, graphWorkspaceId()).replace({
      ...edge,
      reviewState: "rejected",
      updatedAt: now,
      version: edge.version + 1,
      reviewedBy: actorId,
    }, {
      accessCondition: { type: "IfMatch", condition: edge._etag ?? "" },
    });
  }
  if (!toId) return undefined;
  return putGraphEdge(
    {
      fromId,
      toId,
      type,
      reviewState: "accepted",
      provenance,
      evidence,
      ttl,
    },
    actorId
  );
}

async function assertNoDependencyCycle(fromId: string, toId: string, ignoreEdgeId?: string): Promise<void> {
  const all = (await edgeList(["accepted"])).filter(
    (edge) => edge.type === "depends_on" && edge.id !== ignoreEdgeId
  );
  if (dependencyWouldCycle(fromId, toId, all)) {
    throw new Error("Dependency would create a cycle.");
  }
}

export async function graphNeighborhood(
  startIds: string[],
  userId: string,
  depth = 1,
  limit = 40,
  includeProposed = false
): Promise<GraphPayload> {
  requireEnabled();
  const maxDepth = clampGraphDepth(depth);
  const maxNodes = clampGraphLimit(limit);
  const allEdges = await edgeList(includeProposed ? ["accepted", "proposed"] : ["accepted"]);
  const initial = await Promise.all(startIds.slice(0, maxNodes).map(readNodeRaw));
  const ids = new Set(
    initial.filter((node): node is GraphNode => Boolean(node && visibleTo(node, userId))).map((node) => node.id)
  );
  let frontier = new Set(ids);
  for (let hop = 0; hop < maxDepth && frontier.size && ids.size < maxNodes; hop++) {
    const candidates = new Set<string>();
    for (const edge of allEdges) {
      if (frontier.has(edge.fromId) && !ids.has(edge.toId)) candidates.add(edge.toId);
      if (frontier.has(edge.toId) && !ids.has(edge.fromId)) candidates.add(edge.fromId);
    }
    const candidatesLoaded = await Promise.all(
      [...candidates].slice(0, maxNodes - ids.size).map(readNodeRaw)
    );
    frontier = new Set(
      candidatesLoaded
        .filter((node): node is GraphNode => Boolean(node && visibleTo(node, userId)))
        .map((node) => node.id)
    );
    for (const id of frontier) ids.add(id);
  }
  const loaded = await Promise.all([...ids].map(readNodeRaw));
  const visibleNodes = loaded
    .filter((n): n is GraphNode => Boolean(n && visibleTo(n, userId)))
    .map(withoutEmbedding);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const selectedEdges = allEdges
    .filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId))
    .slice(0, GRAPH_MAX_EDGES);
  return {
    nodes: visibleNodes,
    edges: selectedEdges,
    truncated: ids.size >= maxNodes || selectedEdges.length >= GRAPH_MAX_EDGES,
  };
}

export async function searchExecutionGraph(
  query: string,
  userId: string,
  options: { limit?: number; depth?: number; includeProposed?: boolean } = {},
  attribution: Partial<ActivityAttribution> = {}
): Promise<GraphPayload> {
  requireEnabled();
  const limit = clampGraphLimit(options.limit);
  if (!query.trim()) return listExecutionGraph(userId, { limit, includeProposed: options.includeProposed });
  const qv = await embed(query, { ...attribution, trigger: "graph_recall" });
  const { resources } = await nodes().items
    .query<GraphNode>({
      query: `SELECT TOP @limit * FROM c
        WHERE c.workspaceId = @workspaceId AND IS_DEFINED(c.embedding)
        ORDER BY VectorDistance(c.embedding, @qv)`,
      parameters: [
        { name: "@limit", value: Math.min(12, limit) },
        { name: "@workspaceId", value: graphWorkspaceId() },
        { name: "@qv", value: qv },
      ],
    })
    .fetchAll();
  const seeds = resources.filter((node) => visibleTo(node, userId));
  if (!seeds.length) {
    return listExecutionGraph(userId, {
      query,
      limit,
      includeProposed: options.includeProposed,
    });
  }
  return graphNeighborhood(
    seeds.map((node) => node.id),
    userId,
    options.depth ?? 1,
    limit,
    options.includeProposed
  );
}

export async function listExecutionGraph(
  userId: string,
  filters: GraphFilters = {}
): Promise<GraphPayload> {
  requireEnabled();
  // Reserve room for one-hop context so filtered task/project pages still
  // show owners, parent projects, and source meetings.
  const pageSize = Math.min(50, clampGraphLimit(filters.limit));
  const clauses = ["c.workspaceId = @workspaceId"];
  const parameters: { name: string; value: string | string[] | number }[] = [
    { name: "@workspaceId", value: graphWorkspaceId() },
  ];
  if (filters.types?.length) {
    clauses.push("ARRAY_CONTAINS(@types, c.type)");
    parameters.push({ name: "@types", value: filters.types });
  }
  if (filters.statuses?.length) {
    clauses.push("ARRAY_CONTAINS(@statuses, c.status)");
    parameters.push({ name: "@statuses", value: filters.statuses });
  }
  if (filters.ownerPersonId) {
    clauses.push("c.ownerPersonId = @owner");
    parameters.push({ name: "@owner", value: filters.ownerPersonId });
  }
  if (filters.query?.trim()) {
    clauses.push("(CONTAINS(c.title, @query, true) OR CONTAINS(c.description, @query, true))");
    parameters.push({ name: "@query", value: filters.query });
  }
  const cursor = decodeCursor(filters.cursor);
  if (cursor) {
    clauses.push("(c.updatedAt < @cursorAt OR (c.updatedAt = @cursorAt AND c.id < @cursorId))");
    parameters.push(
      { name: "@cursorAt", value: cursor.updatedAt },
      { name: "@cursorId", value: cursor.id }
    );
  }
  const { resources } = await nodes().items
    .query<GraphNode>({
      query: `SELECT TOP @limit * FROM c WHERE ${clauses.join(
        " AND "
      )} ORDER BY c.updatedAt DESC, c.id DESC`,
      parameters: [...parameters, { name: "@limit", value: pageSize }],
    })
    .fetchAll();
  const visible = resources.filter((node) => visibleTo(node, userId));
  const payload = await graphNeighborhood(
    visible.map((node) => node.id),
    userId,
    1,
    GRAPH_MAX_NODES,
    filters.includeProposed
  );
  payload.matchedIds = visible.map((node) => node.id);
  const last = resources.at(-1);
  if (last && resources.length === pageSize) {
    payload.nextCursor = Buffer.from(
      JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
      "utf8"
    ).toString("base64url");
  }
  return payload;
}

export async function executionGraphStats(userId: string): Promise<GraphStats> {
  requireEnabled();
  const { resources: nodeRows } = await nodes().items
    .query<Pick<GraphNode, "id" | "visibility" | "privateOwnerId" | "type" | "status" | "due">>({
      query:
        "SELECT c.id, c.visibility, c.privateOwnerId, c.type, c.status, c.due FROM c WHERE c.workspaceId = @workspaceId",
      parameters: [{ name: "@workspaceId", value: graphWorkspaceId() }],
    })
    .fetchAll();
  const visible = nodeRows.filter(
    (node) =>
      node.visibility === "workspace" ||
      (node.visibility === "private" && node.privateOwnerId === userId)
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const allIds = new Set(nodeRows.map((node) => node.id));
  const allEdges = await edgeList(["accepted", "proposed"]);
  const visibleEdges = allEdges.filter(
    (edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId)
  );
  const now = new Date().toISOString().slice(0, 10);
  return {
    nodes: visible.length,
    edges: visibleEdges.filter((edge) => edge.reviewState === "accepted").length,
    proposals: visibleEdges.filter((edge) => edge.reviewState === "proposed").length,
    overdue: visible.filter(
      (node) =>
        node.type === "task" &&
        !["done", "cancelled"].includes(node.status ?? "") &&
        Boolean(node.due && node.due.slice(0, 10) < now)
    ).length,
    orphans: allEdges.filter(
      (edge) => !allIds.has(edge.fromId) || !allIds.has(edge.toId)
    ).length,
  };
}

export function graphContainers(): { nodes: Container; edges: Container } {
  return { nodes: nodes(), edges: edges() };
}

function decodeCursor(value?: string): { updatedAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      updatedAt?: string;
      id?: string;
    };
    if (!parsed.updatedAt || !parsed.id || Number.isNaN(Date.parse(parsed.updatedAt))) return undefined;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

function withoutEmbedding(node: GraphNode): GraphNode {
  const { embedding: _embedding, ...safe } = node;
  return safe;
}

function sameNodeContent(a: GraphNode, b: GraphNode): boolean {
  return JSON.stringify({
    type: a.type,
    title: a.title,
    description: a.description,
    status: a.status,
    ownerPersonId: a.ownerPersonId,
    due: a.due,
    visibility: a.visibility,
    privateOwnerId: a.privateOwnerId,
    source: a.source,
    provenance: a.provenance,
    ttl: a.ttl,
  }) === JSON.stringify({
    type: b.type,
    title: b.title,
    description: b.description,
    status: b.status,
    ownerPersonId: b.ownerPersonId,
    due: b.due,
    visibility: b.visibility,
    privateOwnerId: b.privateOwnerId,
    source: b.source,
    provenance: b.provenance,
    ttl: b.ttl,
  });
}
