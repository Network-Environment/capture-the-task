import "./setup";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { parseOrgSeed, planOrgImport, validateOrgSeed } from "../src/org/import";
import {
  compactOrgPrompt,
  ORG_PROMPT_CAP,
  parseAliases,
  resolvePerson,
  searchOrgDirectory,
} from "../src/org/resolve";
import type { OrgDirectory, OrgPerson } from "../src/org/types";

function person(over: Partial<OrgPerson> & Pick<OrgPerson, "id" | "displayName">): OrgPerson {
  return {
    kind: "person",
    aliases: [],
    mandate: "",
    status: "active",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    ...over,
  };
}

const val = person({
  id: "per-val",
  displayName: "Valerie Moraru",
  aliases: ["Val"],
  title: "PMO",
  mandate: "Keep the risk register honest",
  entraId: "4f323599-0df8-47f7-aa01-46dbb211894c",
});
const adam = person({
  id: "per-adam",
  displayName: "Adam McCurry",
  aliases: ["Adam"],
  title: "Ops",
  mandate: "Own TaskBrain and follow-through",
});
const dir: OrgDirectory = {
  units: [
    {
      id: "unt-ops",
      kind: "unit",
      name: "Ops",
      purpose: "Keep the business running",
      status: "active",
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:00:00Z",
    },
    {
      id: "unt-old",
      kind: "unit",
      name: "Legacy",
      purpose: "archived team",
      status: "archived",
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:00:00Z",
    },
  ],
  people: [val, adam, person({ id: "per-gone", displayName: "Departed", status: "inactive" })],
  roles: [
    {
      id: "rol-risk",
      kind: "role",
      personId: "per-val",
      title: "Risk owner",
      unitId: "unt-ops",
      mandate: "Flag overdue risks weekly",
      status: "active",
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:00:00Z",
    },
  ],
};

describe("org directory", () => {
  it("resolves entra id, display name, alias, and unique first name", () => {
    const people = dir.people;
    assert.equal(resolvePerson(people, { ownerId: val.entraId })?.id, "per-val");
    assert.equal(resolvePerson(people, { ownerName: "Valerie Moraru" })?.id, "per-val");
    assert.equal(resolvePerson(people, { ownerName: "Val" })?.id, "per-val");
    assert.equal(resolvePerson(people, { ownerName: "Valerie" })?.id, "per-val");
    assert.equal(resolvePerson(people, { ownerName: "Nobody" }), undefined);
    assert.equal(resolvePerson(people, { ownerName: "Departed" }), undefined);
  });

  it("parses aliases and searches people, teams, and roles", () => {
    assert.deepEqual(parseAliases("Val, Valerie; V"), ["Val", "Valerie", "V"]);
    const hits = searchOrgDirectory(dir, "risk");
    assert.equal(hits.people.some((p) => p.id === "per-val"), true);
    assert.equal(hits.roles.some((r) => r.id === "rol-risk"), true);
    assert.equal(searchOrgDirectory(dir, "ops").units[0]?.id, "unt-ops");
  });

  it("prompt snapshot joins roles, skips inactive, and caps length", () => {
    const block = compactOrgPrompt(dir);
    assert.match(block, /Valerie Moraru/);
    assert.match(block, /Risk owner @ Ops/);
    assert.match(block, /Keep the risk register honest/);
    assert.match(block, /Work: teams \+ Teams card/);
    assert.doesNotMatch(block, /Departed/);
    assert.doesNotMatch(block, /Legacy/);
    const huge: OrgDirectory = {
      units: dir.units,
      roles: [],
      people: Array.from({ length: 80 }, (_, i) =>
        person({
          id: `p${i}`,
          displayName: `Person ${i} with a very long mandate line`,
          mandate: "x".repeat(80),
        })
      ),
    };
    const capped = compactOrgPrompt(huge);
    assert.ok(capped.length <= ORG_PROMPT_CAP);
    assert.match(capped, /truncated/);
  });

  it("validates the reviewed org seed without inventing titles or reporting lines", () => {
    const seed = parseOrgSeed(
      JSON.parse(
        readFileSync(
          resolve(process.cwd(), "data/org/ryalto-org-lite.json"),
          "utf8"
        )
      )
    );
    assert.deepEqual(validateOrgSeed(seed), []);
    assert.equal(
      seed.units.find((unit) => unit.id === "unt-network-environments")?.parentId,
      "unt-ryalto-holdings"
    );
    assert.equal(
      seed.units.find((unit) => unit.id === "unt-gra")?.parentId,
      "unt-ryalto-holdings"
    );
    assert.equal(seed.people.some((row) => "managerPersonId" in row), false);
    assert.equal(
      JSON.stringify(seed).toLowerCase().includes('"coo"'),
      false
    );
    assert.equal(
      seed.roles.find((role) => role.id === "rol-joe-visionary")?.title,
      "Visionary"
    );
    assert.equal(
      seed.roles.filter((role) => role.personId === "per-valerie-moraru").length,
      3
    );
  });

  it("plans an idempotent seed and enriches only exact complete identities", () => {
    const seed = parseOrgSeed(
      JSON.parse(
        readFileSync(resolve(process.cwd(), "data/org/ryalto-org-lite.json"), "utf8")
      )
    );
    const empty: OrgDirectory = { units: [], people: [], roles: [] };
    const first = planOrgImport(
      seed,
      empty,
      [
        { id: "entra-joe", displayName: "Joe Ryan" },
        { id: "entra-shelly", displayName: "Shelly" },
      ],
      "2026-09-17T00:00:00Z"
    );
    assert.deepEqual(first.conflicts, []);
    assert.equal(first.creates.length, seed.units.length + seed.people.length + seed.roles.length);
    const joe = first.writes.find(
      (row): row is OrgPerson => row.kind === "person" && row.id === "per-joe-ryan"
    );
    const shelly = first.writes.find(
      (row): row is OrgPerson => row.kind === "person" && row.id === "per-shelly-incomplete"
    );
    assert.equal(joe?.entraId, "entra-joe");
    assert.equal(shelly?.entraId, undefined);
    assert.ok(first.unresolvedIdentities.some((item) => item.startsWith("Shelly:")));
    const elisa = first.writes.find(
      (row): row is OrgPerson => row.kind === "person" && row.id === "per-elisa-amador"
    );
    assert.equal(elisa?.entraId, undefined);
    assert.ok(first.unresolvedIdentities.some((item) => item.startsWith("Elisa Amador:")));

    const imported: OrgDirectory = {
      units: first.writes.filter((row) => row.kind === "unit"),
      people: first.writes.filter((row): row is OrgPerson => row.kind === "person"),
      roles: first.writes.filter((row) => row.kind === "role"),
    };
    const second = planOrgImport(
      seed,
      imported,
      [{ id: "entra-joe", displayName: "Joe Ryan" }],
      "2026-09-18T00:00:00Z"
    );
    assert.deepEqual(second.conflicts, []);
    assert.equal(second.writes.length, 0);
    assert.equal(second.unchanged.length, first.creates.length);
  });

  it("fills missing fields without overwriting curated person data", () => {
    const seed = parseOrgSeed(
      JSON.parse(
        readFileSync(resolve(process.cwd(), "data/org/ryalto-org-lite.json"), "utf8")
      )
    );
    const curatedVal = person({
      id: "per-valerie-moraru",
      displayName: "Valerie Moraru",
      aliases: ["VM"],
      title: "Curated title",
      mandate: "Curated mandate",
      executionQueues: ["planner"],
      nudgeChannel: "teams_chat",
      workingNotes: "Keep this",
      prefSource: "admin",
    });
    const plan = planOrgImport(
      seed,
      { units: [], people: [curatedVal], roles: [] },
      [{ id: "entra-val", displayName: "Valerie Moraru" }],
      "2026-09-17T00:00:00Z"
    );
    assert.deepEqual(plan.conflicts, []);
    const updated = plan.writes.find(
      (row): row is OrgPerson => row.kind === "person" && row.id === curatedVal.id
    );
    assert.equal(updated?.entraId, "entra-val");
    assert.equal(updated?.unitId, "unt-admin-ryalto");
    assert.deepEqual(updated?.aliases, ["VM"]);
    assert.equal(updated?.title, "Curated title");
    assert.equal(updated?.mandate, "Curated mandate");
    assert.deepEqual(updated?.executionQueues, ["planner"]);
    assert.equal(updated?.nudgeChannel, "teams_chat");
    assert.equal(updated?.workingNotes, "Keep this");
    assert.equal(updated?.prefSource, "admin");
  });

  it("fails closed on bad references and cycles, and skips duplicate directory identities", () => {
    const seed = parseOrgSeed(
      JSON.parse(
        readFileSync(resolve(process.cwd(), "data/org/ryalto-org-lite.json"), "utf8")
      )
    );
    const broken = structuredClone(seed);
    broken.units[0].parentId = broken.units[1].id;
    broken.units[1].parentId = broken.units[0].id;
    broken.roles[0].personId = "missing-person";
    const errors = validateOrgSeed(broken);
    assert.ok(errors.some((error) => error.includes("parent cycle")));
    assert.ok(errors.some((error) => error.includes("unknown personId")));

    const ambiguous = planOrgImport(
      seed,
      { units: [], people: [], roles: [] },
      [
        { id: "joe-1", displayName: "Joe Ryan" },
        { id: "joe-2", displayName: "Joe Ryan" },
        { id: "entra-val", displayName: "Valerie Moraru" },
      ]
    );
    assert.deepEqual(ambiguous.conflicts, []);
    assert.ok(ambiguous.unresolvedIdentities.some((item) => item.includes("Joe Ryan")));
    const valerie = ambiguous.writes.find(
      (row): row is OrgPerson => row.kind === "person" && row.id === "per-valerie-moraru"
    );
    assert.equal(valerie?.entraId, "entra-val");
    const joe = ambiguous.writes.find(
      (row): row is OrgPerson => row.kind === "person" && row.id === "per-joe-ryan"
    );
    assert.equal(joe?.entraId, undefined);
    assert.ok(ambiguous.writes.length > 0);
  });
});
