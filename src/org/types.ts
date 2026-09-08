export type OrgKind = "unit" | "person" | "role";

export type OrgUnitStatus = "active" | "archived";
export type OrgPersonStatus = "active" | "inactive";
export type OrgRoleStatus = "active" | "inactive";

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
  status: OrgPersonStatus;
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
