import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatch } from "../src/tools/registry";
import {
  clampSearchCount,
  consumeBrowserBudget,
  consumeSearchBudget,
  hitsFromBing,
  hitsFromBrave,
  hitsFromTavily,
  parsePublicHttpUrl,
  shapeSearchHits,
  truncateSnapshot,
  SNAPSHOT_MAX_CHARS,
} from "../src/tools/webResearch";

describe("web research guards", () => {
  it("denies file, localhost, and private IPs", () => {
    assert.match(parsePublicHttpUrl("file:///etc/passwd").error ?? "", /http/);
    assert.match(parsePublicHttpUrl("http://localhost/admin").error ?? "", /not allowed/);
    assert.match(parsePublicHttpUrl("http://127.0.0.1/").error ?? "", /blocked/);
    assert.match(parsePublicHttpUrl("http://10.1.2.3/").error ?? "", /blocked/);
    assert.match(parsePublicHttpUrl("http://192.168.0.9/").error ?? "", /blocked/);
    assert.match(parsePublicHttpUrl("http://169.254.169.254/latest").error ?? "", /blocked/);
    assert.match(parsePublicHttpUrl("https://example.com/filing").href ?? "", /example.com/);
  });

  it("truncates snapshots and shapes search hits", () => {
    const long = "x".repeat(SNAPSHOT_MAX_CHARS + 50);
    const cut = truncateSnapshot(long);
    assert.ok(cut.length < long.length);
    assert.match(cut, /truncated 50 chars/);

    const tavily = hitsFromTavily({
      results: [
        { title: "FERC", url: "https://example.com/ferc", content: "Order" },
        { title: "Skip me" },
      ],
    });
    const text = shapeSearchHits(tavily, 8);
    assert.match(text, /1\. FERC/);
    assert.match(text, /https:\/\/example.com\/ferc/);
    assert.doesNotMatch(text, /Skip me/);

    const brave = hitsFromBrave({
      web: {
        results: [
          { title: "FERC", url: "https://example.com/ferc", description: "Order" },
          { title: "Skip me" },
        ],
      },
    });
    const braveText = shapeSearchHits(brave, 8);
    assert.match(braveText, /1\. FERC/);
    assert.match(text, /https:\/\/example.com\/ferc/);
    assert.doesNotMatch(text, /Skip me/);

    const bing = hitsFromBing({
      webPages: { value: [{ name: "Bing hit", url: "https://example.org/a", snippet: "n" }] },
    });
    assert.match(shapeSearchHits(bing), /Bing hit/);
    assert.equal(clampSearchCount(99), 8);
    assert.equal(clampSearchCount(2), 5);
  });

  it("enforces per-turn search and browser caps", () => {
    const ctx = { research: { searches: 0, browserCalls: 0 } };
    assert.equal(consumeSearchBudget(ctx), undefined);
    assert.match(consumeSearchBudget(ctx) ?? "", /cap/);
    assert.equal(consumeBrowserBudget(ctx), undefined);
    consumeBrowserBudget(ctx);
    consumeBrowserBudget(ctx);
    assert.match(consumeBrowserBudget(ctx) ?? "", /cap/);
  });

  it("blocks browser navigate to a denied URL without calling MCP", async () => {
    const msg = await dispatch({ userId: "u1" }, "browser__navigate", { url: "http://127.0.0.1/" });
    assert.match(msg, /blocked|not allowed/);
  });

  it("rejects non-allowlisted browser tools", async () => {
    const msg = await dispatch({ userId: "u1" }, "browser__click", { selector: "a" });
    assert.match(msg, /not allowed/);
  });

  it("web_search reports missing key without storing a body", async () => {
    delete process.env.WEB_SEARCH_API_KEY;
    const msg = await dispatch({ userId: "u1" }, "web_search", { query: "FERC this week" });
    assert.match(msg, /WEB_SEARCH_API_KEY/);
  });
});
