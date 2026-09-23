import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  peopleInScope,
  riskForItem,
} from "../src/org/followthrough";
import {
  formatAssigneeSuggestions,
  rankAssignees,
} from "../src/org/assess";
import { matchCheckInUpdates } from "../src/org/checkins";
import type { OrgDirectory, OrgPerson } from "../src/org/types";
import type { PersonWorkload, WorkloadItem } from "../src/org/workload";

function person(
  over: Partial<OrgPerson> & Pick<OrgPerson, "id" | "displayName">
): OrgPerson {
  return {
    kind: "person",
    aliases: [],
    mandate: "",
    status: "active",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

const manager = person({
  id: "per-manager",
  displayName: "Manager",
  mandate: "Run operations and risk reviews",
});
const val = person({
  id: "per-val",
  displayName: "Val",
  managerPersonId: manager.id,
  mandate: "Own risk register and project follow-through",
  capacityStatus: "available",
});
const overloaded = person({
  id: "per-busy",
  displayName: "Busy",
  managerPersonId: manager.id,
  mandate: "Own risk register and project follow-through",
  capacityStatus: "overloaded",
});
const dir: OrgDirectory = {
  units: [],
  people: [manager, val, overloaded],
  roles: [],
};

describe("org follow-through risk", () => {
  it("classifies overdue, due-soon, blocked, and inactive work", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const base: WorkloadItem = {
      source: "work",
      id: "w1",
      title: "Risk review",
      updatedAt: "2026-09-10T12:00:00Z",
      due: "2026-09-22",
      status: "blocked",
    };
    assert.deepEqual(
      riskForItem(base, now, { dueSoonDays: 2, inactiveDays: 5 }).sort(),
      ["blocked", "inactive", "overdue"]
    );
    assert.deepEqual(
      riskForItem(
        { ...base, due: "2026-09-25", updatedAt: "2026-09-23T10:00:00Z", status: "open" },
        now,
        { dueSoonDays: 2, inactiveDays: 5 }
      ),
      ["due_soon"]
    );
  });

  it("uses only explicit direct reports for manager scope", () => {
    assert.deepEqual(
      peopleInScope(dir, { kind: "manager", managerPersonId: manager.id })
        .map((row) => row.id)
        .sort(),
      ["per-busy", "per-manager", "per-val"]
    );
    assert.deepEqual(
      peopleInScope(dir, { kind: "manager", managerPersonId: val.id }).map(
        (row) => row.id
      ),
      ["per-val"]
    );
  });
});

describe("daily check-in replies", () => {
  it("accepts only exact source and item references from the sent check-in", () => {
    const checkIn = {
      items: [
        { source: "work" as const, id: "w-1", title: "Risk review" },
        { source: "pmo" as const, id: "p-1", title: "Launch plan" },
      ],
    };
    const result = matchCheckInUpdates(checkIn, [
      { source: "work", id: "w-1", status: "done" },
      { source: "graph", id: "w-1", status: "done" },
    ]);
    assert.deepEqual(result.matched, [
      { source: "work", id: "w-1", status: "done" },
    ]);
    assert.equal(result.hasUnknown, true);
  });
});

describe("fair assignment ranking", () => {
  it("penalizes overload, risk-weighted load, and recent assignment share", () => {
    const empty = (): PersonWorkload => ({
      items: [],
      counts: { work: 0, commitment: 0, graph: 0, pmo: 0 },
    });
    const busyLoad = empty();
    busyLoad.items = [
      {
        source: "work",
        id: "w-busy",
        title: "Late risk",
        effort: 5,
        due: "2026-09-20",
        updatedAt: "2026-09-01T00:00:00Z",
      },
    ];
    const ranked = rankAssignees({
      taskText: "update the risk register",
      effort: 3,
      dir,
      workloads: new Map([
        [manager.id, empty()],
        [val.id, empty()],
        [overloaded.id, busyLoad],
      ]),
      recentAssignments: new Map([
        [val.id, 1],
        [overloaded.id, 7],
      ]),
      now: new Date("2026-09-23T12:00:00Z"),
    });
    assert.equal(ranked[0]?.person.id, val.id);
    assert.ok(
      ranked.find((row) => row.person.id === val.id)!.total >
        ranked.find((row) => row.person.id === overloaded.id)!.total
    );
    assert.match(formatAssigneeSuggestions(ranked), /recent assignments/);
  });
});
