import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUndoCommand } from "../src/services/session";

describe("undo command", () => {
  it("matches explicit undo phrasing only", () => {
    for (const text of ["undo", "Undo that.", "delete that"]) {
      assert.equal(isUndoCommand(text), true, text);
    }
    for (const text of ["forget that", "undo the budget note later", "delete that file from SharePoint"]) {
      assert.equal(isUndoCommand(text), false, text);
    }
  });
});
