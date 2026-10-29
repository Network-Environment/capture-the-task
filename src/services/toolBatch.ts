import { operationMetadata } from "../tools/registry";

/** Reads can run together. Writes, and tools that take over the reply, cannot. */
export function isParallelRead(name: string): boolean {
  if (name === "ask_user" || name === "note_unmet_request") return false;
  return operationMetadata(name).effect === "read";
}

export function toolWaves<T extends { name: string }>(calls: T[]): T[][] {
  const waves: T[][] = [];
  for (const call of calls) {
    const last = waves[waves.length - 1];
    if (last && isParallelRead(call.name) && last.every((item) => isParallelRead(item.name))) {
      last.push(call);
    } else {
      waves.push([call]);
    }
  }
  return waves;
}
