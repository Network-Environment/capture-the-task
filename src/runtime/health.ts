import { circuitSnapshot } from "./circuits";
import { metricSnapshot } from "./metrics";

export interface Heartbeat {
  name: string;
  at: number;
  maxAgeMs: number;
}

const beats = new Map<string, Heartbeat>();
let cosmosReady: { ok: boolean; checkedAt: number; detail?: string } = {
  ok: false,
  checkedAt: 0,
  detail: "not checked",
};

export function beat(name: string, maxAgeMs: number): void {
  beats.set(name, { name, at: Date.now(), maxAgeMs });
}

export function noteCosmosReady(ok: boolean, detail?: string): void {
  cosmosReady = { ok, checkedAt: Date.now(), detail };
}

export function liveness(role: string): { ok: true; role: string; cosmosConfigured: boolean } {
  return {
    ok: true,
    role,
    cosmosConfigured: Boolean(process.env.COSMOS_ENDPOINT && process.env.COSMOS_KEY),
  };
}

export function readiness(role: string, now = Date.now()): {
  ok: boolean;
  role: string;
  cosmos: { ok: boolean; ageMs: number; detail?: string };
  heartbeats: Array<Heartbeat & { stale: boolean }>;
  circuits: ReturnType<typeof circuitSnapshot>;
  metrics: Record<string, number>;
} {
  const heartbeats = [...beats.values()].map((row) => ({
    ...row,
    stale: now - row.at > row.maxAgeMs,
  }));
  const cosmosAge = cosmosReady.checkedAt ? now - cosmosReady.checkedAt : Number.POSITIVE_INFINITY;
  const cosmosFresh = cosmosReady.ok && cosmosAge < 60_000;
  const ok = cosmosFresh && heartbeats.every((row) => !row.stale);
  return {
    ok,
    role,
    cosmos: { ok: cosmosReady.ok, ageMs: Number.isFinite(cosmosAge) ? cosmosAge : -1, detail: cosmosReady.detail },
    heartbeats,
    circuits: circuitSnapshot(),
    metrics: metricSnapshot(),
  };
}
