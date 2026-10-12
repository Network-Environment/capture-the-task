export type FailureClass = "transient" | "permanent" | "deadline" | "unknown_outcome";

const TRANSIENT_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

export function classifyFailure(
  err: unknown,
  opts: { mutating?: boolean } = {}
): FailureClass {
  if (err instanceof Error && (err.name === "RequestDeadline" || err.name === "AbortError")) {
    return opts.mutating ? "unknown_outcome" : "deadline";
  }
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = Number(
    (err as { status?: number; statusCode?: number; code?: number }).status ??
      (err as { statusCode?: number }).statusCode ??
      (err as { code?: number }).code
  );
  if (message.includes("unknown outcome") || message.includes("may have succeeded")) {
    return "unknown_outcome";
  }
  if (message.includes("deadline") || message.includes("aborted")) {
    return opts.mutating ? "unknown_outcome" : "deadline";
  }
  const transient =
    TRANSIENT_CODES.has(status) ||
    /429|rate limit|timeout|timed out|econnreset|fetch failed|socket hang up|temporarily/.test(message);
  if (transient) return opts.mutating ? "unknown_outcome" : "transient";
  return "permanent";
}

export function retryable(kind: FailureClass): boolean {
  return kind === "transient";
}
