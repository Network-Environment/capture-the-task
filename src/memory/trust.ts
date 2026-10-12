const INSTRUCTION = /ignore (all|any|previous|prior) instructions|system prompt|you are now/i;

export type TrustSource = "user" | "authoritative" | "inference" | "summary" | "legacy";

const RANK: Record<TrustSource, number> = {
  authoritative: 4,
  user: 3,
  summary: 2,
  inference: 1,
  legacy: 3,
};

export function trustRank(source: TrustSource): number {
  return RANK[source];
}

export function canOverride(existing: TrustSource, incoming: TrustSource): boolean {
  return trustRank(incoming) >= trustRank(existing);
}

export function delimitUntrusted(label: string, text: string): string {
  const cleaned = text
    .split("\n")
    .filter((line) => !INSTRUCTION.test(line))
    .join("\n");
  return `<untrusted ${label}>\n${cleaned}\n</untrusted>`;
}

export interface FactView {
  id: string;
  text: string;
  source: TrustSource;
  subject?: string;
  validTo?: string;
  confidence?: number;
}

export function surfaceConflicts(facts: FactView[], now = Date.now()): { active: FactView[]; conflicts: FactView[][] } {
  const active: FactView[] = [];
  const conflicts: FactView[][] = [];
  const groups = new Map<string, FactView[]>();
  for (const fact of facts) {
    if (fact.validTo && Date.parse(fact.validTo) < now) continue;
    const key = (fact.subject ?? fact.text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length === 1) active.push(group[0]);
    else {
      const ranked = [...group].sort((a, b) => trustRank(b.source) - trustRank(a.source) || (b.confidence ?? 0) - (a.confidence ?? 0));
      active.push(ranked[0]);
      if (new Set(group.map((fact) => fact.text)).size > 1) conflicts.push(group);
    }
  }
  return { active, conflicts };
}

export function decayConfidence(confidence: number, ageDays: number): number {
  return Math.max(0, confidence - ageDays * 0.01);
}
