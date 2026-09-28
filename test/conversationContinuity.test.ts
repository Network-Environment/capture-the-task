import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessInboundQuality } from "../src/services/inboundQuality";
import { pickOpenQuestion } from "../src/services/session";
import { mergeRequestText } from "../src/services/requestQueue";
import { approvalMessage } from "../src/services/smartsheet";
import { agentSkillsPromptBlock } from "../src/services/agentSkills";
import type { PendingClarification } from "../src/services/session";

function question(createdAt: string, text: string): PendingClarification {
  return {
    plan: {
      disposition: "clarify",
      reason: "insufficient_context",
      confidence: 1,
      assumptions: [],
      clarification: text,
      intents: [],
    },
    originalText: "Make a board to track tasks",
    question: text,
    createdAt,
  };
}

describe("open questions", () => {
  it("keeps the newest question and drops an expired one", () => {
    const older = question("2026-09-28T14:00:00Z", "Which columns?");
    const newer = question("2026-09-28T14:05:00Z", "What time?");
    const now = Date.parse("2026-09-28T14:06:00Z");
    assert.equal(pickOpenQuestion(older, newer, now)?.question, "What time?");
    assert.equal(
      pickOpenQuestion(question("2026-09-28T13:00:00Z", "stale"), undefined, now),
      undefined
    );
  });

  it("lets a short answer through only while a question or check-in is open", () => {
    assert.equal(assessInboundQuality("done").disposition, "clarify");
    assert.equal(assessInboundQuality("done", [], true).disposition, "proceed");
    assert.equal(assessInboundQuality("kanban", [], true).disposition, "proceed");
    assert.match(assessInboundQuality("test").response ?? "", /Nothing was saved/);
    assert.doesNotMatch(assessInboundQuality("test").response ?? "", /task:/);
  });
});

describe("in-flight replies", () => {
  it("appends a later line without duplicating it", () => {
    assert.equal(
      mergeRequestText("Make a board to track tasks", "kanban"),
      "Make a board to track tasks\nkanban"
    );
    assert.equal(
      mergeRequestText("Make a board to track tasks\nkanban", "kanban"),
      "Make a board to track tasks\nkanban"
    );
  });
});

describe("reply contract", () => {
  it("describes a held change without a tool name or raw JSON", () => {
    const text = approvalMessage("pa-1", "open_pmo_board", {
      title: "Vegas",
      columns: ["To do", "Done"],
    });
    assert.match(text, /approve pa-1/);
    assert.match(text, /title: Vegas/);
    assert.doesNotMatch(text, /open_pmo_board|```/);
  });

  it("tells the agent to record one question with ask_user", () => {
    const prompt = agentSkillsPromptBlock(["work-followthrough"]);
    assert.match(prompt, /call ask_user with one question/);
  });
});
