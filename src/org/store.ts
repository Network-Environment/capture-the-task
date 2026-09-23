import { canViewMeetings, denyMeetings, syncMeetingViewersFromDirectory } from "../meetings/access";
import { compactOrgPrompt, newOrgId, resolvePerson, searchOrgDirectory } from "./resolve";
import type {
  CapacityStatus,
  ExecutionQueue,
  NudgeChannel,
  OrgDirectory,
  OrgDoc,
  OrgKind,
  OrgPerson,
  OrgRole,
  OrgUnit,
  PrefSource,
} from "./types";
import {
  canApplyPref,
  isCapacityStatus,
  isNudgeChannel,
  parseExecutionQueues,
  workingStyleLine,
} from "./prefs";
import { applyHat, applyPersonResponsibility } from "./responsibility";
import {
  formatAssessment,
  formatAssigneeSuggestions,
  rankAssignees,
  scorePeople,
} from "./assess";
import { capacityLine, formatWorkload, personWorkload, plateCountsLine } from "./workload";
import {
  buildOrgFollowthrough,
  formatOrgFollowthrough,
} from "./followthrough";
import { projectPerson } from "../graph/project";
import { cosmosContainer } from "../services/cosmos";
import { listRecentWork } from "../work/store";

function org() {
  return cosmosContainer("org");
}

/** Units sort by name, people by display name, roles by title. */
function orgLabel(doc: OrgDoc): string {
  switch (doc.kind) {
    case "unit":
      return doc.name;
    case "person":
      return doc.displayName;
    case "role":
      return doc.title;
  }
}

export async function listOrgByKind<T extends OrgDoc>(kind: OrgKind): Promise<T[]> {
  // Sorted in memory: a multi-property ORDER BY needs a composite index the
  // org container does not carry, and the directory is small enough that the
  // sort is free next to the round trip.
  const { resources } = await org().items
    .query<T>({
      query: "SELECT * FROM c WHERE c.kind = @k",
      parameters: [{ name: "@k", value: kind }],
    })
    .fetchAll();
  return resources.sort((a, b) => orgLabel(a).localeCompare(orgLabel(b)));
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
  mandateSource?: PrefSource;
  archive?: boolean;
  capacityStatus?: CapacityStatus;
  capacityNote?: string;
  capacitySource?: PrefSource;
  executionQueues?: ExecutionQueue[];
  nudgeChannel?: NudgeChannel;
  workingNotes?: string;
  prefSource?: PrefSource;
}): Promise<OrgPerson> {
  const now = new Date().toISOString();
  const existing = input.id ? await getOrgDoc<OrgPerson>(input.id, "person") : undefined;
  const prefSource = input.prefSource ?? (input.executionQueues || input.nudgeChannel || input.workingNotes ? "admin" : existing?.prefSource);
  const mandateChanged = input.mandate.trim() !== (existing?.mandate ?? "");
  const capacityTouched =
    input.capacityStatus !== undefined || input.capacityNote !== undefined;
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
    mandateSource: input.mandateSource ?? (mandateChanged ? "admin" : existing?.mandateSource),
    capacityStatus: input.capacityStatus ?? existing?.capacityStatus,
    capacityNote:
      input.capacityNote !== undefined
        ? input.capacityNote.trim().slice(0, 120) || undefined
        : existing?.capacityNote,
    capacitySource:
      input.capacitySource ?? (capacityTouched ? "admin" : existing?.capacitySource),
    executionQueues: input.executionQueues ?? existing?.executionQueues,
    nudgeChannel: input.nudgeChannel ?? existing?.nudgeChannel,
    workingNotes: input.workingNotes !== undefined ? input.workingNotes.slice(0, 240) : existing?.workingNotes,
    prefSource,
    prefUpdatedAt: input.executionQueues || input.nudgeChannel || input.workingNotes ? now : existing?.prefUpdatedAt,
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

export async function rememberOrgPreference(
  userId: string,
  input: {
    person: string;
    executionQueues?: unknown;
    nudgeChannel?: string;
    workingNotes?: string;
    dropQueue?: string;
    source?: PrefSource;
  }
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: input.person, ownerName: input.person });
  if (!person) return `No org person matching "${input.person}".`;
  const incoming = input.source ?? "explicit";
  if (!canApplyPref(person.prefSource, incoming)) {
    return `${person.displayName} working style is locked as ${person.prefSource}; not overriding with ${incoming}.`;
  }
  let queues = parseExecutionQueues(input.executionQueues ?? person.executionQueues ?? ["teams"]);
  const drop = input.dropQueue?.trim().toLowerCase();
  if (drop) queues = queues.filter((q) => q !== drop);
  const nudge = input.nudgeChannel && isNudgeChannel(input.nudgeChannel) ? input.nudgeChannel : person.nudgeChannel;
  const notes = input.workingNotes !== undefined ? input.workingNotes.trim().slice(0, 240) : person.workingNotes;
  const saved = await savePerson({
    id: person.id,
    displayName: person.displayName,
    entraId: person.entraId,
    aliases: person.aliases,
    managerPersonId: person.managerPersonId,
    unitId: person.unitId,
    title: person.title,
    mandate: person.mandate,
    executionQueues: queues,
    nudgeChannel: nudge,
    workingNotes: notes,
    prefSource: incoming,
  });
  return `Stored org working style for ${saved.displayName}: ${workingStyleLine(saved)}`;
}

export async function rememberOrgResponsibility(
  userId: string,
  input: {
    person: string;
    mandate?: string;
    roleTitle?: string;
    roleMandate?: string;
    roleUnit?: string;
    capacityStatus?: string;
    capacityNote?: string;
    source?: PrefSource;
  }
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: input.person, ownerName: input.person });
  if (!person) return `No org person matching "${input.person}".`;
  const incoming = input.source ?? "explicit";
  const now = new Date().toISOString();
  const capacityStatus =
    input.capacityStatus && isCapacityStatus(input.capacityStatus) ? input.capacityStatus : undefined;
  if (input.capacityStatus && !capacityStatus) {
    return `Unknown capacity status "${input.capacityStatus}". Use available, stretched, overloaded, or unavailable.`;
  }
  const applied = applyPersonResponsibility(
    person,
    {
      mandate: input.mandate,
      capacityStatus,
      capacityNote: input.capacityNote,
    },
    incoming,
    now
  );
  let savedPerson = person;
  if (applied.changed.length) {
    savedPerson = await savePerson({
      id: person.id,
      displayName: person.displayName,
      entraId: person.entraId,
      aliases: person.aliases,
      managerPersonId: person.managerPersonId,
      unitId: person.unitId,
      title: person.title,
      mandate: applied.person.mandate,
      mandateSource: applied.person.mandateSource,
      capacityStatus: applied.person.capacityStatus,
      capacityNote: applied.person.capacityNote,
      capacitySource: applied.person.capacitySource,
      executionQueues: person.executionQueues,
      nudgeChannel: person.nudgeChannel,
      workingNotes: person.workingNotes,
      prefSource: person.prefSource,
    });
  }

  const lines: string[] = [];
  if (applied.changed.length) {
    lines.push(`Updated ${savedPerson.displayName}: ${applied.changed.join(", ")}.`);
  }
  lines.push(...applied.blocked.map((item) => `${savedPerson.displayName}: ${item}.`));

  const roleTitle = input.roleTitle?.trim();
  if (roleTitle) {
    const unitName = input.roleUnit?.trim();
    const unit = unitName
      ? dir.units.find(
          (row) =>
            row.status === "active" &&
            (row.id === unitName || row.name.toLowerCase() === unitName.toLowerCase())
        )
      : undefined;
    if (unitName && !unit) return `No org team matching "${unitName}".`;
    const hat = applyHat(
      dir.roles,
      person.id,
      {
        title: roleTitle,
        mandate: input.roleMandate ?? "",
        unitId: unit?.id,
      },
      incoming,
      now,
      () => newOrgId("role", roleTitle)
    );
    if (hat.blocked) {
      lines.push(`${savedPerson.displayName}: ${hat.blocked}.`);
    } else {
      await saveRole({
        id: hat.role.id,
        personId: hat.role.personId,
        title: hat.role.title,
        unitId: hat.role.unitId,
        mandate: hat.role.mandate,
        mandateSource: hat.role.mandateSource,
      });
      lines.push(
        hat.created
          ? `Added role ${hat.role.title} for ${savedPerson.displayName}.`
          : `Updated role ${hat.role.title} for ${savedPerson.displayName}.`
      );
    }
  }

  if (!lines.length) {
    return `No org responsibility changes for ${savedPerson.displayName}.`;
  }
  return lines.join(" ");
}

export async function saveRole(input: {
  id?: string;
  personId: string;
  title: string;
  unitId?: string;
  mandate: string;
  mandateSource?: PrefSource;
  archive?: boolean;
}): Promise<OrgRole> {
  const now = new Date().toISOString();
  const existing = input.id ? await getOrgDoc<OrgRole>(input.id, "role") : undefined;
  const mandateChanged = input.mandate.trim() !== (existing?.mandate ?? "");
  const doc: OrgRole = {
    id: existing?.id ?? newOrgId("role", input.title),
    kind: "role",
    personId: input.personId,
    title: input.title.trim().slice(0, 80),
    unitId: input.unitId || undefined,
    mandate: input.mandate.trim().slice(0, 400),
    mandateSource: input.mandateSource ?? (mandateChanged ? "admin" : existing?.mandateSource),
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
  const unitName = (id?: string) => dir.units.find((u) => u.id === id)?.name;
  const personName = (id?: string) => dir.people.find((p) => p.id === id)?.displayName;
  const lines: string[] = [];
  for (const u of hits.units.slice(0, 8)) {
    lines.push(`Team ${u.name}${u.parentId ? ` under ${unitName(u.parentId) ?? u.parentId}` : ""}. Should: ${u.purpose || "—"}`);
  }
  for (const p of hits.people.slice(0, 8)) {
    const load = await personWorkload(p.id);
    const hats = dir.roles
      .filter((r) => r.personId === p.id && r.status === "active")
      .map((r) => r.title);
    lines.push(
      `${p.displayName}${p.title ? `, ${p.title}` : ""}${p.unitId ? ` · ${unitName(p.unitId)}` : ""}` +
        `${p.managerPersonId ? ` · reports to ${personName(p.managerPersonId)}` : ""}.` +
        ` Should: ${p.mandate || "—"}.` +
        `${hats.length ? ` Roles: ${hats.join(", ")}.` : ""}` +
        ` ${workingStyleLine(p)}` +
        ` ${capacityLine(p)} ${plateCountsLine(load)}.`
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

export async function listWorkload(userId: string, owner: string): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: owner, ownerName: owner });
  if (!person) return `No org person matching "${owner}".`;
  return formatWorkload(person, await personWorkload(person.id));
}

export async function listOrgWorkload(
  userId: string,
  input: { team?: string; manager?: string } = {}
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  let scope:
    | { kind: "all" }
    | { kind: "team"; unitId: string }
    | { kind: "manager"; managerPersonId: string } = { kind: "all" };
  if (input.team) {
    const q = input.team.trim().toLowerCase();
    const unit = dir.units.find(
      (row) => row.status === "active" && (row.id === input.team || row.name.toLowerCase() === q)
    );
    if (!unit) return `No org team matching "${input.team}".`;
    scope = { kind: "team", unitId: unit.id };
  } else if (input.manager) {
    const manager = resolvePerson(dir.people, {
      ownerId: input.manager,
      ownerName: input.manager,
    });
    if (!manager) return `No org person matching "${input.manager}".`;
    scope = { kind: "manager", managerPersonId: manager.id };
  }
  return formatOrgFollowthrough(await buildOrgFollowthrough(dir, scope));
}

export async function findAtRiskWork(
  userId: string,
  input: { team?: string; manager?: string } = {}
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  let scope:
    | { kind: "all" }
    | { kind: "team"; unitId: string }
    | { kind: "manager"; managerPersonId: string } = { kind: "all" };
  if (input.team) {
    const q = input.team.trim().toLowerCase();
    const unit = dir.units.find(
      (row) => row.status === "active" && (row.id === input.team || row.name.toLowerCase() === q)
    );
    if (!unit) return `No org team matching "${input.team}".`;
    scope = { kind: "team", unitId: unit.id };
  } else if (input.manager) {
    const manager = resolvePerson(dir.people, {
      ownerId: input.manager,
      ownerName: input.manager,
    });
    if (!manager) return `No org person matching "${input.manager}".`;
    scope = { kind: "manager", managerPersonId: manager.id };
  }
  return formatOrgFollowthrough(await buildOrgFollowthrough(dir, scope), true);
}

export async function assessAssignment(
  userId: string,
  input: { owner: string; title: string; detail?: string }
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  const person = resolvePerson(dir.people, { ownerId: input.owner, ownerName: input.owner });
  if (!person) return `No org person matching "${input.owner}".`;
  const ranked = scorePeople([input.title, input.detail ?? ""].join(" "), dir);
  const ownerRow = ranked.find((row) => row.person.id === person.id);
  const score = ownerRow?.score ?? 0;
  const fit = ownerRow?.fit ?? "unknown";
  const alternatives = ranked
    .filter((row) => row.person.id !== person.id && row.score > score)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const load = await personWorkload(person.id);
  return formatAssessment({
    person,
    title: input.title,
    fit,
    score,
    alternatives,
    load,
    dir,
  });
}

export async function suggestAssignee(
  userId: string,
  input: { title: string; detail?: string; effort?: 1 | 2 | 3 | 5 | 8 }
): Promise<string> {
  if (!canViewMeetings(userId)) return denyMeetings();
  const dir = await listOrgDirectory();
  const active = dir.people.filter((person) => person.status === "active");
  const workloads = new Map(
    await Promise.all(
      active.map(async (person) => [person.id, await personWorkload(person.id)] as const)
    )
  );
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const recent = await listRecentWork(since).catch(() => []);
  const recentAssignments = new Map<string, number>();
  for (const work of recent) {
    recentAssignments.set(
      work.ownerPersonId,
      (recentAssignments.get(work.ownerPersonId) ?? 0) + 1
    );
  }
  return formatAssigneeSuggestions(
    rankAssignees({
      taskText: [input.title, input.detail ?? ""].join(" "),
      effort: input.effort,
      dir,
      workloads,
      recentAssignments,
    })
  );
}

export { resolvePerson };
