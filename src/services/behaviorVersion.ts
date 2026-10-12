import { createHash } from "node:crypto";
import { loadConfig, PRODUCTION_FLAG_DEFAULTS } from "../config";

export interface BehaviorManifest {
  version: string;
  files: Record<string, string>;
  flags: Record<string, boolean>;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function currentBehaviorManifest(): BehaviorManifest {
  const files = {
    agents: hash(loadConfig("agents")),
    routes: hash(loadConfig("model.routes")),
    skills: hash(loadConfig("skills")),
  };
  const flags = { ...PRODUCTION_FLAG_DEFAULTS };
  const version = hash({ files, flags });
  return { version, files, flags };
}

export interface EvalTrial {
  name: string;
  passed: boolean;
}

export function wilsonLowerBound(passed: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = passed / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denom);
}

export function promotionAllowed(candidate: EvalTrial[], baseline: EvalTrial[], floor = 0.8): {
  allowed: boolean;
  candidate: number;
  baseline: number;
  reason: string;
} {
  const candidateScore = wilsonLowerBound(candidate.filter((row) => row.passed).length, candidate.length);
  const baselineScore = wilsonLowerBound(baseline.filter((row) => row.passed).length, baseline.length);
  if (candidateScore < floor) {
    return { allowed: false, candidate: candidateScore, baseline: baselineScore, reason: "below safety floor" };
  }
  if (candidateScore + 0.001 < baselineScore) {
    return { allowed: false, candidate: candidateScore, baseline: baselineScore, reason: "regresses against baseline" };
  }
  return { allowed: true, candidate: candidateScore, baseline: baselineScore, reason: "meets gate" };
}

export interface CanaryMetrics {
  policyViolations: number;
  correctionRate: number;
  quarantineRate: number;
  groundedness: number;
}

export function canaryShouldRollback(metrics: CanaryMetrics): boolean {
  return (
    metrics.policyViolations > 0 ||
    metrics.correctionRate > 0.25 ||
    metrics.quarantineRate > 0.2 ||
    metrics.groundedness < 0.8
  );
}
