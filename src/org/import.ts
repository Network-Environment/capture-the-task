import { normalizeOrgName } from "./resolve";
import type {
  OrgDirectory,
  OrgDoc,
  OrgPerson,
  OrgRole,
  OrgUnit,
} from "./types";

export interface OrgSeedSource {
  name: string;
  date: string;
  providedBy?: string;
  note?: string;
}

export interface SeedUnit {
  id: string;
  name: string;
  aliases?: string[];
  parentId?: string;
  purpose: string;
}

export interface SeedPerson {
  id: string;
  displayName: string;
  entraId?: string;
  aliases: string[];
  unitId?: string;
  title?: string;
  mandate: string;
  sourceNote?: string;
}

export interface SeedRole {
  id: string;
  personId: string;
  unitId?: string;
  title: string;
  mandate: string;
}

export interface OrgSeed {
  schemaVersion: 1;
  source: OrgSeedSource;
  units: SeedUnit[];
  people: SeedPerson[];
  roles: SeedRole[];
}

export interface DirectoryIdentity {
  id: string;
  displayName?: string;
}

export interface ImportChange {
  kind: OrgDoc["kind"];
  id: string;
  label: string;
  fields: string[];
}

export interface OrgImportPlan {
  creates: ImportChange[];
  updates: ImportChange[];
  unchanged: ImportChange[];
  conflicts: string[];
  unresolvedIdentities: string[];
  writes: OrgDoc[];
}

function requiredString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string.`);
    return "";
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${path} must be an array of strings.`);
    return [];
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export function parseOrgSeed(raw: unknown): OrgSeed {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") throw new Error("Org seed must be an object.");
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  const sourceRaw =
    value.source && typeof value.source === "object"
      ? (value.source as Record<string, unknown>)
      : {};
  const source: OrgSeedSource = {
    name: requiredString(sourceRaw.name, "source.name", errors),
    date: requiredString(sourceRaw.date, "source.date", errors),
    providedBy: optionalString(sourceRaw.providedBy),
    note: optionalString(sourceRaw.note),
  };
  const unitRows = Array.isArray(value.units) ? value.units : [];
  const personRows = Array.isArray(value.people) ? value.people : [];
  const roleRows = Array.isArray(value.roles) ? value.roles : [];
  if (!Array.isArray(value.units)) errors.push("units must be an array.");
  if (!Array.isArray(value.people)) errors.push("people must be an array.");
  if (!Array.isArray(value.roles)) errors.push("roles must be an array.");

  const units = unitRows.map((row, index): SeedUnit => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      id: requiredString(item.id, `units[${index}].id`, errors),
      name: requiredString(item.name, `units[${index}].name`, errors),
      aliases: item.aliases === undefined
        ? undefined
        : stringArray(item.aliases, `units[${index}].aliases`, errors),
      parentId: optionalString(item.parentId),
      purpose: requiredString(item.purpose, `units[${index}].purpose`, errors),
    };
  });
  const people = personRows.map((row, index): SeedPerson => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      id: requiredString(item.id, `people[${index}].id`, errors),
      displayName: requiredString(item.displayName, `people[${index}].displayName`, errors),
      entraId: optionalString(item.entraId),
      aliases: stringArray(item.aliases, `people[${index}].aliases`, errors),
      unitId: optionalString(item.unitId),
      title: optionalString(item.title),
      mandate: requiredString(item.mandate, `people[${index}].mandate`, errors),
      sourceNote: optionalString(item.sourceNote),
    };
  });
  const roles = roleRows.map((row, index): SeedRole => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      id: requiredString(item.id, `roles[${index}].id`, errors),
      personId: requiredString(item.personId, `roles[${index}].personId`, errors),
      unitId: optionalString(item.unitId),
      title: requiredString(item.title, `roles[${index}].title`, errors),
      mandate: requiredString(item.mandate, `roles[${index}].mandate`, errors),
    };
  });
  const seed: OrgSeed = { schemaVersion: 1, source, units, people, roles };
  errors.push(...validateOrgSeed(seed));
  if (errors.length) throw new Error(`Invalid org seed:\n- ${[...new Set(errors)].join("\n- ")}`);
  return seed;
}

export function validateOrgSeed(seed: OrgSeed): string[] {
  const errors: string[] = [];
  const all = [...seed.units, ...seed.people, ...seed.roles];
  const ids = new Set<string>();
  for (const row of all) {
    if (ids.has(row.id)) errors.push(`Duplicate seed id: ${row.id}`);
    ids.add(row.id);
  }
  const unitIds = new Set(seed.units.map((unit) => unit.id));
  const personIds = new Set(seed.people.map((person) => person.id));
  const unitNames = new Set<string>();
  const personNames = new Set<string>();
  for (const unit of seed.units) {
    const name = normalizeOrgName(unit.name);
    if (unitNames.has(name)) errors.push(`Duplicate unit name: ${unit.name}`);
    unitNames.add(name);
    if (unit.parentId && !unitIds.has(unit.parentId)) {
      errors.push(`Unit ${unit.id} has unknown parentId ${unit.parentId}.`);
    }
    if (unit.name.length > 80) errors.push(`Unit ${unit.id} name exceeds 80 characters.`);
    if (unit.purpose.length > 400) errors.push(`Unit ${unit.id} purpose exceeds 400 characters.`);
  }
  for (const person of seed.people) {
    const name = normalizeOrgName(person.displayName);
    if (personNames.has(name)) errors.push(`Duplicate person name: ${person.displayName}`);
    personNames.add(name);
    if (person.unitId && !unitIds.has(person.unitId)) {
      errors.push(`Person ${person.id} has unknown unitId ${person.unitId}.`);
    }
    if (person.displayName.length > 80) {
      errors.push(`Person ${person.id} displayName exceeds 80 characters.`);
    }
    if ((person.title?.length ?? 0) > 80) {
      errors.push(`Person ${person.id} title exceeds 80 characters.`);
    }
    if (person.mandate.length > 400) {
      errors.push(`Person ${person.id} mandate exceeds 400 characters.`);
    }
  }
  for (const role of seed.roles) {
    if (!personIds.has(role.personId)) {
      errors.push(`Role ${role.id} has unknown personId ${role.personId}.`);
    }
    if (role.unitId && !unitIds.has(role.unitId)) {
      errors.push(`Role ${role.id} has unknown unitId ${role.unitId}.`);
    }
    if (role.title.length > 80) errors.push(`Role ${role.id} title exceeds 80 characters.`);
    if (role.mandate.length > 400) errors.push(`Role ${role.id} mandate exceeds 400 characters.`);
  }

  const parentById = new Map(seed.units.map((unit) => [unit.id, unit.parentId]));
  for (const unit of seed.units) {
    const path = new Set<string>();
    let current: string | undefined = unit.id;
    while (current) {
      if (path.has(current)) {
        errors.push(`Unit parent cycle includes ${current}.`);
        break;
      }
      path.add(current);
      current = parentById.get(current);
    }
  }
  return [...new Set(errors)];
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" ||
    (Array.isArray(value) && value.length === 0);
}

function fill<T extends object>(
  target: T,
  field: keyof T,
  incoming: T[keyof T],
  changed: string[]
): void {
  if (isEmpty(target[field]) && !isEmpty(incoming)) {
    target[field] = incoming;
    changed.push(String(field));
  }
}

function change(
  kind: OrgDoc["kind"],
  id: string,
  label: string,
  fields: string[] = []
): ImportChange {
  return { kind, id, label, fields };
}

function skipDirectoryMatch(person: SeedPerson): string | undefined {
  const note = person.sourceNote?.toLowerCase() ?? "";
  if (note.includes("surname was not provided")) {
    return `${person.displayName}: incomplete source identity`;
  }
  if (note.includes("do not identity-match automatically")) {
    return `${person.displayName}: source forbids automatic directory matching`;
  }
  return undefined;
}

function exactDirectoryId(
  person: SeedPerson,
  directory: DirectoryIdentity[],
  unresolved: string[]
): string | undefined {
  if (person.entraId) return person.entraId;
  const skipped = skipDirectoryMatch(person);
  if (skipped) {
    unresolved.push(skipped);
    return undefined;
  }
  const matches = directory.filter(
    (user) =>
      user.displayName &&
      normalizeOrgName(user.displayName) === normalizeOrgName(person.displayName)
  );
  if (matches.length > 1) {
    unresolved.push(`${person.displayName}: multiple exact Microsoft 365 directory matches`);
    return undefined;
  }
  if (!matches.length) {
    unresolved.push(`${person.displayName}: no exact Microsoft 365 directory match`);
    return undefined;
  }
  return matches[0].id;
}

function findUniqueByName<T>(
  rows: T[],
  label: string,
  getName: (row: T) => string,
  conflicts: string[]
): T | undefined {
  const matches = rows.filter(
    (row) => normalizeOrgName(getName(row)) === normalizeOrgName(label)
  );
  if (matches.length > 1) {
    conflicts.push(`Multiple existing records match "${label}".`);
    return undefined;
  }
  return matches[0];
}

export function planOrgImport(
  seed: OrgSeed,
  existing: OrgDirectory,
  directory: DirectoryIdentity[] = [],
  now = new Date().toISOString()
): OrgImportPlan {
  const validation = validateOrgSeed(seed);
  const plan: OrgImportPlan = {
    creates: [],
    updates: [],
    unchanged: [],
    conflicts: [...validation],
    unresolvedIdentities: [],
    writes: [],
  };
  if (validation.length) return plan;

  const unitIdMap = new Map<string, string>();
  const personIdMap = new Map<string, string>();

  for (const unit of seed.units) {
    const byId = existing.units.find((row) => row.id === unit.id);
    const matched =
      byId ??
      findUniqueByName(existing.units, unit.name, (row) => row.name, plan.conflicts);
    const targetId = matched?.id ?? unit.id;
    unitIdMap.set(unit.id, targetId);
    const mappedParent = unit.parentId ? unitIdMap.get(unit.parentId) : undefined;
    if (unit.parentId && !mappedParent) {
      plan.conflicts.push(`Unit ${unit.id} parent ${unit.parentId} was not ordered before it.`);
      continue;
    }
    if (!matched) {
      const doc: OrgUnit = {
        id: targetId,
        kind: "unit",
        name: unit.name,
        parentId: mappedParent,
        purpose: unit.purpose,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      plan.creates.push(change("unit", doc.id, doc.name, ["name", "parentId", "purpose"]));
      plan.writes.push(doc);
      continue;
    }
    const doc: OrgUnit = { ...matched };
    const fields: string[] = [];
    fill(doc, "parentId", mappedParent, fields);
    fill(doc, "purpose", unit.purpose, fields);
    if (fields.length) {
      doc.updatedAt = now;
      plan.updates.push(change("unit", doc.id, doc.name, fields));
      plan.writes.push(doc);
    } else {
      plan.unchanged.push(change("unit", doc.id, doc.name));
    }
  }

  for (const person of seed.people) {
    const directoryId = directory.length
      ? exactDirectoryId(person, directory, plan.unresolvedIdentities)
      : person.entraId;
    const byId = existing.people.find((row) => row.id === person.id);
    const byEntra = (person.entraId ?? directoryId)
      ? existing.people.filter(
          (row) =>
            row.entraId?.toLowerCase() === (person.entraId ?? directoryId)?.toLowerCase()
        )
      : [];
    if (byEntra.length > 1) {
      plan.conflicts.push(`${person.displayName}: multiple records share the same Entra id.`);
      continue;
    }
    const byName = findUniqueByName(
      existing.people,
      person.displayName,
      (row) => row.displayName,
      plan.conflicts
    );
    const candidates = [...new Set([byId, byEntra[0], byName].filter(Boolean))];
    if (candidates.length > 1) {
      plan.conflicts.push(`${person.displayName}: id, Entra id, and name resolve to different records.`);
      continue;
    }
    const matched = candidates[0] as OrgPerson | undefined;
    const targetId = matched?.id ?? person.id;
    personIdMap.set(person.id, targetId);
    const mappedUnit = person.unitId ? unitIdMap.get(person.unitId) : undefined;
    if (person.unitId && !mappedUnit) {
      plan.conflicts.push(`Person ${person.id} references unresolved unit ${person.unitId}.`);
      continue;
    }
    if (!matched) {
      const doc: OrgPerson = {
        id: targetId,
        kind: "person",
        displayName: person.displayName,
        entraId: person.entraId ?? directoryId,
        aliases: person.aliases,
        unitId: mappedUnit,
        title: person.title,
        mandate: person.mandate,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      plan.creates.push(
        change("person", doc.id, doc.displayName, [
          "displayName",
          "entraId",
          "aliases",
          "unitId",
          "title",
          "mandate",
        ].filter((field) => !isEmpty(doc[field as keyof OrgPerson])))
      );
      plan.writes.push(doc);
      continue;
    }
    const doc: OrgPerson = { ...matched, aliases: [...matched.aliases] };
    const fields: string[] = [];
    fill(doc, "entraId", person.entraId ?? directoryId, fields);
    fill(doc, "aliases", person.aliases, fields);
    fill(doc, "unitId", mappedUnit, fields);
    fill(doc, "title", person.title, fields);
    fill(doc, "mandate", person.mandate, fields);
    if (fields.length) {
      doc.updatedAt = now;
      plan.updates.push(change("person", doc.id, doc.displayName, fields));
      plan.writes.push(doc);
    } else {
      plan.unchanged.push(change("person", doc.id, doc.displayName));
    }
  }

  for (const role of seed.roles) {
    const mappedPerson = personIdMap.get(role.personId);
    const mappedUnit = role.unitId ? unitIdMap.get(role.unitId) : undefined;
    if (!mappedPerson) {
      plan.conflicts.push(`Role ${role.id} references unresolved person ${role.personId}.`);
      continue;
    }
    if (role.unitId && !mappedUnit) {
      plan.conflicts.push(`Role ${role.id} references unresolved unit ${role.unitId}.`);
      continue;
    }
    const byId = existing.roles.find((row) => row.id === role.id);
    const semantic = existing.roles.filter(
      (row) =>
        row.personId === mappedPerson &&
        normalizeOrgName(row.title) === normalizeOrgName(role.title) &&
        (row.unitId ?? "") === (mappedUnit ?? "")
    );
    if (semantic.length > 1) {
      plan.conflicts.push(`Role ${role.id} matches multiple existing roles.`);
      continue;
    }
    const candidates = [...new Set([byId, semantic[0]].filter(Boolean))];
    if (candidates.length > 1) {
      plan.conflicts.push(`Role ${role.id} id and semantic key resolve differently.`);
      continue;
    }
    const matched = candidates[0] as OrgRole | undefined;
    if (!matched) {
      const doc: OrgRole = {
        id: role.id,
        kind: "role",
        personId: mappedPerson,
        unitId: mappedUnit,
        title: role.title,
        mandate: role.mandate,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      plan.creates.push(change("role", doc.id, doc.title, ["personId", "unitId", "title", "mandate"]));
      plan.writes.push(doc);
      continue;
    }
    const doc: OrgRole = { ...matched };
    const fields: string[] = [];
    fill(doc, "unitId", mappedUnit, fields);
    fill(doc, "mandate", role.mandate, fields);
    if (fields.length) {
      doc.updatedAt = now;
      plan.updates.push(change("role", doc.id, doc.title, fields));
      plan.writes.push(doc);
    } else {
      plan.unchanged.push(change("role", doc.id, doc.title));
    }
  }

  plan.conflicts = [...new Set(plan.conflicts)];
  plan.unresolvedIdentities = [...new Set(plan.unresolvedIdentities)];
  if (plan.conflicts.length) plan.writes = [];
  return plan;
}
