export type MemoryNetwork = "world" | "experience" | "opinion" | "observation";
export type MemorySource = "chat" | "meeting" | "note" | "graph";
export type MemoryEdgeType = "entity" | "temporal" | "semantic" | "causal";

export interface MemoryFact {
  id: string;
  bankId: string;
  docType: "fact";
  network: MemoryNetwork;
  text: string;
  embedding?: number[];
  validFrom?: string;
  validTo?: string;
  mentionedAt: string;
  confidence?: number;
  entityIds: string[];
  source: MemorySource;
  sourceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEdge {
  id: string;
  bankId: string;
  docType: "edge";
  fromId: string;
  toId: string;
  type: MemoryEdgeType;
  createdAt: string;
}

export interface MemoryProfile {
  id: "profile";
  bankId: string;
  docType: "profile";
  skepticism: number;
  literalism: number;
  empathy: number;
  updatedAt: string;
}

export interface ExtractedFact {
  text: string;
  network: MemoryNetwork;
  validFrom?: string;
  validTo?: string;
  mentionedAt?: string;
  entities: string[];
  confidence?: number;
  orgRelevant?: boolean;
}

export interface RecalledFact {
  fact: MemoryFact;
  score: number;
  strategies: string[];
}

export interface RecallResult {
  facts: RecalledFact[];
  citations: string[];
  truncated: boolean;
}

export interface MemoryFactFilters {
  bankId?: string;
  network?: MemoryNetwork;
  entityId?: string;
  query?: string;
  limit?: number;
}
