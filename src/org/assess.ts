import { normalizeOrgName } from "./resolve";
import type { OrgDirectory, OrgPerson, OrgRole, OrgUnit } from "./types";
import type { PersonWorkload } from "./workload";
import { loadPressure, plateCountsLine } from "./workload";

export type AssignmentFit = "strong" | "weak" | "unknown";

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "will",
  "please",
  "need",
  "make",
  "take",
  "into",
  "about",
  "doing",
]);

export function responsibilityTokens(
  person: OrgPerson,
  roles: OrgRole[],
  unit?: OrgUnit
): Set<string> {
  const hats = roles.filter((role) => role.personId === person.id && role.status === "active");
  return tokenize(
    [person.mandate, person.title, unit?.purpose, ...hats.map((role) => `${role.title} ${role.mandate}`)].join(" ")
  );
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeOrgName(text).split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function overlapScore(taskTokens: Set<string>, corpus: Set<string>): number {
  let n = 0;
  for (const token of taskTokens) if (corpus.has(token)) n += 1;
  return n;
}

export function classifyFit(score: number, corpusSize: number): AssignmentFit {
  if (corpusSize === 0) return "unknown";
  return score >= 1 ? "strong" : "weak";
}

export function scorePeople(
  taskText: string,
  dir: OrgDirectory
): { person: OrgPerson; score: number; fit: AssignmentFit }[] {
  const taskTokens = tokenize(taskText);
  const unitById = new Map(dir.units.map((unit) => [unit.id, unit]));
  return dir.people
    .filter((person) => person.status === "active")
    .map((person) => {
      const corpus = responsibilityTokens(
        person,
        dir.roles,
        person.unitId ? unitById.get(person.unitId) : undefined
      );
      const score = overlapScore(taskTokens, corpus);
      return { person, score, fit: classifyFit(score, corpus.size) };
    });
}

export function formatAssessment(input: {
  person: OrgPerson;
  title: string;
  fit: AssignmentFit;
  score: number;
  alternatives: { person: OrgPerson; score: number }[];
  load: PersonWorkload;
  dir: OrgDirectory;
}): string {
  const hats = input.dir.roles
    .filter((role) => role.personId === input.person.id && role.status === "active")
    .map((role) => `${role.title}: ${role.mandate}`)
    .join("; ");
  const pressure = loadPressure(input.person, input.load);
  const alts =
    input.fit !== "strong" && input.alternatives.length
      ? ` Stronger mandate overlap: ${input.alternatives
          .map((row) => `${row.person.displayName} (${row.score})`)
          .join(", ")}.`
      : "";
  const advise =
    input.fit === "strong" && !pressure
      ? `Fit looks reasonable for "${input.title}". Assign if the speaker wants that owner.`
      : `Tell the speaker this is a ${input.fit} fit` +
        `${pressure ? ` and ${pressure}` : ""}. Assign only if they still want ${input.person.displayName}.`;
  return [
    `${input.person.displayName}: Should: ${input.person.mandate || "—"}.` +
      `${hats ? ` Roles: ${hats}.` : ""}`,
    `${input.person.capacityStatus ? `Capacity: ${input.person.capacityStatus}${
      input.person.capacityNote ? ` (${input.person.capacityNote})` : ""
    }. ` : ""}${plateCountsLine(input.load)}. Fit: ${input.fit} (overlap ${input.score}).`,
    advise + alts,
  ].join("\n");
}
