export type OrgKind = "unit" | "person" | "role";

export type OrgUnitStatus = "active" | "archived";
export type OrgPersonStatus = "active" | "inactive";
export type OrgRoleStatus = "active" | "inactive";

export type ExecutionQueue = "teams" | "todo" | "planner" | "smartsheet";
export type NudgeChannel = "teams_card" | "teams_chat" | "imessage" | "email" | "silent";
export type PrefSource = "admin" | "explicit" | "inferred";
export type CapacityStatus = "available" | "stretched" | "overloaded" | "unavailable";

export interface OrgUnit {
  id: string;
  kind: "unit";
  name: string;
  parentId?: string;
  purpose: string;
  status: OrgUnitStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OrgPerson {
  id: string;
  kind: "person";
  displayName: string;
  entraId?: string;
  aliases: string[];
  managerPersonId?: string;
  unitId?: string;
  title?: string;
  mandate: string;
  mandateSource?: PrefSource;
  status: OrgPersonStatus;
  /** Operator-set load, not inferred from Microsoft 365. */
  capacityStatus?: CapacityStatus;
  /** One-line capacity context, max ~120 chars. */
  capacityNote?: string;
  capacitySource?: PrefSource;
  /** Ordered work queues; first is primary. Empty means Teams-only default. */
  executionQueues?: ExecutionQueue[];
  nudgeChannel?: NudgeChannel;
  /** One-line working style, max ~240 chars. */
  workingNotes?: string;
  prefSource?: PrefSource;
  prefUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgRole {
  id: string;
  kind: "role";
  personId: string;
  title: string;
  unitId?: string;
  mandate: string;
  mandateSource?: PrefSource;
  status: OrgRoleStatus;
  createdAt: string;
  updatedAt: string;
}

export type OrgDoc = OrgUnit | OrgPerson | OrgRole;

export interface OrgDirectory {
  units: OrgUnit[];
  people: OrgPerson[];
  roles: OrgRole[];
}
