import type { MemoryFact, RecalledFact } from "./types";

const RRF_K = 60;
export const MEMORY_TOKEN_BUDGET = 1_500;

export function reciprocalRankFusion(
  ranked: Array<{ strategy: string; ids: string[] }>,
  k = RRF_K
): Map<string, { score: number; strategies: string[] }> {
  const fused = new Map<string, { score: number; strategies: string[] }>();
  for (const list of ranked) {
    list.ids.forEach((id, index) => {
      const current = fused.get(id) ?? { score: 0, strategies: [] };
      current.score += 1 / (k + index + 1);
      if (!current.strategies.includes(list.strategy)) current.strategies.push(list.strategy);
      fused.set(id, current);
    });
  }
  return fused;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function trimToTokenBudget(
  facts: RecalledFact[],
  budget = MEMORY_TOKEN_BUDGET
): { facts: RecalledFact[]; truncated: boolean } {
  const kept: RecalledFact[] = [];
  let used = 0;
  for (const hit of facts) {
    const cost = estimateTokens(hit.fact.text);
    if (kept.length && used + cost > budget) {
      return { facts: kept, truncated: true };
    }
    kept.push(hit);
    used += cost;
  }
  return { facts: kept, truncated: false };
}

export function formatRecallBlock(facts: RecalledFact[]): string {
  if (!facts.length) return "";
  return facts
    .map((hit) => {
      const fact = hit.fact;
      const range = [fact.validFrom?.slice(0, 10), fact.validTo?.slice(0, 10)]
        .filter(Boolean)
        .join("–");
      return (
        `[${fact.network} | ${fact.source}:${fact.sourceId}` +
        `${range ? ` | ${range}` : ""} | ${fact.mentionedAt.slice(0, 10)}]\n${fact.text}`
      );
    })
    .join("\n---\n");
}

export function citationsOf(facts: RecalledFact[]): string[] {
  return [...new Set(facts.map((hit) => `${hit.fact.source}:${hit.fact.sourceId}`))];
}

export function toRecalled(
  factsById: Map<string, MemoryFact>,
  fused: Map<string, { score: number; strategies: string[] }>
): RecalledFact[] {
  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([id, meta]) => {
      const fact = factsById.get(id);
      return fact ? { fact, score: meta.score, strategies: meta.strategies } : undefined;
    })
    .filter((hit): hit is RecalledFact => Boolean(hit));
}
