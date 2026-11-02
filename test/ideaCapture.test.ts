import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeNoteBody } from "../src/services/brain";
import { EMPTY_REPLY_FALLBACK, visibleReply } from "../src/services/agent";
import { ensureDeliverable } from "../src/pipeline";
import {
  continueWithoutAnotherQuestion,
  ideaTitleFrom,
  isIdeaSeed,
  oneQuestion,
  shouldAppendToOpenIdea,
  wantsResearch,
  type OpenIdea,
} from "../src/services/ideaCapture";

const open: OpenIdea = {
  id: "idea-1",
  path: "user/idea-1.md",
  title: "Grow APEX in Texas",
  updatedAt: "2026-11-02T15:15:00.000Z",
};

describe("idea capture", () => {
  it("treats a stated growth plan as an idea and keeps the title short", () => {
    const text =
      "We would like to further establish and grow the business in Texas for APEX. We need office space that has storage.";
    assert.equal(isIdeaSeed(text), true);
    assert.match(ideaTitleFrom(text), /^We would like to further establish/);
    assert.ok(ideaTitleFrom(text).length <= 80);
    assert.equal(isIdeaSeed("Call Pat about the warranty tomorrow."), false);
    assert.equal(isIdeaSeed("What's on my calendar tomorrow afternoon?"), false);
  });

  it("keeps one question and continues the same idea", () => {
    assert.equal(
      oneQuestion("Should I look statewide? Also, what is the deadline?"),
      "Should I look statewide?"
    );
    assert.equal(shouldAppendToOpenIdea("Focus on the business plan", open, true), true);
    assert.equal(shouldAppendToOpenIdea("What's on my calendar tomorrow?", open, false), false);
    assert.equal(wantsResearch("You tell me what areas are in most demand"), true);
    const next = continueWithoutAnotherQuestion(
      "Grow APEX in Texas",
      "Statewide?",
      "Focus on the business plan"
    );
    assert.equal(next.kind, "read");
    assert.match(next.standalone, /Do not ask another question/);
  });

  it("keeps the latest addition when a note gets long", () => {
    const merged = mergeNoteBody("start", "x".repeat(20_000));
    assert.ok(merged.startsWith("start"));
    assert.ok(merged.endsWith("x"));
    assert.ok(merged.length < 20_000);
  });

  it("replaces a blank model reply before it can be delivered", () => {
    assert.equal(visibleReply("", "length"), EMPTY_REPLY_FALLBACK);
    assert.match(visibleReply("Partial.", "length"), /cut that short/);
    const delivered = ensureDeliverable({
      title: "TaskBrain",
      body: "",
      tags: [],
      summaryLine: "",
    });
    assert.match(delivered.body, /didn.t get that answer out/);
    assert.notEqual(delivered.body.trim(), "");
  });
});
