import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresApproval } from "../src/services/approvals";
import {
  agentProfileFor,
  chooseSheetUpdate,
  columnWriteValue,
  formatWriteApproval,
  inferCellUpdates,
  isPmoRequest,
  looseSearchQuery,
  parseSearchHits,
  parseSheetForRows,
  pickBestRow,
  pickColumn,
  approvalMessage,
  type SheetColumn,
} from "../src/services/smartsheet";

test("PMO wording is an action profile, greetings are not", () => {
  assert.equal(isPmoRequest("hey"), false);
  assert.equal(isPmoRequest("remind me what I captured about vendor delay"), false);
  assert.equal(isPmoRequest("what's open on the risk register?"), true);
  assert.equal(isPmoRequest("update the Smartsheet row for vendor delay"), true);
  assert.equal(agentProfileFor("action", "what's open on the risk register?"), "pmo");
  assert.equal(agentProfileFor("action", "schedule a Friday digest"), undefined);
  assert.equal(agentProfileFor("question", "risk register"), undefined);
  assert.equal(isPmoRequest("create an ephemeral Admin board"), false);
  assert.equal(isPmoRequest("on the HR-Talent Acquisition card add these roles"), false);
  assert.equal(isPmoRequest("add this item to the TaskBrain PMO board"), false);
  assert.equal(isPmoRequest("sheet id 782519954788228"), true);
});

test("search JSON parses sheet and row ids", () => {
  const hits = parseSearchHits(
    JSON.stringify({
      results: [{ objectType: "row", objectId: "111", parentObjectId: "999", text: "Vendor delay" }],
    })
  );
  assert.equal(hits[0]?.sheetId, "999");
  assert.equal(hits[0]?.rowId, "111");
});

test("high overlap maps to an existing row; weak overlap does not", () => {
  const rows = [
    {
      sheetId: "1",
      sheetName: "Risks",
      rowId: "10",
      text: "file the change window with vendor",
    },
    {
      sheetId: "1",
      sheetName: "Risks",
      rowId: "11",
      text: "office snacks inventory",
    },
  ];
  const hit = pickBestRow("file the change window", rows);
  assert.equal(hit?.row.rowId, "10");
  assert.equal(pickBestRow("unrelated moon landing", rows), undefined);
});

test("inferred updates never invent add_rows and skip when no cells", () => {
  const row = {
    sheetId: "1",
    sheetName: "Risks",
    rowId: "10",
    text: "vendor delay",
  };
  assert.deepEqual(inferCellUpdates(row, { title: "vendor delay" }), []);
  const withNotes = { ...row, notesColumnId: 55 };
  assert.ok(inferCellUpdates(withNotes, { title: "vendor delay" }).length === 1);
});

test("get_sheet_summary JSON becomes row hits with status columns", () => {
  const legacy = JSON.stringify({
    name: "Risks",
    columns: [
      { id: 1, title: "Risk" },
      { id: 2, title: "Status" },
      { id: 3, title: "Owner" },
    ],
    rows: [{ id: 88, cells: [{ columnId: 1, displayValue: "Vendor delay" }, { columnId: 2, displayValue: "Open" }] }],
  });
  const rows = parseSheetForRows(legacy, "999", "risks");
  assert.equal(rows[0]?.rowId, "88");
  assert.equal(rows[0]?.statusColumnId, 2);

  const summary = JSON.stringify({
    sheet_id: 999,
    sheet_name: "Risks",
    available_columns: [
      { id: 1, title: "Risk" },
      { id: 2, title: "Status" },
      { id: 3, title: "Owner" },
    ],
    rows: [{ row_id: 88, cells: { Risk: "Vendor delay", Status: "Open", Owner: "Val" } }],
  });
  const fromSummary = parseSheetForRows(summary, "999", "risks");
  assert.equal(fromSummary[0]?.rowId, "88");
  assert.equal(fromSummary[0]?.statusColumnId, 2);
  assert.equal(fromSummary[0]?.owner, "Val");
});

test("live MCP text summary becomes searchable row hits", () => {
  const summary = `sheet_id: 782519954788228
sheet_name: Task to Capture 2026
available_columns[3]:
  - index: 0
    title: Initiative
    type: TEXTNUMBER
  - index: 3
    title: Workstream
    type: TEXTNUMBER
  - index: 5
    title: WS Owner
    type: PICKLIST
rows[1]:
  - row_id: 731399982284676
    row_number: 3
    cells[3]{column_index value}:
      0\tAdministrative
      3\tAdministrative
      5\tValerie Moraru
    predecessors: null`;
  const rows = parseSheetForRows(summary, "fallback", "fallback");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.sheetId, "782519954788228");
  assert.equal(rows[0]?.rowId, "731399982284676");
  assert.match(rows[0]?.text ?? "", /Administrative/);
  assert.equal(rows[0]?.owner, "Valerie Moraru");
});

test("parked Smartsheet writes are human-readable; search does not need approval", () => {
  assert.equal(requiresApproval("smartsheet__search"), false);
  assert.equal(requiresApproval("smartsheet__update_rows"), true);
  const msg = formatWriteApproval("smartsheet__update_rows", {
    sheetId: "123",
    rows: [{ id: 10, cells: [{ columnId: 2, value: "Complete" }] }],
  });
  assert.match(msg, /Update row/);
  assert.match(msg, /row 10/);
  assert.match(approvalMessage("pa-abc", "smartsheet__update_rows", { sheetId: "123", rows: [] }), /approve pa-abc/);
  const named = formatWriteApproval("smartsheet__update_rows", {
    sheet_id: "123",
    rows: [{ id: 10, cells: [{ columnId: 2, value: "Complete" }] }],
    _display: {
      sheetName: "Task to Capture 2026",
      rowLabel: "Generator commissioning",
      changes: [
        { column: "Status", value: "Complete" },
        { column: "Finish", value: "2026-11-06" },
      ],
    },
  });
  assert.match(named, /Task to Capture 2026/);
  assert.match(named, /Generator commissioning/);
  assert.match(named, /Status: Complete/);
  assert.match(named, /Finish: 2026-11-06/);
  assert.doesNotMatch(named, /col 2/);
});

test("closest row wins and an unrelated phrase does not", () => {
  const rows = [
    {
      sheetId: "1",
      sheetName: "Task to Capture 2026",
      rowId: "10",
      text: "Initiative: Generator commissioning - Phase 2",
      primaryText: "Generator commissioning - Phase 2",
    },
    {
      sheetId: "1",
      sheetName: "Task to Capture 2026",
      rowId: "11",
      text: "Initiative: Office snacks",
      primaryText: "Office snacks",
    },
  ];
  assert.equal(pickBestRow("commissioning", rows)?.row.rowId, "10");
  assert.equal(pickBestRow("unrelated moon landing", rows), undefined);
  assert.equal(looseSearchQuery('"the commissioning row"'), "commissioning");
});

test("everyday words map to the closest column and dropdown value", () => {
  const columns: SheetColumn[] = [
    { id: 1, title: "Start", options: [] },
    { id: 2, title: "Finish", options: [] },
    { id: 3, title: "Status", options: ["Open", "Complete"] },
    { id: 4, title: "Pending review", options: [] },
  ];
  assert.equal(pickColumn("done", columns)?.column.title, "Status");
  assert.equal(pickColumn("push the date", columns)?.column.title, "Finish");
  assert.equal(columnWriteValue("done", columns[2]), "Complete");
  const choice = chooseSheetUpdate(
    "commissioning",
    [
      {
        sheetId: "9",
        sheetName: "Task to Capture 2026",
        rowId: "10",
        text: "Generator commissioning - Phase 2",
        primaryText: "Generator commissioning - Phase 2",
      },
    ],
    columns,
    { status: "done", due: "2026-11-06" }
  );
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  assert.deepEqual(choice.cells, [
    { columnId: 3, value: "Complete" },
    { columnId: 2, value: "2026-11-06" },
  ]);
  assert.equal(choice.display.changes[0]?.column, "Status");
  assert.equal(choice.display.changes[1]?.column, "Finish");
});

test("live summary column ids are kept for a later update", () => {
  const summary = `sheet_id: 99
sheet_name: Risks
available_columns[2]:
  - index: 0
    id: 501
    title: Initiative
    type: TEXTNUMBER
  - index: 1
    id: 502
    title: Status
    type: PICKLIST
    options: Open, Complete
rows[1]:
  - row_id: 77
    cells[2]{column_index value}:
      0\tCommissioning
      1\tOpen
`;
  const rows = parseSheetForRows(summary, "fallback", "fallback");
  assert.equal(rows[0]?.primaryText, "Commissioning");
  assert.equal(rows[0]?.statusColumnId, 502);
  assert.deepEqual(rows[0]?.columns?.[1]?.options, ["Open", "Complete"]);
});
