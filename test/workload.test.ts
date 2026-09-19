import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFit, formatAssessment, scorePeople } from "../src/org/assess";
import type { OrgDirectory, OrgPerson } from "../src/org/types";
import { assembleWorkload, loadPressure, plateCountsLine } from "../src/org/workload";
import type { CommitmentDoc } from "../src/meetings/types";
import type { GraphNode } from "../src/graph/types";
import type { PmoBoard, PmoItem } from "../src/pmo/types";
import type { WorkAssignment } from "../src/work/types";

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
  title: "PMO",
  mandate: "Keep the risk register honest",
  unitId: "unt-ops",
  capacityStatus: "stretched",
});
const adam = person({
  id: "per-adam",
  displayName: "Adam McCurry",
  mandate: "Own TaskBrain and follow-through engineering",
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
  ],
  people: [val, adam],
  roles: [
    {
      id: "rol-risk",
      kind: "role",
      personId: "per-val",
      title: "Risk owner",
      mandate: "Flag overdue risks weekly",
      status: "active",
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:00:00Z",
    },
  ],
};

describe("workload plate", () => {
  it("counts sources and drops PMO/graph copies of the same work or commitment", () => {
    const work: WorkAssignment[] = [
      {
        id: "wk-1",
        ownerPersonId: "per-val",
        title: "Update risk register",
        status: "open",
        source: "chat",
        sourceId: "cmt-1",
        destinations: [],
        createdAt: "2026-09-19T00:00:00Z",
        updatedAt: "2026-09-19T00:00:00Z",
      },
    ];
    const commitments: CommitmentDoc[] = [
      {
        id: "cmt-1",
        ownerKey: "val",
        ownerName: "Valerie",
        personId: "per-val",
        text: "Update risk register",
        status: "open",
        sourceMeetingId: "mtg-1",
        sourceTitle: "Staff",
        createdAt: "2026-09-19T00:00:00Z",
        updatedAt: "2026-09-19T00:00:00Z",
      },
    ];
    const board: PmoBoard = {
      id: "board-1",
      boardId: "board-1",
      kind: "board",
      title: "Q4",
      purpose: "",
      status: "open",
      createdBy: "u",
      columns: [{ id: "todo", label: "To do" }],
      fields: [],
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
    };
    const pmoItem: PmoItem = {
      id: "pmo-1",
      boardId: "board-1",
      kind: "item",
      title: "Update risk register",
      columnId: "todo",
      ownerPersonId: "per-val",
      fieldValues: {},
      workId: "wk-1",
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
    };
    const extraPmo: PmoItem = {
      ...pmoItem,
      id: "pmo-2",
      title: "Board-only follow-up",
      workId: undefined,
    };
    const graph: GraphNode[] = [
      {
        id: "graph-cmt",
        workspaceId: "org",
        docType: "node",
        type: "task",
        title: "Update risk register",
        visibility: "workspace",
        provenance: "system",
        createdBy: "sys",
        createdAt: "2026-09-19T00:00:00Z",
        updatedAt: "2026-09-19T00:00:00Z",
        version: 1,
        source: { kind: "commitment", id: "cmt-1" },
      },
      {
        id: "graph-open",
        workspaceId: "org",
        docType: "node",
        type: "task",
        title: "Ship TaskBrain workload view",
        visibility: "workspace",
        provenance: "human",
        createdBy: "u",
        createdAt: "2026-09-19T00:00:00Z",
        updatedAt: "2026-09-19T00:00:00Z",
        version: 1,
      },
    ];
    const load = assembleWorkload({
      work,
      commitments,
      graph,
      pmo: [
        { item: pmoItem, board },
        { item: extraPmo, board },
      ],
    });
    assert.equal(load.counts.work, 1);
    assert.equal(load.counts.commitment, 1);
    assert.equal(load.counts.pmo, 1);
    assert.equal(load.counts.graph, 1);
    assert.equal(load.items.some((item) => item.id === "pmo-1"), false);
    assert.equal(load.items.some((item) => item.id === "graph-cmt"), false);
    assert.equal(load.items.some((item) => item.id === "graph-open"), true);
    assert.match(plateCountsLine(load), /1 work, 1 commitments, 1 graph, 1 PMO/);
  });
});

describe("assignment fit", () => {
  it("scores mandate overlap and suggests stronger alternatives", () => {
    assert.equal(classifyFit(0, 0), "unknown");
    assert.equal(classifyFit(0, 4), "weak");
    assert.equal(classifyFit(1, 4), "strong");
    const ranked = scorePeople("update the risk register this week", dir);
    const valScore = ranked.find((row) => row.person.id === "per-val");
    const adamScore = ranked.find((row) => row.person.id === "per-adam");
    assert.equal(valScore?.fit, "strong");
    assert.ok((valScore?.score ?? 0) > (adamScore?.score ?? 0));

    const weak = scorePeople("rewrite the TaskBrain bot adapter", dir);
    const valWeak = weak.find((row) => row.person.id === "per-val");
    const alts = weak
      .filter((row) => row.person.id !== "per-val" && row.score > (valWeak?.score ?? 0))
      .slice(0, 3);
    const load = assembleWorkload({ work: [], commitments: [], graph: [], pmo: [] });
    const text = formatAssessment({
      person: { ...val, capacityStatus: "overloaded" },
      title: "rewrite the TaskBrain bot adapter",
      fit: "weak",
      score: valWeak?.score ?? 0,
      alternatives: alts,
      load,
      dir,
    });
    assert.match(text, /Fit: weak/);
    assert.match(text, /Adam McCurry/);
    assert.match(text, /Assign only if they still want Valerie Moraru/);
    assert.match(loadPressure({ ...val, capacityStatus: "overloaded" }, load) ?? "", /overloaded/);
  });
});
