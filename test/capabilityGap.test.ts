import "./setup";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  FALLBACK_ALTERNATIVE,
  GROUP_CHAT_GAP,
  UNMET_TITLE,
  capabilityGapOutbound,
  GRAPH_SIGN_IN_REQUIRED,
  classifyCapabilityBoundary,
  isGraphSignInFailure,
  resetCapabilityGapNotes,
  subscribeCapabilityGaps,
} from "../src/services/capabilityGap";
import { shouldRerunAfterDetail } from "../src/services/requestWorker";
import { dispatch, operationMetadata } from "../src/tools/registry";

describe("capability gaps", () => {
  it("records the ask and replies without naming a tool", async () => {
    resetCapabilityGapNotes();
    const seen: Record<string, unknown>[] = [];
    const stop = subscribeCapabilityGaps((detail) => seen.push(detail));
    try {
      const ctx = {
        userId: "u1",
        channel: "teams" as const,
        requestText: "Move the Friday meeting with Joe",
        traceId: "note-1",
      };
      const result = await dispatch(ctx, "note_unmet_request", {
        capability: "move the Friday meeting",
        limit: "I can only read your calendar.",
        alternative: "track the follow-up as work",
      });
      assert.equal(
        result,
        "You want to move the Friday meeting. I can only read your calendar. What I can do is track the follow-up as work."
      );
      assert.equal(ctx.unmetReply, result);
      assert.equal(operationMetadata("note_unmet_request").effect, "read");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].capability, "move the Friday meeting");
      assert.equal(seen[0].limit, "I can only read your calendar.");
      assert.equal(seen[0].alternative, "track the follow-up as work");
      assert.equal(seen[0].request, "Move the Friday meeting with Joe");
      assert.equal(seen[0].channel, "teams");
      assert.doesNotMatch(result, /note_unmet_request|search_my_calendar/);
    } finally {
      stop();
    }
  });

  it("rejects an empty capability and fills an empty alternative", async () => {
    resetCapabilityGapNotes();
    const seen: Record<string, unknown>[] = [];
    const stop = subscribeCapabilityGaps((detail) => seen.push(detail));
    try {
      const empty = { userId: "u1", requestText: "move it", traceId: "empty-1" };
      const rejected = await dispatch(empty, "note_unmet_request", {
        capability: "  ",
        limit: "I cannot do that.",
      });
      assert.match(rejected, /Say what they wanted/);
      assert.equal(empty.unmetReply, undefined);
      assert.equal(seen.length, 0);

      const ctx = { userId: "u1", requestText: "send the deck", traceId: "alt-1" };
      const result = await dispatch(ctx, "note_unmet_request", {
        capability: "send mail",
        limit: "I cannot send email.",
        alternative: "",
      });
      assert.match(result, new RegExp(FALLBACK_ALTERNATIVE.replace(/[.]/g, "\\.")));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].alternative, FALLBACK_ALTERNATIVE);
      assert.doesNotMatch(result, /note_unmet_request/);
    } finally {
      stop();
    }
  });

  it("turns a calendar boundary into one reply and does not duplicate the trace", async () => {
    resetCapabilityGapNotes();
    const seen: Record<string, unknown>[] = [];
    const stop = subscribeCapabilityGaps((detail) => seen.push(detail));
    try {
      const first = {
        userId: "u1",
        channel: "imessage" as const,
        requestText: "what's on my calendar Friday",
        traceId: "cal-1",
      };
      const result = await dispatch(first, "search_my_calendar", {});
      assert.match(result, /You want to check your Outlook calendar/);
      assert.match(result, /one-time Microsoft sign-in/);
      assert.match(result, /What I can do is sign in once in Teams, then ask again here/);
      assert.equal(first.unmetReply, result);
      assert.doesNotMatch(result, /unavailable on this channel/);
      assert.doesNotMatch(result, /search_my_calendar/);

      const second = {
        userId: "u1",
        channel: "imessage" as const,
        requestText: "what's on my calendar Friday",
        traceId: "cal-1",
      };
      const again = await dispatch(second, "search_my_calendar", {});
      assert.doesNotMatch(again, /unavailable on this channel/);
      assert.equal(seen.length, 1);
    } finally {
      stop();
    }
  });

  it("leaves a policy refusal as NOT_ALLOWED and does not record it", async () => {
    resetCapabilityGapNotes();
    assert.equal(
      classifyCapabilityBoundary(
        "NOT_ALLOWED: Shared or high-impact changes are not enabled on this channel."
      ),
      undefined
    );
    const seen: Record<string, unknown>[] = [];
    const stop = subscribeCapabilityGaps((detail) => seen.push(detail));
    const prior = process.env.UNIFIED_ACTION_POLICY_ENABLED;
    process.env.UNIFIED_ACTION_POLICY_ENABLED = "true";
    try {
      const ctx = {
        userId: "u1",
        channel: "teams" as const,
        traceId: "policy-1",
        requestText: "dump the secrets",
        authorization: {
          explicit: true,
          confidence: 1,
          channel: {
            channel: "teams" as const,
            scope: "private" as const,
            identity: "canonical" as const,
            allowReads: false,
            allowPersonalWrites: false,
            allowSharedWrites: false,
            approvalUx: "adaptive_card" as const,
          },
        },
      };
      const result = await dispatch(ctx, "recall_notes", { query: "secrets" });
      assert.equal(result, "NOT_ALLOWED: Read operations are not enabled on this channel.");
      assert.equal(ctx.unmetReply, undefined);
      assert.equal(seen.length, 0);
    } finally {
      stop();
      if (prior === undefined) delete process.env.UNIFIED_ACTION_POLICY_ENABLED;
      else process.env.UNIFIED_ACTION_POLICY_ENABLED = prior;
    }
  });

  it("uses the graceful title for a group chat and does not re-run that turn", async () => {
    resetCapabilityGapNotes();
    const seen: Record<string, unknown>[] = [];
    const stop = subscribeCapabilityGaps((detail) => seen.push(detail));
    try {
      const actor = {
        userId: "u1",
        channel: "teams" as const,
        traceId: "group-1",
        requestText: "assign this to Val",
      };
      const out = await capabilityGapOutbound(actor, GROUP_CHAT_GAP);
      assert.equal(out.title, "Not something I can do");
      assert.equal(out.title, UNMET_TITLE);
      assert.match(out.body, /I won’t save personal tasks or assign work in a group chat/);
      assert.match(out.body, /ask me the same thing in a 1:1 chat/);
      await capabilityGapOutbound(
        { ...actor },
        GROUP_CHAT_GAP
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0].request, "assign this to Val");
      assert.equal(shouldRerunAfterDetail(UNMET_TITLE, "assign this to Val", "assign this to Val please"), false);
      assert.equal(shouldRerunAfterDetail("Need one detail", "board", "board kanban"), true);
    } finally {
      stop();
    }
  });

  it("turns a raw Graph sign-in failure into the guided reply", () => {
    assert.equal(isGraphSignInFailure("user not signed in to Graph"), true);
    assert.equal(isGraphSignInFailure("Microsoft 365 lookup failed: user not signed in to Graph"), true);
    assert.equal(isGraphSignInFailure("Outlook calendar lookup failed: user not signed in to Graph"), true);
    assert.equal(isGraphSignInFailure(GRAPH_SIGN_IN_REQUIRED), true);
    const gap = classifyCapabilityBoundary("Microsoft 365 lookup failed: user not signed in to Graph");
    assert.equal(gap?.capability, "use your Microsoft 365 account");
    assert.match(gap?.alternative ?? "", /sign in once in Teams/);
  });

  it("handbook points operators at unmet asks and keeps policy refusals as codes", () => {
    const handbook = readFileSync(new URL("../HANDBOOK.md", import.meta.url), "utf8");
    assert.match(handbook, /\/admin\/unmet/);
    assert.match(handbook, /Policy refusals stay reason codes/);
  });
});
