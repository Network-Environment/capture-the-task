import type { OrgDirectory, OrgPerson, OrgRole, OrgUnit } from "./types";

export const ORG_PROMPT_CAP = 4000;

export function normalizeOrgName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function slugPart(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "item";
}

export function newOrgId(kind: "unit" | "person" | "role", name: string): string {
  return `${kind.slice(0, 3)}-${slugPart(name)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseAliases(raw: string): string[] {
  return [...new Set(raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 12);
}

export function resolvePerson(
  people: OrgPerson[],
  query: { ownerId?: string; ownerName?: string }
): OrgPerson | undefined {
  const active = people.filter((p) => p.status === "active");
  const entra = query.ownerId?.trim().toLowerCase();
  if (entra) {
    const byEntra = active.find((p) => p.entraId?.toLowerCase() === entra);
    if (byEntra) return byEntra;
  }
  const name = query.ownerName ? normalizeOrgName(query.ownerName) : "";
  if (!name) return undefined;

  const exact = active.find(
    (p) =>
      normalizeOrgName(p.displayName) === name ||
      p.aliases.some((a) => normalizeOrgName(a) === name)
  );
  if (exact) return exact;

  const first = name.split(" ")[0] ?? "";
  if (first.length < 2) return undefined;
  const firstHits = active.filter((p) => {
    const given = normalizeOrgName(p.displayName).split(" ")[0];
    return (
      given === first ||
      p.aliases.some((a) => normalizeOrgName(a).split(" ")[0] === first)
    );
  });
  return firstHits.length === 1 ? firstHits[0] : undefined;
}

export function searchOrgDirectory(dir: OrgDirectory, query: string): {
  people: OrgPerson[];
  units: OrgUnit[];
  roles: OrgRole[];
} {
  const q = normalizeOrgName(query);
  if (!q) return { people: [], units: [], roles: [] };
  const units = dir.units.filter(
    (u) => u.status === "active" && (normalizeOrgName(u.name).includes(q) || normalizeOrgName(u.purpose).includes(q))
  );
  const people = dir.people.filter((p) => {
    if (p.status !== "active") return false;
    const blob = [p.displayName, p.title, p.mandate, p.entraId, ...p.aliases].join(" ");
    return normalizeOrgName(blob).includes(q);
  });
  const personIds = new Set(people.map((p) => p.id));
  const roles = dir.roles.filter((r) => {
    if (r.status !== "active") return false;
    if (personIds.has(r.personId)) return true;
    return normalizeOrgName(`${r.title} ${r.mandate}`).includes(q);
  });
  return { people, units, roles };
}

export function compactOrgPrompt(dir: OrgDirectory, cap = ORG_PROMPT_CAP): string {
  const unitById = new Map(dir.units.map((u) => [u.id, u]));
  const personById = new Map(dir.people.map((p) => [p.id, p]));
  const activeUnits = dir.units.filter((u) => u.status === "active");
  const activePeople = dir.people.filter((p) => p.status === "active");
  const activeRoles = dir.roles.filter((r) => r.status === "active");
  if (!activeUnits.length && !activePeople.length) return "";

  const teamLines = activeUnits.map((u) => {
    const parent = u.parentId ? unitById.get(u.parentId)?.name : undefined;
    const purpose = u.purpose ? `: ${u.purpose}` : "";
    return `- ${u.name}${parent ? ` (under ${parent})` : ""}${purpose}`;
  });
  const peopleLines = activePeople.map((p) => {
    const team = p.unitId ? unitById.get(p.unitId)?.name : undefined;
    const manager = p.managerPersonId ? personById.get(p.managerPersonId)?.displayName : undefined;
    const hats = activeRoles
      .filter((r) => r.personId === p.id)
      .map((r) => {
        const ru = r.unitId ? unitById.get(r.unitId)?.name : undefined;
        return `${r.title}${ru ? ` @ ${ru}` : ""}${r.mandate ? `: ${r.mandate}` : ""}`;
      });
    const bits = [
      p.title,
      team ? `team ${team}` : undefined,
      manager ? `reports to ${manager}` : undefined,
    ].filter(Boolean);
    const mandate = p.mandate ? ` Should: ${p.mandate}` : "";
    const roles = hats.length ? ` Roles: ${hats.join("; ")}` : "";
    return `- ${p.displayName}${bits.length ? ` (${bits.join(", ")})` : ""}.${mandate}${roles}`;
  });

  let text =
    "\n\nOrg directory (structure and what people should be doing; use list_commitments / lookup_org for what they are doing):\n";
  if (teamLines.length) text += `Teams:\n${teamLines.join("\n")}\n`;
  if (peopleLines.length) text += `People:\n${peopleLines.join("\n")}\n`;
  if (text.length <= cap) return text;
  const suffix = "\n[org directory truncated]";
  return `${text.slice(0, Math.max(0, cap - suffix.length)).trimEnd()}${suffix}`.slice(0, cap);
}
