import "./setup";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fixtureFromActivity, replayFixture, type ActivitySlice } from "../src/services/runReplay";

const sample = JSON.parse(
  readFileSync(resolve(process.cwd(), "config/activity.replay.json"), "utf8")
) as { name: string; runId: string; events: ActivitySlice[] }[];

describe("activity replay", () => {
  it("replays the sampled contract without calling a model or external system", () => {
    for (const item of sample) {
      const failures = replayFixture(fixtureFromActivity(item.events, item.runId));
      assert.deepEqual(failures, [], item.name);
    }
  });

  it("rejects an inferred mutation, a shared write, a crossed bank, a tool outside the envelope, and a silent ending", () => {
    const events: ActivitySlice[] = [
      { type: "intent", traceId: "bad", detail: { disposition: "maybe", explicit: [false] } },
      {
        type: "policy",
        traceId: "bad",
        detail: { tool: "save_note", effect: "personal_write", decision: "execute", explicit: false },
      },
      {
        type: "policy",
        traceId: "bad",
        detail: { tool: "send_mail", effect: "shared_write", decision: "execute", explicit: true },
      },
      {
        type: "tool_call",
        traceId: "bad",
        detail: { tool: "save_note", effect: "personal_write", store: "graph" },
      },
      {
        type: "tool_call",
        traceId: "bad",
        detail: { tool: "send_mail", effect: "shared_write" },
      },
      {
        type: "job_run",
        traceId: "bad",
        detail: { allowedTools: ["recall_notes"] },
      },
    ];
    const checks = new Set(replayFixture(fixtureFromActivity(events, "bad")).map((failure) => failure.check));
    assert.equal(checks.has("fail_closed"), true);
    assert.equal(checks.has("clarification"), true);
    assert.equal(checks.has("approval"), true);
    assert.equal(checks.has("memory_bank"), true);
    assert.equal(checks.has("envelope"), true);
    assert.equal(checks.has("no_silent_loss"), true);
  });
});
