import type { ExecutionQueue, NudgeChannel, OrgPerson, PrefSource } from "./types";

export const EXECUTION_QUEUES: ExecutionQueue[] = ["teams", "todo", "planner", "smartsheet"];
export const NUDGE_CHANNELS: NudgeChannel[] = [
  "teams_card",
  "teams_chat",
  "imessage",
  "email",
  "silent",
];

const PREF_RANK: Record<PrefSource, number> = { inferred: 1, explicit: 2, admin: 3 };

export function isExecutionQueue(value: string): value is ExecutionQueue {
  return (EXECUTION_QUEUES as string[]).includes(value);
}

export function isNudgeChannel(value: string): value is NudgeChannel {
  return (NUDGE_CHANNELS as string[]).includes(value);
}

export function parseExecutionQueues(raw: unknown): ExecutionQueue[] {
  const items = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/[,\s+]+/)
      : [];
  const seen = new Set<ExecutionQueue>();
  const out: ExecutionQueue[] = [];
  for (const item of items) {
    const q = item.trim().toLowerCase();
    if (!isExecutionQueue(q) || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}

export function defaultQueues(person?: Pick<OrgPerson, "executionQueues">): ExecutionQueue[] {
  return person?.executionQueues?.length ? person.executionQueues : ["teams"];
}

export function canApplyPref(existing: PrefSource | undefined, incoming: PrefSource): boolean {
  if (!existing) return true;
  return PREF_RANK[incoming] >= PREF_RANK[existing];
}

export function workingStyleLine(p: OrgPerson): string {
  const queues = defaultQueues(p).join("+");
  const nudge = p.nudgeChannel && p.nudgeChannel !== "teams_card" ? ` Nudge: ${p.nudgeChannel}.` : "";
  const notes = p.workingNotes ? ` Notes: ${p.workingNotes.slice(0, 240)}` : "";
  return `Work: ${queues} + Teams card.${nudge}${notes}`;
}
