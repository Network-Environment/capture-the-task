import { loadConfig } from "../config";
import { graphAppFetch } from "../work/graphApp";

export interface ConnectorProbe {
  name: string;
  status: "ready" | "error" | "not_configured";
  note: string;
}

let cache: { at: number; rows: ConnectorProbe[] } | undefined;

/**
 * Live checks run only on App Service, where managed identity is available,
 * and the result is cached for a minute so the admin page does not probe on
 * every refresh.
 */
export async function liveConnectorProbes(): Promise<ConnectorProbe[]> {
  if (!process.env.WEBSITE_INSTANCE_ID) return [];
  if (cache && Date.now() - cache.at < 60_000) return cache.rows;
  const rows = await Promise.all([probeGraph(), Promise.resolve(plaudConfigProbe())]);
  cache = { at: Date.now(), rows };
  return rows;
}

async function probeGraph(): Promise<ConnectorProbe> {
  try {
    const res = await graphAppFetch("/organization?$select=id&$top=1", {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) return { name: "Graph application", status: "ready", note: "organization read succeeded" };
    return { name: "Graph application", status: "error", note: `HTTP ${res.status}` };
  } catch (err) {
    return {
      name: "Graph application",
      status: "error",
      note: (err instanceof Error ? err.message : String(err)).slice(0, 140),
    };
  }
}

function plaudConfigProbe(): ConnectorProbe {
  try {
    const config = loadConfig<{ accounts?: unknown[] }>("plaud-accounts");
    const count = config.accounts?.length ?? 0;
    return count
      ? { name: "Plaud", status: "ready", note: `${count} account(s) configured` }
      : { name: "Plaud", status: "not_configured", note: "no accounts in config" };
  } catch {
    return { name: "Plaud", status: "not_configured", note: "config unavailable" };
  }
}
