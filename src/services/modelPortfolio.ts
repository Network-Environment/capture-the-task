export interface ModelDeployment {
  tier: "cheap" | "standard" | "premium" | "embed";
  deployment: string;
  model: string;
  version: string;
  independent: boolean;
  sku: string;
  region: string;
}

export interface ModelCandidate {
  model: string;
  version: string;
  inputPerMillion: number;
  outputPerMillion: number;
  latencyMs: number;
  quality: number;
  toolReliability: number;
  contextTokens: number;
  retired: boolean;
  regionAllowed: boolean;
}

export type PortfolioAction = "keep" | "test" | "upgrade" | "downgrade" | "split_route" | "retire";

export const SEEDED_DEPLOYMENTS: ModelDeployment[] = [
  { tier: "cheap", deployment: "cheap", model: "gpt-4.1-mini", version: "2025-04-14", independent: true, sku: "GlobalStandard", region: "eastus" },
  { tier: "standard", deployment: "standard", model: "gpt-5-mini", version: "2025-08-07", independent: true, sku: "GlobalStandard", region: "eastus" },
  { tier: "premium", deployment: "standard", model: "gpt-5-mini", version: "2025-08-07", independent: false, sku: "GlobalStandard", region: "eastus" },
  { tier: "embed", deployment: "embed", model: "text-embedding-3-small", version: "1", independent: true, sku: "GlobalStandard", region: "eastus" },
];

const WORKLOAD_WEIGHTS: Record<string, { quality: number; latency: number; cost: number; tools: number }> = {
  triage: { quality: 0.3, latency: 0.4, cost: 0.3, tools: 0 },
  ack: { quality: 0.2, latency: 0.5, cost: 0.3, tools: 0 },
  agent: { quality: 0.35, latency: 0.15, cost: 0.15, tools: 0.35 },
  synthesis: { quality: 0.55, latency: 0.15, cost: 0.15, tools: 0.15 },
  digest: { quality: 0.5, latency: 0.1, cost: 0.15, tools: 0.25 },
  embed: { quality: 0.7, latency: 0.1, cost: 0.2, tools: 0 },
};

export function costPerSuccess(candidate: ModelCandidate, attempts = 1, outputTokens = 500, inputTokens = 1000): number {
  const calls = Math.max(1, attempts);
  const input = (inputTokens / 1_000_000) * candidate.inputPerMillion;
  const output = (outputTokens / 1_000_000) * candidate.outputPerMillion;
  return (input + output) * calls;
}

export function recommendModel(input: {
  workload: string;
  current: ModelCandidate;
  candidates: ModelCandidate[];
  qualityFloor: number;
}): { action: PortfolioAction; model?: string; reason: string } {
  const weights = WORKLOAD_WEIGHTS[input.workload] ?? WORKLOAD_WEIGHTS.agent;
  if (input.current.retired) {
    return { action: "retire", reason: `${input.current.model} is retired or unavailable` };
  }
  const score = (candidate: ModelCandidate) => {
    if (candidate.retired || !candidate.regionAllowed || candidate.quality < input.qualityFloor) return -1;
    const cost = costPerSuccess(candidate);
    const currentCost = Math.max(0.000001, costPerSuccess(input.current));
    const costScore = Math.max(0, 1 - cost / (currentCost * 2));
    const latencyScore = Math.max(0, 1 - candidate.latencyMs / 8000);
    return (
      weights.quality * candidate.quality +
      weights.tools * candidate.toolReliability +
      weights.latency * latencyScore +
      weights.cost * costScore
    );
  };
  const ranked = input.candidates
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return { action: "keep", reason: "no eligible candidate clears the quality floor" };
  const currentScore = score(input.current);
  if (best.candidate.model === input.current.model && best.candidate.version === input.current.version) {
    return { action: "keep", reason: "current model remains the best eligible option" };
  }
  if (best.score < currentScore + 0.05) {
    return { action: "keep", reason: "the gain is too small to justify a change" };
  }
  const cheaper = costPerSuccess(best.candidate) < costPerSuccess(input.current) * 0.8;
  const stronger = best.candidate.quality > input.current.quality + 0.03;
  if (input.workload === "agent" && stronger && cheaper) {
    return { action: "split_route", model: best.candidate.model, reason: "a different model is better for tool routing than for cheap triage" };
  }
  return {
    action: stronger ? "upgrade" : cheaper ? "downgrade" : "test",
    model: best.candidate.model,
    reason: `projected score ${best.score.toFixed(2)} versus ${currentScore.toFixed(2)}, including retries and cost per success`,
  };
}

export function deploymentInventory(env: NodeJS.ProcessEnv = process.env): ModelDeployment[] {
  return SEEDED_DEPLOYMENTS.map((row) => ({
    ...row,
    deployment: env[`${row.tier === "embed" ? "EMBED" : row.tier.toUpperCase()}_DEPLOYMENT`] || row.deployment,
  }));
}
