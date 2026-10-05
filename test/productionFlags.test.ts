import "./setup";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PRODUCTION_FLAG_DEFAULTS } from "../src/config";

describe("production flag defaults", () => {
  it("matches the Bicep contract when an app setting is missing", () => {
    assert.equal(PRODUCTION_FLAG_DEFAULTS.INTENT_GATEWAY_ENABLED, true);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.INTENT_SHADOW_MODE, false);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.CLARIFICATION_ENFORCEMENT_ENABLED, true);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.UNIFIED_ACTION_POLICY_ENABLED, true);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.LEGACY_TRIAGE_WRITES_ENABLED, false);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.INBOUND_QUALITY_GATE_ENABLED, true);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.EXECUTION_GRAPH_WRITES_ENABLED, false);

    const bicep = readFileSync(new URL("../infra/main.bicep", import.meta.url), "utf8");
    assert.match(bicep, /param intentGatewayEnabled bool = true/);
    assert.match(bicep, /param intentShadowMode bool = false/);
    assert.match(bicep, /param clarificationEnforcementEnabled bool = true/);
    assert.match(bicep, /param unifiedActionPolicyEnabled bool = true/);
    assert.match(bicep, /param legacyTriageWritesEnabled bool = false/);
    assert.match(bicep, /param inboundQualityGateEnabled bool = true/);
    assert.match(bicep, /param executionGraphWritesEnabled bool = false/);
    assert.match(bicep, /var deliveryGatewayToken = concat\(uniqueString/);
    assert.doesNotMatch(bicep, /DELIVERY_GATEWAY_TOKEN', value: adminAppSecret/);
  });
});
