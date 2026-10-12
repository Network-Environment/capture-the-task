import { createHash } from "node:crypto";

export interface MutationRecord {
  key: string;
  tool: string;
  status: "pending" | "completed" | "unknown";
  result?: string;
}

export interface RunCheckpoint {
  runId: string;
  generation: number;
  completedIntents: string[];
  mutations: MutationRecord[];
  followUpText?: string;
}

export function mutationKey(runId: string, tool: string, args: unknown): string {
  return createHash("sha256")
    .update(`${runId}:${tool}:${JSON.stringify(args)}`)
    .digest("hex")
    .slice(0, 24);
}

export function findMutation(checkpoint: RunCheckpoint | undefined, key: string): MutationRecord | undefined {
  return checkpoint?.mutations.find((row) => row.key === key);
}

export function recordMutation(checkpoint: RunCheckpoint, record: MutationRecord): RunCheckpoint {
  const mutations = checkpoint.mutations.filter((row) => row.key !== record.key);
  return { ...checkpoint, mutations: [...mutations, record] };
}

export function completedIntent(checkpoint: RunCheckpoint, intentId: string): RunCheckpoint {
  if (checkpoint.completedIntents.includes(intentId)) return checkpoint;
  return { ...checkpoint, completedIntents: [...checkpoint.completedIntents, intentId] };
}

export class RunFencedError extends Error {
  constructor(runId: string) {
    super(`run ${runId} lost the fence`);
    this.name = "RunFencedError";
  }
}
