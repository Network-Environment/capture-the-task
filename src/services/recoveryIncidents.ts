import { createHash } from "node:crypto";
import { envFlag } from "../config";
import { redactUnknown } from "../runtime/redact";
import { cosmosContainer } from "./cosmos";

export type IncidentStatus = "open" | "resolved" | "dismissed";

export interface RecoveryIncident {
  id: string;
  shard: string;
  source: string;
  subject: string;
  status: IncidentStatus;
  kind: string;
  summary: string;
  requestId?: string;
  traceId?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  note?: string;
  actor?: string;
  ttl: number;
}

function incidents() {
  return cosmosContainer("recovery-incidents");
}

export function incidentId(source: string, subject: string): string {
  return `inc-${createHash("sha256").update(`${source}:${subject}`).digest("hex").slice(0, 24)}`;
}

function shardFor(id: string): string {
  return id.slice(4, 6);
}

export function incidentsEnabled(): boolean {
  return envFlag("RECOVERY_INCIDENTS_ENABLED", true);
}

export async function openIncident(input: {
  source: string;
  subject: string;
  kind: string;
  summary: string;
  requestId?: string;
  traceId?: string;
  runId?: string;
}): Promise<RecoveryIncident | undefined> {
  if (!incidentsEnabled()) return undefined;
  const id = incidentId(input.source, input.subject);
  const now = new Date().toISOString();
  const doc: RecoveryIncident = {
    id,
    shard: shardFor(id),
    source: input.source,
    subject: input.subject,
    status: "open",
    kind: input.kind,
    summary: String(redactUnknown(input.summary) ?? "").slice(0, 500),
    requestId: input.requestId,
    traceId: input.traceId,
    runId: input.runId,
    createdAt: now,
    updatedAt: now,
    ttl: 30 * 24 * 60 * 60,
  };
  try {
    const { resource } = await incidents().items.create(doc);
    return (resource as RecoveryIncident | undefined) ?? doc;
  } catch (err) {
    if ((err as { code?: number }).code === 409) {
      const { resource } = await incidents().item(id, doc.shard).read<RecoveryIncident>();
      return resource ?? doc;
    }
    console.error("[recovery] incident create failed:", (err as Error).message);
    return undefined;
  }
}

export async function resolveIncident(
  source: string,
  subject: string,
  status: "resolved" | "dismissed" = "resolved",
  note?: string,
  actor?: string
): Promise<void> {
  const id = incidentId(source, subject);
  const shard = shardFor(id);
  try {
    const { resource } = await incidents().item(id, shard).read<RecoveryIncident>();
    if (!resource) return;
    await incidents().item(id, shard).replace({
      ...resource,
      status,
      note: note?.slice(0, 500),
      actor,
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[recovery] incident resolve failed:", (err as Error).message);
  }
}

export async function listOpenIncidents(limit = 50): Promise<RecoveryIncident[]> {
  try {
    const { resources } = await incidents()
      .items.query<RecoveryIncident>({
        query: "SELECT TOP @n * FROM c WHERE c.status = 'open' ORDER BY c.createdAt DESC",
        parameters: [{ name: "@n", value: limit }],
      })
      .fetchAll();
    return resources;
  } catch {
    return [];
  }
}
