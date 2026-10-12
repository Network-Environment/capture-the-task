import { envFlag } from "../config";

export const MODEL_ATTEMPT_BUDGET = 3;

const PROTECTED = new Set(["clarification", "policy", "mutation", "recovery", "verification"]);

export function modelRepairEnabled(): boolean {
  return envFlag("MODEL_REPAIR_ENABLED", false);
}

export function verifierShadow(): boolean {
  return envFlag("MODEL_VERIFIER_SHADOW", true);
}

export function preserveModelTier(purpose?: string): boolean {
  return Boolean(purpose && PROTECTED.has(purpose));
}

export function compatibleFallback(task: string, routes: { fallbacks?: Record<string, string> }): string | undefined {
  return routes.fallbacks?.[task];
}

export interface EvidenceChunk {
  sourceId: string;
  text: string;
}

export function chunkEvidence(text: string, sourceId: string, size = 2000): EvidenceChunk[] {
  const chunks: EvidenceChunk[] = [];
  for (let i = 0; i < text.length && chunks.length < 6; i += size) {
    chunks.push({ sourceId: `${sourceId}#${chunks.length + 1}`, text: text.slice(i, i + size) });
  }
  return chunks;
}

export function renderEvidence(chunks: EvidenceChunk[]): string {
  return chunks.map((chunk) => `[${chunk.sourceId}] ${chunk.text}`).join("\n");
}

export interface Verification {
  needed: boolean;
  supported: boolean;
  reason: string;
}

export function verifyResponse(input: {
  risk: "social" | "factual" | "mutation" | "capability";
  body: string;
  sources?: string[];
  toolReceipts?: string[];
  availableTools?: string[];
}): Verification {
  if (input.risk === "social") return { needed: false, supported: true, reason: "low risk" };
  if (input.risk === "mutation") {
    const supported = (input.toolReceipts ?? []).some((receipt) => receipt.length > 0 && !/failed|unknown outcome/i.test(receipt));
    return { needed: true, supported, reason: supported ? "tool receipt present" : "missing tool receipt" };
  }
  if (input.risk === "capability") {
    const named = input.body.match(/`([^`]+)`/g)?.map((item) => item.replace(/`/g, "")) ?? [];
    const supported = named.every((tool) => (input.availableTools ?? []).includes(tool));
    return { needed: true, supported, reason: supported ? "tools exist" : "claimed an unavailable tool" };
  }
  const supported = (input.sources ?? []).length > 0 && !/I don't have a source/i.test(input.body);
  return {
    needed: true,
    supported,
    reason: supported ? "sources attached" : "material claim has no source",
  };
}

export function unsupportedLimitation(reason: string): string {
  return `I can't confirm that from the sources I checked (${reason}). I did not guess.`;
}

export function parseJsonOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
