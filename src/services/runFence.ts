import { createHash } from "node:crypto";
import { classifyFailure } from "../runtime/errors";
import { redactText } from "../runtime/redact";
import type { OperationEffect } from "./intent";

export interface MutationRecord {
  key: string;
  tool: string;
  status: "pending" | "completed" | "unknown";
  result?: string;
}

export interface IntentCheckpointResult {
  title: string;
  body: string;
  summaryLine: string;
  tags: string[];
  references?: string[];
}

export interface AgentRunCheckpoint {
  intentId: string;
  messages: Array<{
    role: string;
    content?: string | null;
    tool_calls?: unknown;
    tool_call_id?: string;
  }>;
}

export interface RunCheckpoint {
  runId: string;
  generation: number;
  completedIntents: string[];
  mutations: MutationRecord[];
  intentResults?: Record<string, IntentCheckpointResult>;
  followUpText?: string;
  /** Unfinished tool loop. A retry continues from these messages instead of starting over. */
  agentRun?: AgentRunCheckpoint;
}

export interface MutationLedger {
  checkpoint: RunCheckpoint;
  persist: (next: RunCheckpoint) => Promise<void>;
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

export function intentId(
  index: number,
  intent: { kind: string; standalone: string; captureKind?: string }
): string {
  return `${index}:${intent.kind}:${intent.captureKind ?? ""}:${intent.standalone.slice(0, 120)}`;
}

export function rememberIntent(
  checkpoint: RunCheckpoint,
  intentId: string,
  result: IntentCheckpointResult
): RunCheckpoint {
  return {
    ...completedIntent(checkpoint, intentId),
    intentResults: { ...checkpoint.intentResults, [intentId]: result },
  };
}

export function clearMutation(checkpoint: RunCheckpoint, key: string): RunCheckpoint {
  return { ...checkpoint, mutations: checkpoint.mutations.filter((row) => row.key !== key) };
}

export function sealPendingMutations(checkpoint: RunCheckpoint): RunCheckpoint {
  if (!checkpoint.mutations.some((row) => row.status === "pending")) return checkpoint;
  return {
    ...checkpoint,
    mutations: checkpoint.mutations.map((row) =>
      row.status === "pending" ? { ...row, status: "unknown" as const } : row
    ),
  };
}

export function isUnknownMutation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("may have succeeded");
}

export function isMutatingEffect(effect: OperationEffect): boolean {
  return effect !== "read";
}

async function commitLedger(ledger: MutationLedger, next: RunCheckpoint): Promise<void> {
  ledger.checkpoint = next;
  await ledger.persist(next);
}

export async function guardedMutation(
  ledger: MutationLedger | undefined,
  tool: string,
  args: unknown,
  effect: OperationEffect,
  run: () => Promise<string>
): Promise<string> {
  if (!ledger || !isMutatingEffect(effect)) return run();
  const key = mutationKey(ledger.checkpoint.runId, tool, args);
  const existing = findMutation(ledger.checkpoint, key);
  if (existing?.status === "completed") return existing.result ?? "";
  if (existing?.status === "pending" || existing?.status === "unknown") {
    if (existing.status === "pending") {
      await commitLedger(ledger, recordMutation(ledger.checkpoint, { key, tool, status: "unknown" }));
    }
    throw new Error(`mutation may have succeeded: ${tool}`);
  }
  await commitLedger(ledger, recordMutation(ledger.checkpoint, { key, tool, status: "pending" }));
  let result: string;
  try {
    result = await run();
  } catch (err) {
    const kind = classifyFailure(err);
    if (kind === "permanent") {
      await commitLedger(ledger, clearMutation(ledger.checkpoint, key));
    } else {
      await commitLedger(ledger, recordMutation(ledger.checkpoint, { key, tool, status: "unknown" }));
      throw new Error(`mutation may have succeeded: ${tool}`);
    }
    throw err;
  }
  const completed = recordMutation(ledger.checkpoint, {
    key,
    tool,
    status: "completed",
    result: redactText(result).slice(0, 500),
  });
  try {
    await commitLedger(ledger, completed);
  } catch {
    try {
      await commitLedger(ledger, recordMutation(ledger.checkpoint, { key, tool, status: "unknown" }));
    } catch { /* the stored pending record still blocks a second write */ }
    throw new Error(`mutation may have succeeded: ${tool}`);
  }
  return result;
}

export class RunFencedError extends Error {
  constructor(runId: string) {
    super(`run ${runId} lost the fence`);
    this.name = "RunFencedError";
  }
}
