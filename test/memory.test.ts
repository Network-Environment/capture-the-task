import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOpinionAllowed, ORG_MEMORY_BANK, userBankId } from "../src/memory/banks";
import { parseQueryWindow, parseRetainPayload, intervalsOverlap } from "../src/memory/extract";
import { factKeywords } from "../src/memory/join";
import { applyOpinionConfidence } from "../src/memory/reflect";
import {
  citationsOf,
  reciprocalRankFusion,
  toRecalled,
  trimToTokenBudget,
} from "../src/memory/rrf";
import type { MemoryFact, RecalledFact } from "../src/memory/types";

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: over.id ?? "mf-1",
    bankId: over.bankId ?? "user:abc",
    docType: "fact",
    network: over.network ?? "world",
    text: over.text ?? "The change window is next Saturday.",
    mentionedAt: over.mentionedAt ?? "2026-09-08T12:00:00.000Z",
    entityIds: over.entityIds ?? ["org-person:per-val"],
    source: over.source ?? "meeting",
    sourceId: over.sourceId ?? "mtg-1",
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    ...over,
  };
}

describe("memory facts", () => {
  it("keys personal banks by entra id and keeps opinions off the org bank", () => {
    assert.equal(userBankId(" ABC-id "), "user:abc-id");
    assert.equal(isOpinionAllowed("opinion", ORG_MEMORY_BANK), false);
    assert.equal(isOpinionAllowed("world", ORG_MEMORY_BANK), true);
    assert.equal(isOpinionAllowed("opinion", userBankId("x")), true);
  });

  it("parses retain JSON and drops invalid networks", () => {
    const facts = parseRetainPayload(`
      {"facts":[
        {"text":"Val owns the change window.","network":"world","entities":["Val"],"orgRelevant":true,"confidence":0.9},
        {"text":"skip me","network":"gossip"}
      ]}
    `);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.network, "world");
    assert.equal(facts[0]?.orgRelevant, true);
  });

  it("fuses ranked lists with RRF and trims to a token budget", () => {
    const fused = reciprocalRankFusion([
      { strategy: "vector", ids: ["a", "b"] },
      { strategy: "keyword", ids: ["b", "c"] },
    ]);
    assert.ok((fused.get("b")?.score ?? 0) > (fused.get("a")?.score ?? 0));
    const factsById = new Map([
      ["a", fact({ id: "a", text: "aaaa".repeat(400) })],
      ["b", fact({ id: "b", text: "short" })],
    ]);
    const ranked = toRecalled(factsById, fused);
    const trimmed = trimToTokenBudget(ranked, 20);
    assert.equal(trimmed.facts[0]?.fact.id, "b");
    assert.equal(trimmed.truncated, true);
  });

  it("detects temporal query windows and overlapping fact intervals", () => {
    const window = parseQueryWindow("what did we decide last week about the window", new Date("2026-09-15T12:00:00Z"));
    assert.equal(window.from, "2026-09-08");
    assert.equal(window.to, "2026-09-15");
    assert.equal(
      intervalsOverlap("2026-09-10", "2026-09-12", window.from!, window.to!),
      true
    );
    assert.equal(intervalsOverlap("2026-08-01", "2026-08-02", window.from!, window.to!), false);
  });

  it("bumps and decays private opinion confidence", () => {
    assert.equal(applyOpinionConfidence(0.5, "agree"), 0.58);
    assert.equal(applyOpinionConfidence(0.5, "contradict"), 0.38);
    assert.equal(applyOpinionConfidence(undefined, "new"), 0.55);
  });

  it("extracts keywords for proposed graph joins and cites sources", () => {
    assert.deepEqual(factKeywords("The change window is next Saturday."), ["change", "window", "next", "saturday"]);
    const hits: RecalledFact[] = [
      { fact: fact(), score: 1, strategies: ["vector"] },
    ];
    assert.deepEqual(citationsOf(hits), ["meeting:mtg-1"]);
  });
});
