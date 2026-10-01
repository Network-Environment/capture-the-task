import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpServerCatalog, mcpServerSnapshot, resolveServerUrl } from "../src/tools/mcpClient";

describe("mcp client config", () => {
  it("resolves a literal server URL and ignores a missing env override", () => {
    const smartsheet = mcpServerCatalog().find((s) => s.name === "smartsheet");
    assert.ok(smartsheet, "smartsheet server should be configured");
    assert.equal(resolveServerUrl(smartsheet), "https://mcp.smartsheet.com");
    assert.equal(
      resolveServerUrl({ ...smartsheet, url: undefined, urlEnv: "BROWSER_MCP_URL" }),
      undefined
    );
  });

  it("does not configure a browser server", () => {
    assert.equal(mcpServerCatalog().some((s) => s.name === "browser"), false);
  });

  it("snapshots MCP config for the admin first paint without connecting", () => {
    const snap = mcpServerSnapshot();
    const smartsheet = snap.find((s) => s.name === "smartsheet");
    assert.equal(smartsheet?.pending, true);
    assert.equal(smartsheet?.connected, false);
    assert.ok((smartsheet?.toolCount ?? 0) > 0);
    assert.equal(snap.some((s) => s.name === "browser"), false);
  });

  it("keeps the Smartsheet write allowlist explicit", () => {
    const smartsheet = mcpServerCatalog().find((s) => s.name === "smartsheet");
    assert.ok(smartsheet?.allowTools?.includes("search"));
    assert.deepEqual(smartsheet?.confirmTools, ["add_rows", "update_rows"]);
  });
});
