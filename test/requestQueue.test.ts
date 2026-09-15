import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestId,
  retryDelayMs,
} from "../src/services/requestQueue";
import { outboundCard } from "../src/channels/teamsCard";

describe("durable request queue", () => {
  it("uses a stable id per channel event without exposing the event id", () => {
    const first = requestId("teams", "activity/secret-id");
    assert.equal(first, requestId("teams", "activity/secret-id"));
    assert.notEqual(first, requestId("imessage", "activity/secret-id"));
    assert.match(first, /^rq-[a-f0-9]{24}$/);
    assert.doesNotMatch(first, /secret/);
  });

  it("backs retries off and caps the delay", () => {
    assert.equal(retryDelayMs(1), 30_000);
    assert.equal(retryDelayMs(2), 60_000);
    assert.equal(retryDelayMs(10), 300_000);
  });

  it("keeps approval actions on proactively delivered Teams results", () => {
    const attachment = outboundCard({
      title: "Approval required",
      body: "Approve request pa-abc123 to continue.",
      tags: [],
    });
    const content = attachment.content as {
      actions?: Array<{ data?: { pendingActionId?: string } }>;
    };
    assert.equal(content.actions?.length, 2);
    assert.equal(content.actions?.[0]?.data?.pendingActionId, "pa-abc123");
  });
});
