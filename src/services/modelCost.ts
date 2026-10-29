/**
 * List prices in USD per million tokens, keyed by Foundry deployment name and
 * by model id. Deployment names match infra/main.bicep (`cheap`, `standard`,
 * `embed`). Update these when a deployment is pointed at a different model.
 */
const RATES: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  cheap: { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  standard: { inputPerMillion: 0.25, outputPerMillion: 2 },
  premium: { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  embed: { inputPerMillion: 0.02, outputPerMillion: 0 },
  "text-embedding-3-small": { inputPerMillion: 0.02, outputPerMillion: 0 },
};

export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const rate = RATES[model];
  if (!rate) return undefined;
  const input = Math.max(0, inputTokens) / 1_000_000 * rate.inputPerMillion;
  const output = Math.max(0, outputTokens) / 1_000_000 * rate.outputPerMillion;
  return input + output;
}

export function runCostCeilingUsd(): number {
  const ceiling = Number(process.env.RUN_COST_CEILING_USD ?? 2);
  return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 0;
}

/** Adds the call to the run counter. Returns true when the run should stop. */
export function addRunCost(usage: { usd: number } | undefined, cost: number | undefined): boolean {
  if (!usage || cost == null || !Number.isFinite(cost)) return false;
  usage.usd += cost;
  const ceiling = runCostCeilingUsd();
  return ceiling > 0 && usage.usd > ceiling;
}
