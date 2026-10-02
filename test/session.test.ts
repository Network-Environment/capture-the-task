import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imessageConversationId } from "../src/channels/types";
import {
  MAX_TURNS,
  OPEN_QUESTION_TTL_MS,
  SESSION_TTL_SECONDS,
  SUMMARY_CAP,
  applyTurn,
  fallbackSummary,
  promptTurns,
  selectLastCapture,
  turnBody,
  withSessionTtl,
  isUndoCommand,
  type SessionTurn,
} from "../src/services/session";

function turn(role: "user" | "assistant", text: string, extra: Partial<SessionTurn> = {}): SessionTurn {
  return { role, text, at: "2026-10-02T15:00:00.000Z", ...extra };
}

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

describe("session window", () => {
  it("caps turns and leaves the summary for a later rewrite", () => {
    let doc: { turns: SessionTurn[]; threadSummary?: string } = {
      turns: [],
      threadSummary: "Earlier we filed the commissioning note.",
    };
    for (let i = 0; i < MAX_TURNS + 1; i++) {
      const applied = applyTurn(doc, turn("user", `message ${i}`));
      doc = { turns: applied.turns, threadSummary: applied.threadSummary };
    }
    assert.equal(doc.turns.length, MAX_TURNS);
    assert.equal(doc.turns[0].text, "message 1");
    assert.equal(doc.threadSummary, "Earlier we filed the commissioning note.");
  });

  it("keeps the assistant body and capture reference", () => {
    const applied = applyTurn(undefined, turn("assistant", "Filed task: warranty", {
      body: "Filed the generator warranty review.",
      references: ["note-1"],
    }));
    assert.equal(applied.turns[0].body, "Filed the generator warranty review.");
    assert.deepEqual(applied.turns[0].references, ["note-1"]);
    assert.deepEqual(applied.dropped, []);
  });

  it("stamps the four-hour ttl on every session write", () => {
    assert.equal(SESSION_TTL_SECONDS, 4 * 3600);
    assert.equal(withSessionTtl({ id: "session" }).ttl, SESSION_TTL_SECONDS);
  });

  it("hides a capture from undo after 15 minutes", () => {
    const createdAt = new Date(Date.now() - OPEN_QUESTION_TTL_MS - 1000).toISOString();
    assert.equal(
      selectLastCapture({ id: "n1", path: "notes/n1.md", title: "Warranty", createdAt }),
      undefined
    );
    assert.equal(
      selectLastCapture({
        id: "n1",
        path: "notes/n1.md",
        title: "Warranty",
        createdAt: new Date().toISOString(),
      })?.id,
      "n1"
    );
  });
});

describe("session condensation", () => {
  it("keeps the previous summary ahead of dropped lines and slices to the cap", () => {
    const previous = "Kept the commissioning decision.";
    const dropped = [turn("user", "Ask about the vendor"), turn("assistant", "Noted the vendor delay.")];
    const summary = fallbackSummary(previous, dropped);
    assert.ok(summary.startsWith(previous));
    assert.ok(summary.includes("Noted the vendor delay."));
    const huge = fallbackSummary(previous, [turn("user", "y".repeat(2000))]);
    assert.equal(huge.length, SUMMARY_CAP);
    assert.ok(huge.startsWith(previous));
  });
});

describe("private thread versus group chat", () => {
  it("shows both channels on a private thread and hides that thread from a group", () => {
    const thread = [
      turn("assistant", "Three open risks.", { channel: "teams", body: "Risk one, risk two, risk three." }),
      turn("user", "What about the second?", { channel: "imessage" }),
    ];
    const group = [turn("user", "group secret", { channel: "teams" })];
    const privateTurns = promptTurns("private", thread, group);
    const rendered = privateTurns.map((item) => turnBody(item, "imessage")).join("\n");
    assert.match(rendered, /\[via Teams\] Risk one, risk two, risk three\./);
    assert.match(rendered, /What about the second\?/);
    assert.doesNotMatch(rendered, /group secret/);
    const groupRendered = promptTurns("group", thread, group).map((item) => turnBody(item, "teams")).join("\n");
    assert.equal(groupRendered, "group secret");
    assert.doesNotMatch(groupRendered, /Risk one/);
  });
});

describe("iMessage conversation key", () => {
  it("uses the allowlist phone and not a Photon space id", () => {
    const spaceId = "space-from-photon";
    assert.equal(imessageConversationId("+16152393232"), "imessage:+16152393232");
    assert.equal(imessageConversationId("+16152393232").includes(spaceId), false);
  });
});
