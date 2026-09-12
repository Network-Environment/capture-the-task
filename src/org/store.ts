import { canViewMeetings, denyMeetings, syncMeetingViewersFromDirectory } from "../meetings/access";
import { listOpenCommitments } from "../meetings/store";
import { compactOrgPrompt, newOrgId, resolvePerson, searchOrgDirectory } from "./resolve";
import type { OrgDirectory, OrgDoc, OrgKind, OrgPerson, OrgRole, OrgUnit } from "./types";
import { projectPerson } from "../graph/project";
import { cosmosContainer } from "../services/cosmos";

function org() {
  return cosmosContainer("org");
}

export async function listOrgByKind<T extends OrgDoc>(kind: OrgKind): Promise<T[]> {
  const { resources } = await org().items
    .query<T>({
      query: "SELECT * FROM c WHERE c.kind = @k ORDER BY c.name, c.displayName, c.title",
      parameters: [{ name: "@k", value: kind }],
    })
    .fetchAll();
  return resources;
}

export async function listOrgDirectory(): Promise<OrgDirectory> {
  const [units, people, roles] = await Promise.all([
    listOrgByKind<OrgUnit>("unit"),
    listOrgByKind<OrgPerson>("person"),
    listOrgByKind<OrgRole>("role"),
  ]);
  const dir = { units, people, roles };
  syncMeetingViewersFromDirectory(dir);
  return dir;
}

export async function refreshMeetingViewers(): Promise<void> {
  await listOrgDirectory();
}

export async function getOrgDoc<T extends OrgDoc>(id: string, kind: OrgKind): Promise<T | undefined> {
  try {
    const { resource } = await org().item(id, kind).read<T>();
    return resource;
  } catch {
    return undefined;
  }
}

export async function upsertOrgDoc<T extends OrgDoc>(doc: T): Promise<T> {
  const { resource } = await org().items.upsert(doc);
  return resource as unknown as T;
}

export async function saveUnit(input: {
  id?: string;
  name: string;
  parentId?: string;
  purpose: string;
  archive?: boolean;
}): Promise<OrgUnit> {
  const now = new Date().toISOString();
  const existing = input.id ? await getOrgDoc<OrgUnit>(input.id, "unit") : undefined;
  const doc: OrgUnit = {
    id: existing?.id ?? newOrgId("unit", input.name),
    kind: "unit",
    name: input.name.trim().slice(0, 80),
    parentId: input.parentId || undefined,
    purpose: input.purpose.trim().slice(0, 400),
    status: input.archive ? "archived" : "active",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return upsertOrgDoc(doc);
}

export async function savePerson(input: {
  id?: string;
  displayName: string;
  entraId?: string;
  aliases: string[];
  managerPersonId?: string;
  unitId?: string;
  title?: string;
  mandate: string;
  archive?: boolean;
}): Promise<OrgPerson> {
  const now = new Date().toISOString();
  const existing = input.id ? await getOrgDoc<OrgPerson>(input.id, "person") : undefined;
  const doc: OrgPerson = {
    id: existing?.id ?? newOrgId("person", input.displayName),
    kind: "person",
    displayName: input.displayName.trim().slice(0, 80),
    entraId: input.entraId?.trim() || undefined,
    aliases: input.aliases.map((a) => a.trim()).filter(Boolean).slice(0, 12),
    managerPersonId: input.managerPersonId || undefined,
    unitId: input.unitId || undefined,
    title: input.title?.trim().slice(0, 80) || undefined,
    mandate: input.mandate.trim().slice(0, 400),
    status: input.archive ? "inactive" : "active",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const saved = await upsertOrgDoc(doc);
  const projected = await projectPerson(saved);
  if (projected.errors.length) console.error("[graph] person projection failed:", projected.errors);
  await refreshMeetingViewers().catch((err) =>
    console.error("[org] meeting viewer refresh failed:", err)
  );
  return saved;
}

export async function saveRole(input: {
  id?: string;
  personId: string;
  title: string;
  unitId?: string;
  mandate: string;
  archive?: boolean;
}): Promise<OrgRole> {
  const now = new Date().toISOString();
  const existing = input.id ? await getOrgDoc<OrgRole>(input.id, "role") : undefined;
  const doc: OrgRole = {
    id: existing?.id ?? newOrgId("role", input.title),
    kind: "role",
    personId: input.personId,
    title: input.title.trim().slice(0, 80),
    unitId: input.unitId || undefined,
    mandate: input.mandate.trim().slice(0, 400),
    status: input.archive ? "inactive" : "active",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const saved = await upsertOrgDoc(doc);
  await refreshMeetingViewers().catch((err) =>
    console.error("[org] meeting viewer refresh failed:", err)
  );
  return saved;
}

export async function orgCounts(): Promise<{ people: number; units: number; roles: number }> {
  const dir = await listOrgDirectory();
  return {
    people: dir.people.filter((p) => p.status === "active").length,
    units: dir.units.filter((u) => u.status === "active").length,
    roles: dir.roles.filter((r) => r.status === "active").length,
  };
}

export async function orgPromptBlock(userId: string): Promise<string> {
  if (!canViewMeetings(userId)) return "";
  try {
    return compactOrgPrompt(await listOrgDirectory());
  } catch (err) {
    console.error("[org] prompt block failed (non-fatal):", err);
    return "";
  }
}

export async function lookupOrg(userId: string, query: string): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  const hits = searchOrgDirectory(dir, query);
  if (!hits.people.length && !hits.units.length && !hits.roles.length) {
    return "No matching people, teams, or roles in the org directory.";
  }
  const open = await listOpenCommitments().catch(() => []);
  const unitName = (id?: string) => dir.units.find((u) => u.id === id)?.name;
  const personName = (id?: string) => dir.people.find((p) => p.id === id)?.displayName;
  const lines: string[] = [];
  for (const u of hits.units.slice(0, 8)) {
    lines.push(`Team ${u.name}${u.parentId ? ` under ${unitName(u.parentId) ?? u.parentId}` : ""}. Should: ${u.purpose || "—"}`);
  }
  for (const p of hits.people.slice(0, 8)) {
    const doing = open.filter((c) => c.personId === p.id && c.status === "open").length;
    const hats = dir.roles
      .filter((r) => r.personId === p.id && r.status === "active")
      .map((r) => r.title);
    lines.push(
      `${p.displayName}${p.title ? `, ${p.title}` : ""}${p.unitId ? ` · ${unitName(p.unitId)}` : ""}` +
        `${p.managerPersonId ? ` · reports to ${personName(p.managerPersonId)}` : ""}.` +
        ` Should: ${p.mandate || "—"}.` +
        `${hats.length ? ` Roles: ${hats.join(", ")}.` : ""}` +
        ` Open commitments: ${doing}.`
    );
  }
  for (const r of hits.roles.slice(0, 8)) {
    lines.push(
      `Role ${r.title} held by ${personName(r.personId) ?? r.personId}` +
        `${r.unitId ? ` @ ${unitName(r.unitId)}` : ""}. Should: ${r.mandate || "—"}`
    );
  }
  return lines.join("\n");
}

export { resolvePerson };
