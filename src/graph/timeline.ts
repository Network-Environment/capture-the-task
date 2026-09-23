import { graphNeighborhood, putGraphEdge, putGraphNode } from "./store";
import type { GraphEdge, GraphNode } from "./types";
import { listOrgDirectory } from "../org/store";

export interface TimelineRow {
  id: string;
  title: string;
  ownerPersonId?: string;
  start: string;
  finish: string;
  effort: number;
  estimatedEffort: boolean;
  dependencies: string[];
  conflicts: string[];
}

export interface TimelineResult {
  rows: TimelineRow[];
  cycles: string[][];
  targetDate?: string;
  likelyFinish?: string;
  feasible?: boolean;
}

export function buildTimeline(
  nodes: GraphNode[],
  edges: GraphEdge[],
  input: {
    startDate?: string;
    targetDate?: string;
    capacity?: Map<string, "available" | "stretched" | "overloaded" | "unavailable">;
  } = {}
): TimelineResult {
  const tasks = nodes.filter(
    (node) =>
      node.type === "task" && !["done", "cancelled"].includes(node.status ?? "")
  );
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependencyEdges = edges.filter(
    (edge) =>
      edge.type === "depends_on" &&
      edge.reviewState === "accepted" &&
      byId.has(edge.fromId) &&
      byId.has(edge.toId)
  );
  const dependencies = new Map<string, string[]>();
  for (const task of tasks) dependencies.set(task.id, []);
  for (const edge of dependencyEdges) {
    dependencies.set(edge.fromId, [
      ...(dependencies.get(edge.fromId) ?? []),
      edge.toId,
    ]);
  }
  const { order, cycles } = dependencyOrder(tasks.map((task) => task.id), dependencies);
  if (cycles.length) return { rows: [], cycles, targetDate: input.targetDate };

  const start = normalizeDay(input.startDate ?? new Date().toISOString());
  const finishById = new Map<string, string>();
  const ownerAvailable = new Map<string, string>();
  const rows: TimelineRow[] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    const deps = dependencies.get(id) ?? [];
    let rowStart = start;
    for (const dep of deps) {
      const finish = finishById.get(dep);
      if (finish && finish > rowStart) rowStart = nextBusinessDay(finish);
    }
    if (task.ownerPersonId) {
      const available = ownerAvailable.get(task.ownerPersonId);
      if (available && available > rowStart) rowStart = available;
    }
    const baseEffort = task.effort ?? 1;
    const capacity = task.ownerPersonId
      ? input.capacity?.get(task.ownerPersonId)
      : undefined;
    const multiplier =
      capacity === "unavailable"
        ? 3
        : capacity === "overloaded"
          ? 2
          : capacity === "stretched"
            ? 1.5
            : 1;
    const effort = Math.max(1, Math.ceil(baseEffort * multiplier));
    const finish = addBusinessDays(rowStart, effort - 1);
    const conflicts: string[] = [];
    if (task.due && finish > normalizeDay(task.due)) {
      conflicts.push(`likely finish ${finish} is after committed due ${normalizeDay(task.due)}`);
    }
    if (capacity === "unavailable") conflicts.push("owner is marked unavailable");
    rows.push({
      id,
      title: task.title,
      ownerPersonId: task.ownerPersonId,
      start: rowStart,
      finish,
      effort,
      estimatedEffort: task.effort === undefined,
      dependencies: deps,
      conflicts,
    });
    finishById.set(id, finish);
    if (task.ownerPersonId) ownerAvailable.set(task.ownerPersonId, nextBusinessDay(finish));
  }
  const likelyFinish = rows.map((row) => row.finish).sort().at(-1);
  const targetDate = input.targetDate ? normalizeDay(input.targetDate) : undefined;
  return {
    rows,
    cycles: [],
    targetDate,
    likelyFinish,
    feasible: targetDate && likelyFinish ? likelyFinish <= targetDate : undefined,
  };
}

export async function explainGraphTimeline(
  userId: string,
  input: { projectId: string; startDate?: string; targetDate?: string }
): Promise<string> {
  const payload = await graphNeighborhood([input.projectId], userId, 2, 100);
  const project = payload.nodes.find(
    (node) => node.id === input.projectId && node.type === "project"
  );
  if (!project) return `Project not found: ${input.projectId}.`;
  const partIds = new Set(
    payload.edges
      .filter((edge) => edge.type === "part_of" && edge.toId === project.id)
      .map((edge) => edge.fromId)
  );
  const tasks = payload.nodes.filter((node) => partIds.has(node.id));
  const dir = await listOrgDirectory();
  const capacity = new Map(
    dir.people
      .filter((person) => person.capacityStatus)
      .map((person) => [person.id, person.capacityStatus!] as const)
  );
  const result = buildTimeline(tasks, payload.edges, {
    startDate: input.startDate,
    targetDate: input.targetDate,
    capacity,
  });
  return formatTimeline(project.title, result);
}

export interface TimelineTaskInput {
  title: string;
  description?: string;
  ownerPersonId?: string;
  effort?: 1 | 2 | 3 | 5 | 8;
  dependsOn?: number[];
}

export async function createProposedTimeline(
  userId: string,
  input: {
    projectId: string;
    targetDate?: string;
    startDate?: string;
    tasks: TimelineTaskInput[];
  }
): Promise<string> {
  if (!input.tasks.length) return "A timeline needs at least one task.";
  if (input.tasks.length > 40) return "A timeline proposal is limited to 40 tasks.";
  const syntheticNodes: GraphNode[] = input.tasks.map((task, index) => ({
    id: `proposal-${index}`,
    workspaceId: "org",
    docType: "node",
    type: "task",
    title: task.title,
    description: task.description,
    status: "planned",
    ownerPersonId: task.ownerPersonId,
    effort: task.effort,
    visibility: "workspace",
    provenance: "agent",
    createdBy: userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  }));
  const syntheticEdges: GraphEdge[] = [];
  input.tasks.forEach((task, index) => {
    for (const dependency of task.dependsOn ?? []) {
      if (dependency < 0 || dependency >= input.tasks.length || dependency === index) {
        throw new Error(`Invalid dependency index ${dependency} for task ${index}.`);
      }
      syntheticEdges.push({
        id: `proposal-${index}-depends-${dependency}`,
        workspaceId: "org",
        docType: "edge",
        fromId: `proposal-${index}`,
        toId: `proposal-${dependency}`,
        type: "depends_on",
        reviewState: "accepted",
        provenance: "agent",
        createdBy: userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });
    }
  });
  const schedule = buildTimeline(syntheticNodes, syntheticEdges, {
    startDate: input.startDate,
    targetDate: input.targetDate,
  });
  if (schedule.cycles.length) throw new Error("Timeline dependencies contain a cycle.");
  const created: GraphNode[] = [];
  for (const [index, task] of input.tasks.entries()) {
    const row = schedule.rows.find((candidate) => candidate.id === `proposal-${index}`)!;
    created.push(
      await putGraphNode(
        {
          type: "task",
          title: task.title,
          description: task.description,
          status: "planned",
          ownerPersonId: task.ownerPersonId,
          effort: task.effort,
          due: row.finish,
          provenance: "agent",
          source: { kind: "graph", id: input.projectId },
        },
        userId
      )
    );
  }
  for (const node of created) {
    await putGraphEdge(
      {
        fromId: node.id,
        toId: input.projectId,
        type: "part_of",
        reviewState: "accepted",
        provenance: "agent",
        evidence: "Approved timeline proposal.",
      },
      userId
    );
  }
  for (const [index, task] of input.tasks.entries()) {
    for (const dependency of task.dependsOn ?? []) {
      await putGraphEdge(
        {
          fromId: created[index].id,
          toId: created[dependency].id,
          type: "depends_on",
          reviewState: "accepted",
          provenance: "agent",
          evidence: "Approved timeline proposal.",
        },
        userId
      );
    }
  }
  return `Created ${created.length} timeline tasks under ${input.projectId}; likely finish ${schedule.likelyFinish ?? "unknown"}${schedule.feasible === false ? `, after target ${schedule.targetDate}` : ""}.`;
}

function dependencyOrder(
  ids: string[],
  dependencies: Map<string, string[]>
): { order: string[]; cycles: string[][] } {
  const state = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    stack.pop();
    state.set(id, 2);
    order.push(id);
  };
  for (const id of ids) visit(id);
  return { order: [...new Set(order)], cycles };
}

function formatTimeline(projectTitle: string, result: TimelineResult): string {
  if (result.cycles.length) {
    return `${projectTitle}: dependency cycle detected: ${result.cycles
      .map((cycle) => cycle.join(" -> "))
      .join("; ")}.`;
  }
  if (!result.rows.length) return `${projectTitle}: no open tasks to schedule.`;
  const header =
    `${projectTitle}: likely finish ${result.likelyFinish ?? "unknown"}` +
    `${result.targetDate ? `; target ${result.targetDate} (${result.feasible ? "feasible" : "at risk"})` : ""}.`;
  const rows = result.rows.map(
    (row) =>
      `- ${row.title}: ${row.start} → ${row.finish}, effort ${row.effort}${row.estimatedEffort ? " estimated/default" : ""}` +
      `${row.conflicts.length ? `; ${row.conflicts.join("; ")}` : ""}`
  );
  return [header, ...rows].join("\n");
}

function normalizeDay(value: string): string {
  const parsed = new Date(value.length <= 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed.toISOString().slice(0, 10);
}

function addBusinessDays(start: string, days: number): string {
  const date = new Date(`${start}T12:00:00Z`);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining--;
  }
  return date.toISOString().slice(0, 10);
}

function nextBusinessDay(value: string): string {
  return addBusinessDays(value, 1);
}
