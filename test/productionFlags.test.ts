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
    assert.equal(PRODUCTION_FLAG_DEFAULTS.RECOVERY_INCIDENTS_ENABLED, true);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.RECOVERY_ENFORCE_QUARANTINE, false);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.RECOVERY_MEETING_RETRY, false);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.RECOVERY_REPLAY_ENABLED, false);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.MODEL_REPAIR_ENABLED, false);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.MODEL_VERIFIER_SHADOW, true);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.MODEL_LEARNING_CANDIDATES_ENABLED, false);
    assert.equal(PRODUCTION_FLAG_DEFAULTS.MODEL_BEHAVIOR_SHADOW, false);

    const bicep = readFileSync(new URL("../infra/main.bicep", import.meta.url), "utf8");
    assert.match(bicep, /param intentGatewayEnabled bool = true/);
    assert.match(bicep, /param intentShadowMode bool = false/);
    assert.match(bicep, /param clarificationEnforcementEnabled bool = true/);
    assert.match(bicep, /param unifiedActionPolicyEnabled bool = true/);
    assert.match(bicep, /param legacyTriageWritesEnabled bool = false/);
    assert.match(bicep, /param inboundQualityGateEnabled bool = true/);
    assert.match(bicep, /param executionGraphWritesEnabled bool = false/);
    assert.match(bicep, /param recoveryIncidentsEnabled bool = true/);
    assert.match(bicep, /param recoveryEnforceQuarantine bool = false/);
    assert.match(bicep, /param modelVerifierShadow bool = true/);
    assert.match(bicep, /param alertEmail string = ''/);
    assert.match(bicep, /recovery-incidents/);
    assert.match(bicep, /Microsoft.Insights\/actionGroups/);
    assert.match(bicep, /var deliveryGatewayToken = concat\(uniqueString/);
    assert.doesNotMatch(bicep, /DELIVERY_GATEWAY_TOKEN', value: adminAppSecret/);
  });
});
