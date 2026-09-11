import "./setup";
import { test } from "node:test";
import assert from "node:assert";
import {
  newPendingActionId,
  parseApprovalCommand,
  requiresApproval,
} from "../src/services/approvals";

test("smartsheet writes require approval", () => {
  assert.strictEqual(requiresApproval("smartsheet__add_rows"), true);
  assert.strictEqual(requiresApproval("smartsheet__update_rows"), true);
});

test("smartsheet reads do not", () => {
  assert.strictEqual(requiresApproval("smartsheet__search"), false);
  assert.strictEqual(requiresApproval("smartsheet__get_sheet"), false);
});

test("pending action ids round-trip through approve and deny commands", () => {
  const id = newPendingActionId();
  assert.match(id, /^pa-[a-z0-9]+$/);
  assert.deepStrictEqual(parseApprovalCommand(`approve ${id}`), { verb: "approve", id });
  assert.deepStrictEqual(parseApprovalCommand(`DENY ${id}`), { verb: "deny", id });
  assert.strictEqual(parseApprovalCommand(`approve ${id} extra`), undefined);
});
