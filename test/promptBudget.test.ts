import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimatePromptChars, fitRunMessages, promptCharBudget, routePromptBudget } from "../src/services/promptBudget";
import { validateToolArgs } from "../src/tools/validateArgs";
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

  it("keeps record ids when it shortens tool evidence", () => {
    const rowId = "4410298811223344";
    const eventId = "AAMkAGI2TG93AAA=";
    const older = `${"x".repeat(9_000)} {"rowId": ${rowId}, "eventId": "${eventId}"}`;
    const messages = [
      { role: "system", content: "policy" },
      { role: "user", content: "Update that row." },
      { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
      { role: "tool", content: older },
      { role: "assistant", content: "", tool_calls: [{ id: "2" }] },
      { role: "tool", content: "latest" },
    ];
    const fitted = fitRunMessages(messages, promptCharBudget(3_000, 4_000));
    assert.match(String(fitted[3].content), /earlier tool evidence shortened/);
    assert.match(String(fitted[3].content), new RegExp(`ids kept: .*${rowId}`));
    assert.ok(String(fitted[3].content).includes(eventId));
  });

  it("drops the oldest conversation turns once tool evidence cannot shrink further", () => {
    const turn = "y".repeat(3_000);
    const messages = [
      { role: "system", content: "policy" },
      { role: "user", content: "Active record references: row 1" },
      { role: "user", content: `oldest ${turn}` },
      { role: "assistant", content: `older ${turn}` },
      { role: "user", content: `recent ${turn}` },
      { role: "assistant", content: "recent reply" },
      { role: "user", content: "current request" },
    ];
    const budget = promptCharBudget(3_000, 4_000);
    const fitted = fitRunMessages(messages, budget, { protectedPrefix: 2 });
    assert.ok(estimatePromptChars(fitted) <= budget);
    assert.equal(fitted[0].content, "policy");
    assert.equal(fitted[1].content, "Active record references: row 1");
    assert.match(String(fitted[2].content), /earlier conversation turns omitted/);
    assert.equal(fitted.at(-1)?.content, "current request");
    assert.ok(!fitted.some((message) => String(message.content).startsWith("oldest")));
  });

  it("never drops the current request or the in-run tool exchange", () => {
    const messages = [
      { role: "system", content: "policy" },
      { role: "user", content: "z".repeat(20_000) },
      { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
      { role: "tool", content: "Queued. Reply approve pa-abc123 to send it." },
    ];
    const fitted = fitRunMessages(messages, promptCharBudget(3_000, 4_000));
    assert.equal(fitted.length, messages.length);
    assert.equal(fitted[1].content, messages[1].content);
  });
});

describe("native tool argument validation", () => {
  const schema = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["task", "idea"] },
      k: { type: "number" },
      effort: { type: "number", enum: [1, 2, 3, 5, 8] },
      channels: { type: "array", items: { type: "string", enum: ["teams", "todo"] } },
    },
    required: ["kind"],
  };

  it("accepts values handlers already coerce", () => {
    assert.equal(validateToolArgs(schema, { kind: "Task", k: "8", effort: "3", channels: ["teams"] }), undefined);
    assert.equal(validateToolArgs(schema, { kind: "idea", k: null }), undefined);
  });

  it("rejects missing, mistyped, and out-of-enum arguments", () => {
    assert.match(String(validateToolArgs(schema, {})), /missing required argument kind/);
    assert.match(String(validateToolArgs(schema, { kind: "note" })), /kind must be one of/);
    assert.match(String(validateToolArgs(schema, { kind: "task", k: "many" })), /k must be a number/);
    assert.match(String(validateToolArgs(schema, { kind: "task", effort: 4 })), /effort must be one of/);
    assert.match(String(validateToolArgs(schema, { kind: "task", channels: "teams" })), /channels must be an array/);
    assert.match(String(validateToolArgs(schema, { kind: "task", channels: ["slack"] })), /channels\[0\] must be one of/);
  });
});
