import { currentCorrelation } from "./correlation";
import { redactUnknown } from "./redact";

export type LogLevel = "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const correlation = currentCorrelation();
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    event,
    role: correlation.role,
    traceId: correlation.traceId,
    requestId: correlation.requestId,
    runId: correlation.runId,
    incidentId: correlation.incidentId,
    ...redactUnknown(fields) as Record<string, unknown>,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
