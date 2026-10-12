import { logEvent } from "./log";

let started = false;

export async function initTelemetry(role: string): Promise<void> {
  if (started) return;
  started = true;
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    logEvent("info", "telemetry_disabled", { role });
    return;
  }
  try {
    const otel = await import("@azure/monitor-opentelemetry");
    otel.useAzureMonitor({ azureMonitorExporterOptions: { connectionString } });
    logEvent("info", "telemetry_started", { role });
  } catch (err) {
    logEvent("warn", "telemetry_unavailable", {
      role,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
