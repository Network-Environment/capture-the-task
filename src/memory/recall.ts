import { embed } from "../services/router";
import type { ActivityAttribution } from "../services/activityLog";
import { readableBanks } from "./banks";
import { intervalsOverlap, parseQueryWindow } from "./extract";
import {
  citationsOf,
  formatRecallBlock,
  reciprocalRankFusion,
  toRecalled,
  trimToTokenBudget,
} from "./rrf";
import {
  factsByEntityIds,
  keywordSearchFacts,
  memoryFactsEnabled,
  vectorSearchFacts,
} from "./store";
import type { MemoryFact, RecallResult } from "./types";
import { route } from "../services/router";

export async function recallMemory(
  userId: string,
  query: string,
  attribution: Partial<ActivityAttribution> = {}
): Promise<RecallResult> {
  if (!memoryFactsEnabled() || !query.trim()) {
    return { facts: [], citations: [], truncated: false };
  }
  const banks = readableBanks(userId);
  const window = parseQueryWindow(query);
  const factsById = new Map<string, MemoryFact>();
  const collect = (rows: MemoryFact[]) => {
    for (const row of rows) factsById.set(row.id, row);
    return rows.map((row) => row.id);
  };

  let vectorIds: string[] = [];
  try {
    const qv = await embed(query, { ...attribution, trigger: "memory_recall" });
    vectorIds = collect(await vectorSearchFacts(banks, qv, 12));
  } catch (err) {
    console.error("[memory] vector recall failed (non-fatal):", err);
  }

  const keywordIds = collect(await keywordSearchFacts(banks, query, 12).catch(() => []));
  const seedEntities = [...factsById.values()].flatMap((fact) => fact.entityIds);
  const hopIds = collect(
    await factsByEntityIds(banks, [...new Set(seedEntities)].slice(0, 12), 20).catch(() => [])
  );

  let temporalIds: string[] = [];
  if (window.from && window.to) {
    temporalIds = [...factsById.values()]
      .filter((fact) => intervalsOverlap(fact.validFrom, fact.validTo, window.from!, window.to!))
      .map((fact) => fact.id);
    if (!temporalIds.length) {
      const extra = await keywordSearchFacts(banks, window.from, 20).catch(() => []);
      temporalIds = collect(extra).filter((id) => {
        const fact = factsById.get(id);
        return fact && intervalsOverlap(fact.validFrom, fact.validTo ?? fact.mentionedAt, window.from!, window.to!);
      });
    }
  }

  const fused = reciprocalRankFusion([
    { strategy: "vector", ids: vectorIds },
    { strategy: "keyword", ids: keywordIds },
    { strategy: "entity", ids: hopIds },
    ...(temporalIds.length ? [{ strategy: "temporal", ids: temporalIds }] : []),
  ]);
  let ranked = toRecalled(factsById, fused).slice(0, 20);
  ranked = await rerankFacts(query, ranked);
  const trimmed = trimToTokenBudget(ranked);
  return {
    facts: trimmed.facts,
    citations: citationsOf(trimmed.facts),
    truncated: trimmed.truncated,
  };
}

export function recallPromptBlock(result: RecallResult): string {
  const body = formatRecallBlock(result.facts);
  if (!body) return "";
  const cites = result.citations.length ? `\nCitations: ${result.citations.join(", ")}` : "";
  return `${body}${cites}`;
}

async function rerankFacts(
  query: string,
  facts: import("./types").RecalledFact[]
): Promise<import("./types").RecalledFact[]> {
  if (facts.length <= 8) return facts;
  try {
    const res = await route("triage", [
      {
        role: "system",
        content:
          'Rerank memory facts for the query. Output ONLY JSON: {"ids":["id1","id2"]} best-first. Keep all ids.',
      },
      {
        role: "user",
        content:
          `Query: ${query}\n\n` +
          facts.map((hit) => `${hit.fact.id}: ${hit.fact.text}`).join("\n"),
      },
    ], { json: true });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as { ids?: string[] };
    if (!parsed.ids?.length) return facts;
    const byId = new Map(facts.map((hit) => [hit.fact.id, hit]));
    const ordered = parsed.ids.map((id) => byId.get(id)).filter((hit): hit is NonNullable<typeof hit> => Boolean(hit));
    for (const hit of facts) {
      if (!ordered.includes(hit)) ordered.push(hit);
    }
    return ordered;
  } catch {
    return facts;
  }
}
