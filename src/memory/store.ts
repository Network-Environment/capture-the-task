import { cosmosContainer } from "../services/cosmos";
import type { ActivityAttribution } from "../services/activityLog";
import { embed } from "../services/router";
import { deterministicEdgeId } from "../graph/validation";
import type {
  MemoryEdge,
  MemoryEdgeType,
  MemoryFact,
  MemoryFactFilters,
  MemoryNetwork,
  MemoryProfile,
  MemorySource,
} from "./types";

function facts() {
  return cosmosContainer("memory-facts");
}

export function memoryFactsEnabled(): boolean {
  return !/^false$/i.test(process.env.MEMORY_FACTS_ENABLED ?? "true");
}

export function clampDisposition(value: number | undefined): number {
  const n = Number.isFinite(value) ? Number(value) : 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

export async function putMemoryFact(
  input: {
    bankId: string;
    network: MemoryNetwork;
    text: string;
    validFrom?: string;
    validTo?: string;
    mentionedAt?: string;
    confidence?: number;
    entityIds: string[];
    source: MemorySource;
    sourceId: string;
    id?: string;
  },
  attribution: Partial<ActivityAttribution> = {}
): Promise<MemoryFact> {
  const now = new Date().toISOString();
  const id = input.id ?? `mf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let createdAt = now;
  if (input.id) {
    try {
      const existing = (await facts().item(id, input.bankId).read<MemoryFact>()).resource;
      if (existing?.createdAt) createdAt = existing.createdAt;
    } catch {
      // new id
    }
  }
  const fact: MemoryFact = {
    id,
    bankId: input.bankId,
    docType: "fact",
    network: input.network,
    text: input.text.slice(0, 1_200),
    validFrom: input.validFrom,
    validTo: input.validTo,
    mentionedAt: input.mentionedAt ?? now,
    confidence: input.confidence,
    entityIds: [...new Set(input.entityIds)].slice(0, 12),
    source: input.source,
    sourceId: input.sourceId,
    createdAt,
    updatedAt: now,
  };
  try {
    fact.embedding = await embed(fact.text, { ...attribution, trigger: "memory_retain" });
  } catch (err) {
    console.error("[memory] embedding failed (non-fatal):", err);
  }
  await facts().items.upsert(fact);
  return fact;
}

export async function putMemoryEdge(
  bankId: string,
  fromId: string,
  toId: string,
  type: MemoryEdgeType
): Promise<MemoryEdge> {
  const id = deterministicEdgeId(fromId, type, toId);
  const edge: MemoryEdge = {
    id,
    bankId,
    docType: "edge",
    fromId,
    toId,
    type,
    createdAt: new Date().toISOString(),
  };
  await facts().items.upsert(edge);
  return edge;
}

export async function vectorSearchFacts(
  bankIds: string[],
  queryVector: number[],
  limit = 12
): Promise<MemoryFact[]> {
  if (!bankIds.length) return [];
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT TOP @limit * FROM c
        WHERE ARRAY_CONTAINS(@banks, c.bankId) AND c.docType = "fact" AND IS_DEFINED(c.embedding)
        ORDER BY VectorDistance(c.embedding, @qv)`,
      parameters: [
        { name: "@limit", value: limit },
        { name: "@banks", value: bankIds },
        { name: "@qv", value: queryVector },
      ],
    })
    .fetchAll();
  return resources;
}

export async function keywordSearchFacts(
  bankIds: string[],
  query: string,
  limit = 12
): Promise<MemoryFact[]> {
  const q = query.trim();
  if (!q || !bankIds.length) return [];
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT TOP @limit * FROM c
        WHERE ARRAY_CONTAINS(@banks, c.bankId) AND c.docType = "fact"
        AND CONTAINS(c.text, @q, true)`,
      parameters: [
        { name: "@limit", value: limit },
        { name: "@banks", value: bankIds },
        { name: "@q", value: q.slice(0, 200) },
      ],
    })
    .fetchAll();
  return resources;
}

export async function factsByEntityIds(
  bankIds: string[],
  entityIds: string[],
  limit = 20
): Promise<MemoryFact[]> {
  if (!bankIds.length || !entityIds.length) return [];
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT TOP @limit * FROM c
        WHERE ARRAY_CONTAINS(@banks, c.bankId) AND c.docType = "fact"
        AND EXISTS(SELECT VALUE e FROM e IN c.entityIds WHERE ARRAY_CONTAINS(@entities, e))`,
      parameters: [
        { name: "@limit", value: limit },
        { name: "@banks", value: bankIds },
        { name: "@entities", value: entityIds },
      ],
    })
    .fetchAll();
  return resources;
}

export async function listMemoryFacts(filters: MemoryFactFilters = {}): Promise<MemoryFact[]> {
  const clauses = ['c.docType = "fact"'];
  const parameters: { name: string; value: string | number }[] = [
    { name: "@limit", value: Math.max(1, Math.min(100, filters.limit ?? 40)) },
  ];
  if (filters.bankId) {
    clauses.push("c.bankId = @bankId");
    parameters.push({ name: "@bankId", value: filters.bankId });
  }
  if (filters.network) {
    clauses.push("c.network = @network");
    parameters.push({ name: "@network", value: filters.network });
  }
  if (filters.entityId) {
    clauses.push("ARRAY_CONTAINS(c.entityIds, @entityId)");
    parameters.push({ name: "@entityId", value: filters.entityId });
  }
  if (filters.query?.trim()) {
    clauses.push("CONTAINS(c.text, @q, true)");
    parameters.push({ name: "@q", value: filters.query.trim().slice(0, 200) });
  }
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT TOP @limit * FROM c WHERE ${clauses.join(" AND ")} ORDER BY c.mentionedAt DESC`,
      parameters,
    })
    .fetchAll();
  return resources;
}

export async function getMemoryProfile(bankId: string): Promise<MemoryProfile> {
  try {
    const { resource } = await facts().item("profile", bankId).read<MemoryProfile>();
    if (resource?.docType === "profile") {
      return {
        ...resource,
        skepticism: clampDisposition(resource.skepticism),
        literalism: clampDisposition(resource.literalism),
        empathy: clampDisposition(resource.empathy),
      };
    }
  } catch {
    // default
  }
  return {
    id: "profile",
    bankId,
    docType: "profile",
    skepticism: 3,
    literalism: 3,
    empathy: 3,
    updatedAt: new Date().toISOString(),
  };
}

export async function upsertMemoryProfile(
  bankId: string,
  patch: Partial<Pick<MemoryProfile, "skepticism" | "literalism" | "empathy">>
): Promise<MemoryProfile> {
  const current = await getMemoryProfile(bankId);
  const next: MemoryProfile = {
    ...current,
    skepticism: clampDisposition(patch.skepticism ?? current.skepticism),
    literalism: clampDisposition(patch.literalism ?? current.literalism),
    empathy: clampDisposition(patch.empathy ?? current.empathy),
    updatedAt: new Date().toISOString(),
  };
  await facts().items.upsert(next);
  return next;
}

export async function opinionFactsForText(
  bankId: string,
  entityIds: string[]
): Promise<MemoryFact[]> {
  if (!entityIds.length) return [];
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT * FROM c WHERE c.bankId = @bank AND c.docType = "fact" AND c.network = "opinion"
        AND EXISTS(SELECT VALUE e FROM e IN c.entityIds WHERE ARRAY_CONTAINS(@entities, e))`,
      parameters: [
        { name: "@bank", value: bankId },
        { name: "@entities", value: entityIds },
      ],
    })
    .fetchAll();
  return resources;
}

export async function recentFactsForEntity(
  bankId: string,
  entityId: string,
  sinceIso?: string,
  limit = 20
): Promise<MemoryFact[]> {
  const clauses = [
    "c.bankId = @bank",
    'c.docType = "fact"',
    "ARRAY_CONTAINS(c.entityIds, @entity)",
    'c.network != "observation"',
  ];
  const parameters: { name: string; value: string | number }[] = [
    { name: "@bank", value: bankId },
    { name: "@entity", value: entityId },
    { name: "@limit", value: limit },
  ];
  if (sinceIso) {
    clauses.push("c.createdAt > @since");
    parameters.push({ name: "@since", value: sinceIso });
  }
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT TOP @limit * FROM c WHERE ${clauses.join(" AND ")} ORDER BY c.createdAt DESC`,
      parameters,
    })
    .fetchAll();
  return resources;
}

export async function observationForEntity(
  bankId: string,
  entityId: string
): Promise<MemoryFact | undefined> {
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT TOP 1 * FROM c WHERE c.bankId = @bank AND c.docType = "fact"
        AND c.network = "observation" AND ARRAY_CONTAINS(c.entityIds, @entity)
        ORDER BY c.updatedAt DESC`,
      parameters: [
        { name: "@bank", value: bankId },
        { name: "@entity", value: entityId },
      ],
    })
    .fetchAll();
  return resources[0];
}

export async function recentBankFacts(bankId: string, limit = 80): Promise<MemoryFact[]> {
  const { resources } = await facts().items
    .query<MemoryFact>({
      query: `SELECT TOP @limit * FROM c WHERE c.bankId = @bank AND c.docType = "fact"
        AND c.network != "observation" ORDER BY c.createdAt DESC`,
      parameters: [
        { name: "@bank", value: bankId },
        { name: "@limit", value: limit },
      ],
    })
    .fetchAll();
  return resources;
}
