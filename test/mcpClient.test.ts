import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN_MCP_PROBE_MS, mcpServerCatalog, mcpServerSnapshot, resolveServerUrl } from "../src/tools/mcpClient";

describe("mcp client config", () => {
  it("resolves the browser URL from its env var, not a literal", () => {
    const browser = mcpServerCatalog().find((s) => s.name === "browser");
    assert.ok(browser, "browser server should be configured");
    assert.equal(browser.urlEnv, "BROWSER_MCP_URL");

    delete process.env.BROWSER_MCP_URL;
    assert.equal(resolveServerUrl(browser), undefined);

    process.env.BROWSER_MCP_URL = "https://browser.example/mcp";
    assert.equal(resolveServerUrl(browser), "https://browser.example/mcp");
    delete process.env.BROWSER_MCP_URL;
  });

  it("bounds the browser server so a restart or wedge cannot hang a page", () => {
    const browser = mcpServerCatalog().find((s) => s.name === "browser");
    assert.ok(browser?.timeoutMs && browser.timeoutMs <= 30_000);
    assert.ok(ADMIN_MCP_PROBE_MS < (browser?.timeoutMs ?? 0));
  });

  it("snapshots MCP config for the admin first paint without connecting", () => {
    delete process.env.BROWSER_MCP_URL;
    const snap = mcpServerSnapshot();
    const smartsheet = snap.find((s) => s.name === "smartsheet");
    const browser = snap.find((s) => s.name === "browser");
    assert.equal(smartsheet?.pending, true);
    assert.equal(smartsheet?.connected, false);
    assert.ok((smartsheet?.toolCount ?? 0) > 0);
    assert.match(browser?.error ?? "", /unset/);
    assert.equal(browser?.pending, undefined);
  });

  it("keeps the browser allowlist to reads only", () => {
    const browser = mcpServerCatalog().find((s) => s.name === "browser");
    assert.deepEqual(browser?.allowTools, ["navigate", "snapshot"]);
    assert.deepEqual(browser?.confirmTools, []);
  });
});
