import { cosmosContainer } from "../services/cosmos";
import type { WorkAssignment, WorkStatus } from "./types";

function work() {
  return cosmosContainer("work");
}

export async function upsertWork(doc: WorkAssignment): Promise<WorkAssignment> {
  const { resource } = await work().items.upsert(doc);
  return resource as unknown as WorkAssignment;
}

export async function getWork(id: string, ownerPersonId: string): Promise<WorkAssignment | undefined> {
  try {
    const { resource } = await work().item(id, ownerPersonId).read<WorkAssignment>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

export async function findWork(id: string): Promise<WorkAssignment | undefined> {
  const { resources } = await work()
    .items.query<WorkAssignment>({
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }],
    })
    .fetchAll();
  return resources[0];
}

export async function findWorkBySource(sourceId: string): Promise<WorkAssignment | undefined> {
  const { resources } = await work()
    .items.query<WorkAssignment>({
      query: "SELECT * FROM c WHERE c.sourceId = @s",
      parameters: [{ name: "@s", value: sourceId }],
    })
    .fetchAll();
  return resources[0];
}

export async function listOpenWork(ownerPersonId?: string): Promise<WorkAssignment[]> {
  const query = ownerPersonId
    ? {
        query: "SELECT * FROM c WHERE c.ownerPersonId = @o AND c.status IN ('open', 'accepted')",
        parameters: [{ name: "@o", value: ownerPersonId }],
      }
    : { query: "SELECT * FROM c WHERE c.status IN ('open', 'accepted')" };
  const { resources } = await work().items.query<WorkAssignment>(query).fetchAll();
  return resources;
}

export async function listRecentWork(
  since: string,
  ownerPersonId?: string
): Promise<WorkAssignment[]> {
  const clauses = ["c.createdAt >= @since"];
  const parameters: { name: string; value: string }[] = [
    { name: "@since", value: since },
  ];
  if (ownerPersonId) {
    clauses.push("c.ownerPersonId = @owner");
    parameters.push({ name: "@owner", value: ownerPersonId });
  }
  const { resources } = await work().items
    .query<WorkAssignment>({
      query: `SELECT * FROM c WHERE ${clauses.join(" AND ")}`,
      parameters,
    })
    .fetchAll();
  return resources;
}

export async function listOverdueWork(now = Date.now()): Promise<WorkAssignment[]> {
  const open = await listOpenWork();
  return open.filter((w) => {
    if (!w.due) return false;
    const t = Date.parse(w.due.length <= 10 ? `${w.due}T17:00:00` : w.due);
    return Number.isFinite(t) && t < now;
  });
}

export async function setWorkStatus(
  doc: WorkAssignment,
  status: WorkStatus
): Promise<WorkAssignment> {
  return upsertWork({ ...doc, status, updatedAt: new Date().toISOString() });
}
