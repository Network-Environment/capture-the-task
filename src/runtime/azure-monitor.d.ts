declare module "@azure/monitor-opentelemetry" {
  export function useAzureMonitor(options?: {
    azureMonitorExporterOptions?: { connectionString?: string };
  }): void;
}
