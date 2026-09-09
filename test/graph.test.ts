import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphEdge, GraphNode } from "../src/graph/types";
import {
  clampGraphDepth,
  clampGraphLimit,
  dependencyWouldCycle,
  deterministicEdgeId,
  deterministicGraphId,
  findDependencyCycles,
  mergeGraphNodePatch,
  validateEdgeInput,
  validateNodeInput,
  visibleTo,
} from "../src/graph/validation";
import { nativeToolCatalog } from "../src/tools/registry";

const node = (
  id: string,
  type: GraphNode["type"],
  visibility: GraphNode["visibility"] = "workspace",
  privateOwnerId?: string
): GraphNode => ({
  id,
  workspaceId: "org",
  docType: "node",
  type,
  title: id,
  visibility,
  privateOwnerId,
  provenance: "human",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 1,
});

const edge = (fromId: string, toId: string): GraphEdge => ({
  id: `${fromId}-${toId}`,
  workspaceId: "org",
  docType: "edge",
  fromId,
  toId,
  type: "depends_on",
  reviewState: "accepted",
  provenance: "human",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 1,
});

describe("execution graph invariants", () => {
  it("validates node content and private ownership", () => {
    assert.doesNotThrow(() => validateNodeInput({ type: "task", title: "Ship graph" }));
    assert.throws(
      () => validateNodeInput({ type: "task", title: "Private", visibility: "private" }),
      /privateOwnerId/
    );
    assert.throws(
      () => validateNodeInput({ type: "task", title: "Bad date", due: "someday" }),
      /ISO-8601/
    );
  });

  it("only permits semantically valid edge endpoint types", () => {
    assert.doesNotThrow(() =>
      validateEdgeInput(
        { fromId: "t", toId: "p", type: "part_of" },
        node("t", "task"),
        node("p", "project")
      )
    );
    assert.throws(
      () =>
        validateEdgeInput(
          { fromId: "person", toId: "task", type: "assigned_to" },
          node("person", "person"),
          node("task", "task")
        ),
      /cannot connect/
    );
    assert.throws(
      () =>
        validateEdgeInput(
          { fromId: "x", toId: "x", type: "related_to" },
          node("x", "task"),
          node("x", "task")
        ),
      /cannot link to itself/
    );
  });

  it("detects multi-hop dependency cycles and ignores proposals", () => {
    const accepted = [edge("a", "b"), edge("b", "c")];
    assert.equal(dependencyWouldCycle("c", "a", accepted), true);
    assert.equal(dependencyWouldCycle("c", "d", accepted), false);
    assert.equal(
      dependencyWouldCycle("c", "a", [{ ...edge("a", "b"), reviewState: "proposed" }]),
      false
    );
    assert.deepEqual(
      findDependencyCycles([
        { fromId: "a", toId: "b" },
        { fromId: "b", toId: "c" },
        { fromId: "c", toId: "a" },
      ]),
      [["a", "b", "c", "a"]]
    );
  });

  it("enforces traversal caps, visibility, and deterministic ids", () => {
    assert.equal(clampGraphDepth(99), 2);
    assert.equal(clampGraphDepth(-1), 0);
    assert.equal(clampGraphDepth(0), 0);
    assert.equal(clampGraphLimit(999), 100);
    assert.equal(visibleTo(node("shared", "task"), "u2"), true);
    assert.equal(visibleTo(node("private", "task", "private", "u1"), "u2"), false);
    assert.equal(visibleTo(node("private", "task", "private", "u1"), "u1"), true);
    assert.equal(deterministicGraphId("Meeting", "ABC / 123"), "meeting:abc---123");
    assert.equal(
      deterministicEdgeId("task:1", "part_of", "project:2"),
      "task:1|part_of|project:2"
    );
  });

  it("hides graph tools until their rollout flags are enabled", () => {
    const priorRead = process.env.EXECUTION_GRAPH_ENABLED;
    const priorWrite = process.env.EXECUTION_GRAPH_WRITES_ENABLED;
    try {
      process.env.EXECUTION_GRAPH_ENABLED = "false";
      process.env.EXECUTION_GRAPH_WRITES_ENABLED = "false";
      assert.equal(nativeToolCatalog().some((tool) => tool.name.includes("graph")), false);

      process.env.EXECUTION_GRAPH_ENABLED = "true";
      assert.equal(
        nativeToolCatalog().some((tool) => tool.name === "search_execution_graph"),
        true
      );
      assert.equal(
        nativeToolCatalog().some((tool) => tool.name === "create_graph_task"),
        false
      );

      process.env.EXECUTION_GRAPH_WRITES_ENABLED = "true";
      assert.equal(
        nativeToolCatalog().some((tool) => tool.name === "create_graph_task"),
        true
      );
    } finally {
      if (priorRead === undefined) delete process.env.EXECUTION_GRAPH_ENABLED;
      else process.env.EXECUTION_GRAPH_ENABLED = priorRead;
      if (priorWrite === undefined) delete process.env.EXECUTION_GRAPH_WRITES_ENABLED;
      else process.env.EXECUTION_GRAPH_WRITES_ENABLED = priorWrite;
    }
  });

  it("preserves omitted fields in partial updates and clears explicit nulls", () => {
    const current = {
      ...node("task:1", "task"),
      title: "Keep this title",
      description: "Old detail",
      ownerPersonId: "person:1",
      due: "2026-10-01",
      status: "open" as const,
    };
    const statusOnly = mergeGraphNodePatch(current, { status: "blocked" });
    assert.equal(statusOnly.title, "Keep this title");
    assert.equal(statusOnly.description, "Old detail");
    assert.equal(statusOnly.ownerPersonId, "person:1");
    assert.equal(statusOnly.status, "blocked");

    const cleared = mergeGraphNodePatch(current, {
      description: null,
      ownerPersonId: null,
      due: null,
    });
    assert.equal(cleared.title, "Keep this title");
    assert.equal(cleared.description, undefined);
    assert.equal(cleared.ownerPersonId, undefined);
    assert.equal(cleared.due, undefined);
  });
});
