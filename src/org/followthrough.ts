import type { OrgDirectory, OrgPerson } from "./types";
import {
  personWorkload,
  type PersonWorkload,
  type WorkloadItem,
} from "./workload";

export type WorkRisk = "overdue" | "due_soon" | "blocked" | "inactive";

export interface RiskPolicy {
  dueSoonDays: number;
  inactiveDays: number;
}

export interface PersonFollowthrough {
  person: OrgPerson;
  workload: PersonWorkload;
  risks: { item: WorkloadItem; risks: WorkRisk[] }[];
}

export interface OrgFollowthroughSnapshot {
  generatedAt: string;
  people: PersonFollowthrough[];
}

export function defaultRiskPolicy(): RiskPolicy {
  return {
    dueSoonDays: positiveInt(process.env.FOLLOWTHROUGH_DUE_SOON_DAYS, 2),
    inactiveDays: positiveInt(process.env.FOLLOWTHROUGH_INACTIVE_DAYS, 5),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function dayStart(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function dateValue(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value.length <= 10 ? `${value}T17:00:00Z` : value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function riskForItem(
  item: WorkloadItem,
  now = new Date(),
  policy = defaultRiskPolicy()
): WorkRisk[] {
  const risks: WorkRisk[] = [];
  const status = (item.status ?? "").toLowerCase();
  if (status.includes("block")) risks.push("blocked");

  const due = dateValue(item.due);
  if (due !== undefined) {
    const days = Math.ceil((dayStart(new Date(due)) - dayStart(now)) / 86_400_000);
    if (days < 0) risks.push("overdue");
    else if (days <= policy.dueSoonDays) risks.push("due_soon");
  }

  const progress = dateValue(item.lastProgressAt ?? item.updatedAt);
  if (progress !== undefined) {
    const inactiveDays = Math.floor((dayStart(now) - dayStart(new Date(progress))) / 86_400_000);
    if (inactiveDays >= policy.inactiveDays) risks.push("inactive");
  }
  return [...new Set(risks)];
}

export function peopleInScope(
  dir: OrgDirectory,
  scope:
    | { kind: "all" }
    | { kind: "team"; unitId: string }
    | { kind: "manager"; managerPersonId: string }
): OrgPerson[] {
  const active = dir.people.filter((person) => person.status === "active");
  if (scope.kind === "all") return active;
  if (scope.kind === "team") return active.filter((person) => person.unitId === scope.unitId);
  const directIds = new Set(
    active
      .filter((person) => person.managerPersonId === scope.managerPersonId)
      .map((person) => person.id)
  );
  return active.filter(
    (person) => person.id === scope.managerPersonId || directIds.has(person.id)
  );
}

export async function buildOrgFollowthrough(
  dir: OrgDirectory,
  scope:
    | { kind: "all" }
    | { kind: "team"; unitId: string }
    | { kind: "manager"; managerPersonId: string } = { kind: "all" },
  now = new Date(),
  policy = defaultRiskPolicy()
): Promise<OrgFollowthroughSnapshot> {
  const people = await Promise.all(
    peopleInScope(dir, scope).map(async (person): Promise<PersonFollowthrough> => {
      const workload = await personWorkload(person.id);
      return {
        person,
        workload,
        risks: workload.items
          .map((item) => ({ item, risks: riskForItem(item, now, policy) }))
          .filter((row) => row.risks.length > 0),
      };
    })
  );
  return { generatedAt: now.toISOString(), people };
}

export function formatOrgFollowthrough(
  snapshot: OrgFollowthroughSnapshot,
  risksOnly = false
): string {
  const rows = snapshot.people
    .map((row) => {
      const total = Object.values(row.workload.counts).reduce((sum, value) => sum + value, 0);
      const riskItems = row.risks
        .slice(0, 6)
        .map(
          ({ item, risks }) =>
            `  - [${risks.join("+")}] ${item.title}${item.due ? ` (due ${item.due.slice(0, 10)})` : ""}`
        );
      if (risksOnly && !riskItems.length) return "";
      return [
        `${row.person.displayName}: ${total} open; ${row.risks.length} at risk; capacity ${row.person.capacityStatus ?? "unset"}.`,
        ...riskItems,
      ].join("\n");
    })
    .filter(Boolean);
  return rows.length ? rows.join("\n") : "No matching at-risk work.";
}

export function managerScopes(dir: OrgDirectory): OrgPerson[] {
  const managerIds = new Set(
    dir.people
      .filter((person) => person.status === "active" && person.managerPersonId)
      .map((person) => person.managerPersonId!)
  );
  return dir.people.filter(
    (person) => person.status === "active" && managerIds.has(person.id)
  );
}
