import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addRunCost, estimateUsd } from "../src/services/modelCost";
import { rankLessons, type Lesson } from "../src/services/agentMemory";
import { isParallelRead, toolWaves } from "../src/services/toolBatch";
import { acceptGraphNotification, signWebhook, verifyWebhook } from "../src/channels/webhook";
import { classifyFailure } from "../src/runtime/errors";

describe("tool waves", () => {
  it("groups consecutive reads and keeps writes alone", () => {
    const calls = [
      { name: "search_my_calendar" },
      { name: "search_my_mail" },
      { name: "send_mail" },
      { name: "read_my_file" },
      { name: "ask_user" },
    ];
    assert.equal(isParallelRead("search_my_calendar"), true);
    assert.equal(isParallelRead("ask_user"), false);
    assert.equal(isParallelRead("send_mail"), false);
    const waves = toolWaves(calls);
    assert.deepEqual(waves.map((wave) => wave.map((call) => call.name)), [
      ["search_my_calendar", "search_my_mail"],
      ["send_mail"],
      ["read_my_file"],
      ["ask_user"],
    ]);
  });
});

describe("run cost", () => {
  it("prices known deployments and stops a run past the ceiling", () => {
    const cost = estimateUsd("cheap", 1_000_000, 0);
    assert.equal(cost, 0.4);
    assert.equal(estimateUsd("unknown-model", 10, 10), undefined);
    const usage = { usd: 1.9 };
    assert.equal(addRunCost(usage, 0.05), false);
    assert.equal(addRunCost(usage, 0.1), true);
    assert.ok(usage.usd > 2);
    assert.equal(classifyFailure(new Error("run cost ceiling exceeded ($2.050)")), "permanent");
  });
});

describe("lesson ranking", () => {
  const lesson = (id: string, text: string, hits = 0): Lesson => ({
    id,
    userId: "u",
    kind: "correction",
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    hits,
  });

  it("prefers lessons that share words with the request", () => {
    const calendar = lesson("1", "search the calendar before moving a meeting", 1);
    const sheet = lesson("2", "quote smartsheet search terms");
    const { selected, matched } = rankLessons([sheet, calendar], "move my calendar meeting to Friday");
    assert.equal(matched[0]?.id, "1");
    assert.equal(selected[0]?.id, "1");
  });
});

describe("webhooks", () => {
  it("accepts a fresh signature and a matching graph client state", () => {
    const timestamp = new Date().toISOString();
    const body = "{\"hello\":1}";
    const signature = signWebhook("secret", timestamp, body);
    assert.equal(verifyWebhook({ secret: "secret", timestamp, signature, body }), undefined);
    assert.equal(
      verifyWebhook({ secret: "secret", timestamp, signature: "nope", body }),
      "signature does not match"
    );
    assert.equal(acceptGraphNotification("state", [{ clientState: "state", resource: "users/1/messages" }]), undefined);
    assert.equal(acceptGraphNotification("state", [{ clientState: "other" }]), "client state does not match");
  });
});
