import { listOpenOwnedGraphNodes } from "../graph/store";
import type { GraphNode } from "../graph/types";
import { listOpenCommitments } from "../meetings/store";
import type { CommitmentDoc } from "../meetings/types";
import { listOpenOwnedPmoItems } from "../pmo/store";
import type { PmoBoard, PmoItem } from "../pmo/types";
import { listOpenWork } from "../work/store";
import type { WorkAssignment } from "../work/types";
import type { OrgPerson } from "./types";

export const WORKLOAD_ITEM_CAP = 8;
export const STRETCHED_OPEN_COUNT = 6;

export type WorkloadSource = "work" | "commitment" | "graph" | "pmo";

export interface WorkloadItem {
  source: WorkloadSource;
  id: string;
  title: string;
  due?: string;
  status?: string;
  updatedAt?: string;
  lastProgressAt?: string;
  effort?: 1 | 2 | 3 | 5 | 8;
  ownerPersonId?: string;
  workId?: string;
  sourceKind?: string;
  sourceId?: string;
}

export interface PersonWorkload {
  items: WorkloadItem[];
  counts: Record<WorkloadSource, number>;
}

export interface WorkloadInputs {
  work: WorkAssignment[];
  commitments: CommitmentDoc[];
  graph: GraphNode[];
  pmo: { item: PmoItem; board: PmoBoard }[];
}

export function assembleWorkload(inputs: WorkloadInputs): PersonWorkload {
  const workItems: WorkloadItem[] = inputs.work.map((row) => ({
    source: "work",
    id: row.id,
    title: row.title,
    due: row.due,
    status: row.status,
    updatedAt: row.updatedAt,
    lastProgressAt: row.lastProgressAt,
    effort: row.effort,
    ownerPersonId: row.ownerPersonId,
    workId: row.id,
    sourceId: row.sourceId,
  }));
  const workIds = new Set(workItems.map((item) => item.id));
  const workSourceIds = new Set(workItems.map((item) => item.sourceId).filter(Boolean) as string[]);

  const commitmentItems: WorkloadItem[] = inputs.commitments
    .filter((row) => row.status === "open")
    .map((row) => ({
      source: "commitment",
      id: row.id,
      title: row.text,
      due: row.due,
      status: row.status,
      updatedAt: row.updatedAt,
      lastProgressAt: row.lastProgressAt,
      ownerPersonId: row.personId,
      sourceKind: "commitment",
      sourceId: row.id,
    }));
  const commitmentIds = new Set(commitmentItems.map((item) => item.id));

  const pmoItems: WorkloadItem[] = [];
  for (const { item, board } of inputs.pmo) {
    if (item.workId && workIds.has(item.workId)) continue;
    pmoItems.push({
      source: "pmo",
      id: item.id,
      title: `${item.title} (${board.title})`,
      due: item.due,
      status: board.columns.find((column) => column.id === item.columnId)?.label ?? item.columnId,
      updatedAt: item.updatedAt,
      lastProgressAt: item.lastProgressAt,
      ownerPersonId: item.ownerPersonId,
      workId: item.workId,
      sourceId: board.id,
    });
  }

  const graphItems: WorkloadItem[] = [];
  for (const node of inputs.graph) {
    if (node.source?.kind === "commitment" && commitmentIds.has(node.source.id)) continue;
    if (node.source?.kind === "commitment" && workSourceIds.has(node.source.id)) continue;
    graphItems.push({
      source: "graph",
      id: node.id,
      title: node.title,
      due: node.due,
      status: node.status,
      updatedAt: node.updatedAt,
      lastProgressAt: node.lastProgressAt,
      effort: node.effort,
      ownerPersonId: node.ownerPersonId,
      sourceKind: node.source?.kind,
      sourceId: node.source?.id,
    });
  }

  const items = [
    ...workItems.slice(0, WORKLOAD_ITEM_CAP),
    ...commitmentItems.slice(0, WORKLOAD_ITEM_CAP),
    ...graphItems.slice(0, WORKLOAD_ITEM_CAP),
    ...pmoItems.slice(0, WORKLOAD_ITEM_CAP),
  ];
  return {
    items,
    counts: {
      work: workItems.length,
      commitment: commitmentItems.length,
      graph: graphItems.length,
      pmo: pmoItems.length,
    },
  };
}

export async function personWorkload(personId: string): Promise<PersonWorkload> {
  const [work, commitments, graph, pmo] = await Promise.all([
    listOpenWork(personId).catch(() => [] as WorkAssignment[]),
    listOpenCommitments()
      .then((rows) => rows.filter((row) => row.personId === personId && row.status === "open"))
      .catch(() => [] as CommitmentDoc[]),
    listOpenOwnedGraphNodes(personId).catch(() => [] as GraphNode[]),
    listOpenOwnedPmoItems(personId).catch(() => [] as { item: PmoItem; board: PmoBoard }[]),
  ]);
  return assembleWorkload({ work, commitments, graph, pmo });
}

export function plateCountsLine(load: PersonWorkload): string {
  return `On plate: ${load.counts.work} work, ${load.counts.commitment} commitments, ${load.counts.graph} graph, ${load.counts.pmo} PMO`;
}

export function capacityLine(person: Pick<OrgPerson, "capacityStatus" | "capacityNote">): string {
  if (!person.capacityStatus) return "Capacity: unset.";
  const note = person.capacityNote ? ` (${person.capacityNote})` : "";
  return `Capacity: ${person.capacityStatus}${note}.`;
}

export function formatWorkload(person: OrgPerson, load: PersonWorkload): string {
  const header = `${person.displayName} — ${capacityLine(person)} ${plateCountsLine(load)}`;
  if (!load.items.length) return `${header}\nNothing open on the TaskBrain plate.`;
  const lines = load.items.map((item) => {
    const due = item.due ? ` due ${item.due.slice(0, 10)}` : "";
    return `- [${item.source}] ${item.title}${due}`;
  });
  return [header, ...lines].join("\n");
}

export function loadPressure(person: OrgPerson, load: PersonWorkload): string | undefined {
  const open =
    load.counts.work + load.counts.commitment + load.counts.graph + load.counts.pmo;
  if (person.capacityStatus === "unavailable") {
    return `${person.displayName} is marked unavailable.`;
  }
  if (person.capacityStatus === "overloaded") {
    return `${person.displayName} is marked overloaded (${open} open items).`;
  }
  if (person.capacityStatus === "stretched" && open >= STRETCHED_OPEN_COUNT) {
    return `${person.displayName} is stretched with ${open} open items.`;
  }
  return undefined;
}
