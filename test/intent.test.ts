import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { channelPolicy } from "../src/channels/types";
import {
  evaluateOperation,
  planNeedsClarification,
  validateIntentPlan,
  type OperationMetadata,
} from "../src/services/intent";
import { dispatch, operationMetadata } from "../src/tools/registry";

describe("intent validation", () => {
  it("accepts ordered multi-intent plans", () => {
    const plan = validateIntentPlan({
      confidence: 0.94,
      assumptions: [],
      intents: [
        {
          kind: "capture",
          captureKind: "task",
          standalone: "Call Pat",
          title: "Call Pat",
          confidence: 0.95,
          explicit: true,
        },
        {
          kind: "read",
          standalone: "Find the latest project status",
          confidence: 0.92,
          explicit: true,
        },
      ],
    });
    assert.equal(plan?.intents.length, 2);
    assert.equal(planNeedsClarification(plan!), false);
  });

  it("fails closed on malformed or uncertain mutations", () => {
    assert.equal(validateIntentPlan({ intents: [] }), undefined);
    const uncertain = validateIntentPlan({
      confidence: 0.6,
      assumptions: ["that means the shared tracker"],
      intents: [{
        kind: "act",
        standalone: "Update it",
        confidence: 0.6,
        explicit: false,
        ambiguity: "Which tracker and row?",
      }],
    });
    assert.equal(planNeedsClarification(uncertain!), true);
  });

  it("allows read-only interpretation with caveated ambiguity", () => {
    const read = validateIntentPlan({
      confidence: 0.9,
      assumptions: [],
      clarification: "Which digest?",
      intents: [{
        kind: "read",
        standalone: "Inspect the weekly digest",
        confidence: 0.9,
        explicit: true,
        ambiguity: "There may be more than one digest",
        missing: ["exact job id"],
      }],
    });
    assert.equal(planNeedsClarification(read!), false);
    assert.equal(read?.clarification, undefined);
  });
});

describe("risk policy", () => {
  const privateTeams = channelPolicy("teams", {
    scope: "private",
    identity: "canonical",
    allowActions: true,
  });
  const decide = (
    effect: OperationMetadata["effect"],
    explicit = true,
    confidence = 0.95
  ) =>
    evaluateOperation(
      { name: "test", effect, reversible: true, description: "test" },
      { explicit, confidence, channel: privateTeams }
    ).decision;

  it("executes reads and explicit reversible personal writes", () => {
    assert.equal(decide("read", false), "execute");
    assert.equal(decide("personal_write"), "execute");
  });

  it("clarifies uncertain or inferred mutations", () => {
    assert.equal(decide("personal_write", false), "clarify");
    assert.equal(decide("shared_write", true, 0.5), "clarify");
  });

  it("requires approval for high-impact effects", () => {
    for (const effect of ["shared_write", "destructive", "scheduled", "external_cost"] as const) {
      assert.equal(decide(effect), "approve");
    }
  });

  it("blocks mutations in group conversations and capture-only channels", () => {
    const group = channelPolicy("teams", {
      scope: "group",
      identity: "canonical",
      allowActions: true,
    });
    assert.equal(
      evaluateOperation(
        { name: "save", effect: "personal_write", reversible: true, description: "save" },
        { explicit: true, confidence: 1, channel: group }
      ).decision,
      "deny"
    );
  });

  it("classifies every native mutation centrally", () => {
    assert.equal(operationMetadata("save_note").effect, "personal_write");
    assert.equal(operationMetadata("schedule_job").effect, "scheduled");
    assert.equal(operationMetadata("cancel_job").effect, "destructive");
    assert.equal(operationMetadata("complete_commitment").effect, "shared_write");
    assert.equal(operationMetadata("create_graph_task").effect, "shared_write");
    assert.equal(operationMetadata("smartsheet__get_sheet").effect, "read");
    assert.equal(operationMetadata("future__mutate_everything").effect, "shared_write");
  });

  it("enforces scheduled tool envelopes at dispatch", async () => {
    const result = await dispatch(
      { userId: "test", channel: "internal", allowedTools: [] },
      "save_note",
      { kind: "idea", title: "should not save", body: "blocked" }
    );
    assert.match(result, /outside this job's approved tool envelope/);
  });
});
