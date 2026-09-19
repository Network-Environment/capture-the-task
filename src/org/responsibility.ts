import { canApplyPref } from "./prefs";
import { normalizeOrgName } from "./resolve";
import type {
  CapacityStatus,
  OrgPerson,
  OrgRole,
  PrefSource,
} from "./types";

export interface PersonResponsibilityPatch {
  mandate?: string;
  capacityStatus?: CapacityStatus;
  capacityNote?: string;
}

export interface HatPatch {
  title: string;
  mandate: string;
  unitId?: string;
}

export function applyPersonResponsibility(
  person: OrgPerson,
  patch: PersonResponsibilityPatch,
  source: PrefSource,
  now: string
): { person: OrgPerson; changed: string[]; blocked: string[] } {
  const next: OrgPerson = { ...person };
  const changed: string[] = [];
  const blocked: string[] = [];

  if (patch.mandate !== undefined) {
    const mandate = patch.mandate.trim().slice(0, 400);
    if (!canApplyPref(person.mandateSource, source)) {
      blocked.push(`mandate locked as ${person.mandateSource}`);
    } else if (mandate && mandate !== person.mandate) {
      next.mandate = mandate;
      next.mandateSource = source;
      changed.push("mandate");
    }
  }

  if (patch.capacityStatus !== undefined || patch.capacityNote !== undefined) {
    if (!canApplyPref(person.capacitySource, source)) {
      blocked.push(`capacity locked as ${person.capacitySource}`);
    } else {
      if (patch.capacityStatus && patch.capacityStatus !== person.capacityStatus) {
        next.capacityStatus = patch.capacityStatus;
        changed.push("capacityStatus");
      }
      if (patch.capacityNote !== undefined) {
        const note = patch.capacityNote.trim().slice(0, 120) || undefined;
        if (note !== person.capacityNote) {
          next.capacityNote = note;
          changed.push("capacityNote");
        }
      }
      if (changed.includes("capacityStatus") || changed.includes("capacityNote")) {
        next.capacitySource = source;
      }
    }
  }

  if (changed.length) next.updatedAt = now;
  return { person: next, changed, blocked };
}

export function applyHat(
  roles: OrgRole[],
  personId: string,
  patch: HatPatch,
  source: PrefSource,
  now: string,
  newId: () => string
): { role: OrgRole; created: boolean; blocked?: string } {
  const title = patch.title.trim().slice(0, 80);
  const mandate = patch.mandate.trim().slice(0, 400);
  const unitId = patch.unitId || undefined;
  const existing = roles.find(
    (role) =>
      role.personId === personId &&
      role.status === "active" &&
      normalizeOrgName(role.title) === normalizeOrgName(title) &&
      (role.unitId ?? "") === (unitId ?? "")
  );
  if (!existing) {
    return {
      created: true,
      role: {
        id: newId(),
        kind: "role",
        personId,
        title,
        unitId,
        mandate,
        mandateSource: source,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    };
  }
  if (!canApplyPref(existing.mandateSource, source)) {
    return { role: existing, created: false, blocked: `role "${existing.title}" locked as ${existing.mandateSource}` };
  }
  return {
    created: false,
    role: {
      ...existing,
      mandate,
      mandateSource: source,
      updatedAt: now,
    },
  };
}
