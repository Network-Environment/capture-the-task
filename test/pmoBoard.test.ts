import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderPmoBoards } from "../src/admin/dashboard";
import { formatBoard, openPmoBoard } from "../src/pmo/boards";
import {
  findColumn,
  isDoneColumn,
  kanbanColumns,
  parseSchemaParts,
  resolveBoardColumns,
  SCHEMA_REQUIRED_MESSAGE,
} from "../src/pmo/schema";
import type { PmoBoard, PmoItem } from "../src/pmo/types";
import { nativeToolCatalog, operationMetadata } from "../src/tools/registry";

function board(over: Partial<PmoBoard> = {}): PmoBoard {
  const columns = kanbanColumns();
  return {
    id: "brd-test",
    boardId: "brd-test",
    kind: "board",
    title: "Launch week",
    purpose: "Ship the cutover",
    status: "open",
    createdBy: "user-1",
    columns,
    fields: [{ id: "risk", label: "Risk" }],
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...over,
  };
}

function item(over: Partial<PmoItem> = {}): PmoItem {
  return {
    id: "itm-1",
    boardId: "brd-test",
    kind: "item",
    title: "Cut DNS",
    columnId: "to-do",
    fieldValues: { risk: "high" },
    ownerPersonId: "per-valerie-moraru",
    due: "2026-09-22",
    workId: "wrk-1",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...over,
  };
}

describe("pmo boards", () => {
  it("requires columns unless the user asked for a normal kanban", () => {
    assert.throws(() => resolveBoardColumns({}), (err: Error) => {
      assert.equal(err.message, SCHEMA_REQUIRED_MESSAGE);
      return true;
    });
    assert.deepEqual(
      resolveBoardColumns({ kanban: true }).map((c) => c.label),
      ["To do", "Doing", "Blocked", "Done"]
    );
    const custom = parseSchemaParts(["Intake", "Ready", "Done"], "column");
    assert.equal(custom[0].id, "intake");
    assert.equal(findColumn(board({ columns: custom }), "Ready")?.id, "ready");
  });

  it("rejects extra columns and unknown item columns", () => {
    assert.throws(() => parseSchemaParts(["a", "b", "c", "d", "e", "f", "g", "h", "i"], "column"));
    const launch = board();
    assert.equal(findColumn(launch, "not-a-column"), undefined);
    assert.equal(isDoneColumn(launch, "done"), true);
    assert.equal(isDoneColumn(launch, "to-do"), false);
  });

  it("formats a board with its own schema and work id linkage", () => {
    const text = formatBoard(board(), [item()], [{ id: "per-valerie-moraru", displayName: "Valerie Moraru" }]);
    assert.match(text, /Launch week/);
    assert.match(text, /To do/);
    assert.match(text, /Cut DNS/);
    assert.match(text, /Valerie Moraru/);
    assert.match(text, /Risk=high/);
    assert.match(text, /itm-1/);
  });

  it("classifies board writes as shared and lists tools that refuse invented schema", () => {
    assert.equal(operationMetadata("open_pmo_board").effect, "shared_write");
    assert.equal(operationMetadata("add_pmo_item").effect, "shared_write");
    assert.equal(operationMetadata("list_pmo_board").effect, "read");
    const catalog = new Map(nativeToolCatalog().map((tool) => [tool.name, tool.description]));
    assert.match(catalog.get("open_pmo_board") ?? "", /ask one question/i);
    assert.match(catalog.get("open_pmo_board") ?? "", /Do not invent schema/);
  });

  it("admin lists active and archived boards by schema", () => {
    const active = board();
    const archived = board({
      id: "brd-old",
      boardId: "brd-old",
      title: "Finished cutover",
      status: "closed",
      closedAt: "2026-09-01T00:00:00Z",
      ttl: 90 * 24 * 60 * 60,
    });
    const openHtml = renderPmoBoards(
      "local",
      "active",
      [active, archived],
      { "brd-test": [item()], "brd-old": [] },
      [{ id: "per-valerie-moraru", displayName: "Valerie Moraru" }],
      "",
      true
    );
    assert.match(openHtml, /Launch week/);
    assert.match(openHtml, /To do \/ Doing \/ Blocked \/ Done/);
    assert.doesNotMatch(openHtml, /Finished cutover/);
    assert.match(openHtml, /action="\/admin\/boards"/);
    const closedHtml = renderPmoBoards(
      "local",
      "archived",
      [active, archived],
      { "brd-test": [], "brd-old": [] },
      [],
      "",
      false
    );
    assert.match(closedHtml, /Finished cutover/);
    assert.doesNotMatch(closedHtml, />Launch week</);
  });

  it("denies board tools for non-viewers without writing", async () => {
    const result = await openPmoBoard("nobody", { title: "Should not create", kanban: true });
    assert.match(result, /Meeting intelligence is limited/);
  });
});
