import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAttribution, usageTokens } from "../src/services/activityLog";

test("legacy Teams capture resolves to user message, Teams, and text", () => {
  assert.deepEqual(
    normalizeAttribution({
      type: "capture",
      detail: { channel: "teams", source: "text" },
    }),
    {
      origin: "user_message",
      channel: "teams",
      inputMode: "text",
      trigger: undefined,
    }
  );
});

test("legacy meeting capture resolves to internal meeting discovery", () => {
  const a = normalizeAttribution({
    type: "capture",
    agent: "meeting-ingest",
    detail: { transcriptId: "tx1" },
  });
  assert.equal(a.origin, "meeting_discovery");
  assert.equal(a.channel, "internal");
  assert.equal(a.inputMode, undefined);
});

test("scheduled and explicit events never fall back to unknown", () => {
  assert.deepEqual(
    normalizeAttribution({ type: "job_run", detail: { job: "weekly" } }),
    {
      origin: "scheduled_job",
      channel: "internal",
      inputMode: undefined,
      trigger: undefined,
    }
  );
  const explicit = normalizeAttribution({
    type: "model_call",
    origin: "admin_summary",
    channel: "internal",
    trigger: "meeting_summary",
    detail: {},
  });
  assert.equal(explicit.origin, "admin_summary");
  assert.equal(explicit.trigger, "meeting_summary");
});

test("unreadable token counters do not become NaN", () => {
  assert.equal(usageTokens(1200), 1200);
  assert.equal(usageTokens("[redacted]"), 0);
  assert.equal(usageTokens(undefined), 0);
});
