import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RunUsage {
  usd: number;
}

export interface Correlation {
  traceId: string;
  requestId?: string;
  runId?: string;
  incidentId?: string;
  role: string;
  behaviorVersion?: string;
  /** Aborts the in-flight model call when a request or job hits its deadline. */
  signal?: AbortSignal;
  /** Mutable on purpose: every model call in the scope adds to the same counter. */
  usage?: RunUsage;
}

const store = new AsyncLocalStorage<Correlation>();

export function currentCorrelation(): Correlation {
  return (
    store.getStore() ?? {
      traceId: randomUUID(),
      role: process.env.TASKBRAIN_ROLE ?? "gateway",
    }
  );
}

export function activeCorrelation(): Correlation | undefined {
  return store.getStore();
}

export function withCorrelation<T>(patch: Partial<Correlation>, fn: () => T): T {
  const next = { ...currentCorrelation(), ...patch, traceId: patch.traceId ?? currentCorrelation().traceId };
  return store.run(next, fn);
}
