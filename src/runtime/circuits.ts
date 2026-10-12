export interface CircuitSnapshot {
  name: string;
  state: "closed" | "open" | "half_open";
  failures: number;
  openedAt?: string;
}

const FAILURES = 3;
const OPEN_MS = 60_000;
const circuits = new Map<string, { failures: number; openedAt: number; halfOpen: boolean }>();

export function circuitSnapshot(): CircuitSnapshot[] {
  return [...circuits.entries()].map(([name, row]) => ({
    name,
    state: row.halfOpen ? "half_open" : row.openedAt && Date.now() - row.openedAt < OPEN_MS ? "open" : "closed",
    failures: row.failures,
    ...(row.openedAt ? { openedAt: new Date(row.openedAt).toISOString() } : {}),
  }));
}

export function circuitAllows(name: string, now = Date.now()): boolean {
  const row = circuits.get(name);
  if (!row?.openedAt) return true;
  if (now - row.openedAt >= OPEN_MS) {
    row.halfOpen = true;
    return true;
  }
  return false;
}

export function circuitSuccess(name: string): void {
  circuits.set(name, { failures: 0, openedAt: 0, halfOpen: false });
}

export function circuitFailure(name: string, now = Date.now()): void {
  const row = circuits.get(name) ?? { failures: 0, openedAt: 0, halfOpen: false };
  row.failures += 1;
  if (row.failures >= FAILURES) row.openedAt = now;
  row.halfOpen = false;
  circuits.set(name, row);
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`dependency circuit open: ${name}`);
    this.name = "CircuitOpenError";
  }
}

export async function withCircuit<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!circuitAllows(name)) throw new CircuitOpenError(name);
  try {
    const value = await work();
    circuitSuccess(name);
    return value;
  } catch (err) {
    circuitFailure(name);
    throw err;
  }
}

export function resetCircuits(): void {
  circuits.clear();
}
