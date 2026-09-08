import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
