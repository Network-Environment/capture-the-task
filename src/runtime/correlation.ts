import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface Correlation {
  traceId: string;
  requestId?: string;
  runId?: string;
  incidentId?: string;
  role: string;
  behaviorVersion?: string;
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

export function withCorrelation<T>(patch: Partial<Correlation>, fn: () => T): T {
  const next = { ...currentCorrelation(), ...patch, traceId: patch.traceId ?? currentCorrelation().traceId };
  return store.run(next, fn);
}
