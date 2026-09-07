import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresApproval } from "../src/services/approvals";
import {
  agentProfileFor,
  formatWriteApproval,
  inferCellUpdates,
  isPmoRequest,
  parseSearchHits,
  parseSheetForRows,
  pickBestRow,
  approvalMessage,
} from "../src/services/smartsheet";

test("PMO wording is an action profile, greetings are not", () => {
  assert.equal(isPmoRequest("hey"), false);
  assert.equal(isPmoRequest("remind me what I captured about vendor delay"), false);
  assert.equal(isPmoRequest("what's open on the risk register?"), true);
  assert.equal(isPmoRequest("update the Smartsheet row for vendor delay"), true);
  assert.equal(agentProfileFor("action", "what's open on the risk register?"), "pmo");
  assert.equal(agentProfileFor("action", "schedule a Friday digest"), undefined);
  assert.equal(agentProfileFor("question", "risk register"), undefined);
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

test("get_sheet JSON becomes row hits with status columns", () => {
  const raw = JSON.stringify({
    name: "Risks",
    columns: [
      { id: 1, title: "Risk" },
      { id: 2, title: "Status" },
      { id: 3, title: "Owner" },
    ],
    rows: [{ id: 88, cells: [{ columnId: 1, displayValue: "Vendor delay" }, { columnId: 2, displayValue: "Open" }] }],
  });
  const rows = parseSheetForRows(raw, "999", "risks");
  assert.equal(rows[0]?.rowId, "88");
  assert.equal(rows[0]?.statusColumnId, 2);
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
});
