import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitRunMessages, promptCharBudget, routePromptBudget } from "../src/services/promptBudget";
import { MAX_TURNS, SESSION_TTL_SECONDS, SUMMARY_CAP } from "../src/services/session";

describe("in-run prompt budget", () => {
  it("leaves a short capture prompt unchanged", () => {
    const messages = [
      { role: "system", content: "You are TaskBrain." },
      { role: "user", content: "File this idea: ship the digest on Friday." },
    ];
    assert.equal(fitRunMessages(messages, routePromptBudget("agent")), messages);
  });

  it("shortens older tool evidence and leaves the session contract alone", () => {
    const older = "x".repeat(8_000);
    const latest = "latest evidence that should survive first";
    const approval = "Queued. Reply approve pa-abc123 to send it.";
    const question = "What should I file?";
    const messages = [
      { role: "system", content: "policy" },
      { role: "user", content: question },
      { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
      { role: "tool", content: older },
      { role: "tool", content: approval },
      { role: "assistant", content: "", tool_calls: [{ id: "2" }] },
      { role: "tool", content: latest },
    ];
    const fitted = fitRunMessages(messages, promptCharBudget(3_000, 4_000));
    assert.notEqual(fitted, messages);
    assert.equal(messages[3].content, older);
    assert.equal(fitted[1].content, question);
    assert.match(String(fitted[3].content), /earlier tool evidence shortened/);
    assert.equal(fitted[4].content, approval);
    assert.equal(fitted[6].content, latest);
    assert.equal(MAX_TURNS, 24);
    assert.equal(SUMMARY_CAP, 800);
    assert.equal(SESSION_TTL_SECONDS, 24 * 3600);
  });
});
