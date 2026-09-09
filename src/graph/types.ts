export type GraphNodeType = "project" | "task" | "person" | "meeting" | "evidence";
export type GraphNodeStatus =
  | "planned"
  | "active"
  | "blocked"
  | "done"
  | "cancelled"
  | "open"
  | "stale";
export type GraphVisibility = "workspace" | "private";
export type GraphEdgeType =
  | "part_of"
  | "assigned_to"
  | "depends_on"
  | "originated_from"
  | "supports"
  | "related_to";
export type GraphReviewState = "accepted" | "proposed" | "rejected";
export type GraphProvenance = "human" | "agent" | "system";

export interface GraphSourceRef {
  kind: "org" | "meeting" | "commitment" | "note" | "graph";
  id: string;
}

export interface GraphNode {
  id: string;
  workspaceId: string;
  docType: "node";
  type: GraphNodeType;
  title: string;
  description?: string;
  status?: GraphNodeStatus;
  ownerPersonId?: string;
  due?: string;
  visibility: GraphVisibility;
  privateOwnerId?: string;
  source?: GraphSourceRef;
  provenance: GraphProvenance;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  embedding?: number[];
  ttl?: number;
  _etag?: string;
}

export interface GraphEdge {
  id: string;
  workspaceId: string;
  docType: "edge";
  fromId: string;
  toId: string;
  type: GraphEdgeType;
  reviewState: GraphReviewState;
  provenance: GraphProvenance;
  evidence?: string;
  confidence?: number;
  ttl?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  _etag?: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated?: boolean;
  nextCursor?: string;
  stats?: GraphStats;
  matchedIds?: string[];
}

export interface GraphStats {
  nodes: number;
  edges: number;
  proposals: number;
  overdue: number;
  orphans: number;
}

export interface CreateGraphNode {
  id?: string;
  type: GraphNodeType;
  title: string;
  description?: string;
  status?: GraphNodeStatus;
  ownerPersonId?: string;
  due?: string;
  visibility?: GraphVisibility;
  privateOwnerId?: string;
  source?: GraphSourceRef;
  provenance?: GraphProvenance;
  ttl?: number;
}

export interface CreateGraphEdge {
  id?: string;
  fromId: string;
  toId: string;
  type: GraphEdgeType;
  reviewState?: GraphReviewState;
  provenance?: GraphProvenance;
  evidence?: string;
  confidence?: number;
  ttl?: number;
}

export interface GraphNodePatch {
  title?: string;
  description?: string | null;
  status?: GraphNodeStatus;
  ownerPersonId?: string | null;
  due?: string | null;
}

export interface GraphFilters {
  types?: GraphNodeType[];
  statuses?: GraphNodeStatus[];
  ownerPersonId?: string;
  query?: string;
  includeProposed?: boolean;
  limit?: number;
  cursor?: string;
}
