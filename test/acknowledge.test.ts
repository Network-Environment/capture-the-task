import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACK_TIMEOUT_MS,
  PENDING_ACK_GRACE_MS,
  attachedAck,
  composeAcknowledgement,
  fallbackAck,
  firstNameFrom,
  firstNameFromGraphProfile,
  missedAckMessage,
  pendingAckEligible,
  pendingAckGaveUp,
  sanitizeAck,
} from "../src/channels/acknowledge";
import { WORKING_RESPONSE } from "../src/channels/types";
import { assessInboundQuality, socialOnlyKind } from "../src/services/inboundQuality";

const noName = async () => undefined;

describe("personalized acknowledgements", () => {
  it("takes a first name, including Last, First", () => {
    assert.equal(firstNameFrom("Adam McCurry"), "Adam");
    assert.equal(firstNameFrom("McCurry, Adam"), "Adam");
    assert.equal(firstNameFrom("McCurry, Adam J"), "Adam");
    assert.equal(firstNameFrom("adam@contoso.com"), undefined);
    assert.equal(firstNameFrom("  "), undefined);
  });

  it("reads a first name from a Microsoft 365 profile", () => {
    assert.equal(firstNameFromGraphProfile({ givenName: "Adam", displayName: "McCurry, Adam" }), "Adam");
    assert.equal(firstNameFromGraphProfile({ givenName: null, displayName: "Adam McCurry" }), "Adam");
    assert.equal(firstNameFromGraphProfile({ givenName: "", displayName: null }), undefined);
    assert.equal(firstNameFromGraphProfile(undefined), undefined);
  });

  it("rejects completion claims and queue jargon, and keeps an echoed scheduled", () => {
    assert.equal(sanitizeAck("I've saved that."), undefined);
    assert.equal(sanitizeAck("I created the task."), undefined);
    assert.equal(sanitizeAck("I approved it."), undefined);
    assert.equal(sanitizeAck("done — filed"), undefined);
    assert.equal(sanitizeAck("Your request id is rq-1"), undefined);
    assert.equal(sanitizeAck("It is in the queue."), undefined);
    assert.equal(
      sanitizeAck("Got it, Adam — I’ll look at the meeting you scheduled."),
      "Got it, Adam — I’ll look at the meeting you scheduled."
    );
    assert.equal(sanitizeAck("Hey Adam\nthanks"), "Hey Adam thanks");
    assert.equal(sanitizeAck("   "), undefined);
  });

  it("classifies only a whole-message greeting or probe as social", () => {
    assert.equal(socialOnlyKind("Hello,"), "greeting");
    assert.equal(socialOnlyKind("hey there!"), "greeting");
    assert.equal(socialOnlyKind("test,"), "probe");
    assert.equal(socialOnlyKind("test test test"), "probe");
    assert.equal(socialOnlyKind("hello please file this"), undefined);
    assert.equal(assessInboundQuality("Hello,").disposition, "help");
    assert.equal(assessInboundQuality("hello please file this").disposition, "proceed");
  });

  it("falls back when generation throws or times out, and still returns an enqueue decision", async () => {
    const thrown = await composeAcknowledgement(
      { userId: "u", channel: "teams", text: "book the room tomorrow", displayNameHint: "Adam McCurry" },
      {
        resolveName: async (_userId, hint) => firstNameFrom(hint),
        generate: async () => {
          throw new Error("model down");
        },
      }
    );
    assert.equal(thrown.kind, "receipt");
    assert.equal(thrown.text, fallbackAck("receipt", undefined, "Adam"));
    assert.equal(thrown.text, "Got it, Adam — on it.");
    assert.doesNotMatch(thrown.text, /queue|request id/i);

    const greeting = await composeAcknowledgement(
      { userId: "u", channel: "imessage", text: "Hello," },
      { resolveName: noName, generate: async () => null, timeoutMs: 20 }
    );
    assert.equal(greeting.kind, "reply");
    assert.equal(greeting.text, "Hey — what can I do for you?");

    const slow = await composeAcknowledgement(
      { userId: "u", channel: "teams", text: "ping" },
      {
        resolveName: async () => "Adam",
        timeoutMs: 20,
        generate: () => new Promise((resolve) => setTimeout(() => resolve("too late"), 250)),
      }
    );
    assert.equal(slow.kind, "reply");
    assert.equal(slow.social, "probe");
    assert.match(slow.text, /nothing was saved/i);
    assert.match(slow.text, /Adam/);
    assert.ok(ACK_TIMEOUT_MS <= 1000);
  });

  it("uses the nameless template only when no name is known", () => {
    assert.equal(fallbackAck("receipt", undefined), WORKING_RESPONSE);
    assert.match(attachedAck("Adam"), /already doing, Adam/);
    assert.doesNotMatch(attachedAck(), /Adam/);
  });

  it("builds a miss notice around the original reply", () => {
    const reply = "Hey Adam — what can I do for you?";
    assert.equal(
      missedAckMessage("Adam", reply),
      `Sorry Adam — I got that and the reply didn’t go out. ${reply}`
    );
    assert.match(missedAckMessage(undefined, reply), /^Sorry —/);
  });

  it("leaves a young pending ack, or one with a live lease, to the immediate send", () => {
    const now = Date.parse("2026-09-30T18:00:00.000Z");
    const young = new Date(now - 5_000).toISOString();
    const old = new Date(now - PENDING_ACK_GRACE_MS - 1).toISOString();
    assert.equal(
      pendingAckEligible({ status: "pending-ack", receivedAt: young }, now),
      false
    );
    assert.equal(
      pendingAckEligible(
        {
          status: "pending-ack",
          receivedAt: old,
          sendLeaseUntil: new Date(now + 10_000).toISOString(),
        },
        now
      ),
      false
    );
    assert.equal(
      pendingAckEligible({ status: "pending-ack", receivedAt: old }, now),
      true
    );
    assert.equal(
      pendingAckEligible(
        {
          status: "pending-ack",
          receivedAt: young,
          sendLeaseUntil: new Date(now - 1).toISOString(),
        },
        now
      ),
      true
    );
    assert.equal(pendingAckGaveUp(3), true);
    assert.equal(pendingAckGaveUp(2), false);
  });
});
