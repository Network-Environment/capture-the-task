import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline } from "../src/graph/timeline";
import type { GraphEdge, GraphNode } from "../src/graph/types";

const now = "2026-09-23T00:00:00Z";

function task(
  id: string,
  title: string,
  over: Partial<GraphNode> = {}
): GraphNode {
  return {
    id,
    workspaceId: "org",
    docType: "node",
    type: "task",
    title,
    status: "open",
    visibility: "workspace",
    provenance: "human",
    createdBy: "u",
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...over,
  };
}

function dependency(fromId: string, toId: string): GraphEdge {
  return {
    id: `${fromId}-${toId}`,
    workspaceId: "org",
    docType: "edge",
    fromId,
    toId,
    type: "depends_on",
    reviewState: "accepted",
    provenance: "human",
    createdBy: "u",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

describe("graph timeline", () => {
  it("schedules prerequisites first and serializes one owner's work", () => {
    const result = buildTimeline(
      [
        task("a", "Discovery", { ownerPersonId: "p1", effort: 2 }),
        task("b", "Build", { ownerPersonId: "p1", effort: 3 }),
        task("c", "Launch", { ownerPersonId: "p2", effort: 1 }),
      ],
      [dependency("b", "a"), dependency("c", "b")],
      { startDate: "2026-09-21", targetDate: "2026-09-30" }
    );
    assert.deepEqual(result.rows.map((row) => row.id), ["a", "b", "c"]);
    assert.equal(result.rows[0].finish, "2026-09-22");
    assert.equal(result.rows[1].start, "2026-09-23");
    assert.equal(result.likelyFinish, "2026-09-28");
    assert.equal(result.feasible, true);
  });

  it("reports cycles and committed-date conflicts", () => {
    const cyclic = buildTimeline(
      [task("a", "A"), task("b", "B")],
      [dependency("a", "b"), dependency("b", "a")],
      { startDate: "2026-09-21" }
    );
    assert.ok(cyclic.cycles.length > 0);

    const conflict = buildTimeline(
      [task("a", "A", { effort: 5, due: "2026-09-22" })],
      [],
      { startDate: "2026-09-21" }
    );
    assert.match(conflict.rows[0].conflicts.join(" "), /after committed due/);
  });

  it("labels missing effort and expands unavailable owner estimates", () => {
    const result = buildTimeline(
      [task("a", "Unknown effort", { ownerPersonId: "p1" })],
      [],
      {
        startDate: "2026-09-21",
        capacity: new Map([["p1", "unavailable"]]),
      }
    );
    assert.equal(result.rows[0].estimatedEffort, true);
    assert.equal(result.rows[0].effort, 3);
    assert.match(result.rows[0].conflicts.join(" "), /unavailable/);
  });
});
