import "./setup";
import { test } from "node:test";
import assert from "node:assert";
import { requiresApproval } from "../src/services/approvals";

test("smartsheet writes require approval", () => {
  assert.strictEqual(requiresApproval("smartsheet__add_rows"), true);
  assert.strictEqual(requiresApproval("smartsheet__update_rows"), true);
});

test("smartsheet reads do not", () => {
  assert.strictEqual(requiresApproval("smartsheet__search"), false);
  assert.strictEqual(requiresApproval("smartsheet__get_sheet"), false);
});
