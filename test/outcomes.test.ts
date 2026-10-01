import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyStepResult,
  classifyStepResult,
  parseOutcomeSteps,
  type OutcomeJob,
} from "../src/work/outcomes";
import { connectorCandidates } from "../src/services/connectorBacklog";
import { formatSavedSkills, type SavedSkill } from "../src/services/savedSkills";

function job(): OutcomeJob {
  return {
    id: "out-1",
    userId: "u",
    name: "Launch",
    status: "running",
    cursor: 0,
    enabled: true,
    nextRun: "2026-10-01T00:00:00.000Z",
    steps: [
      { profile: "capture", prompt: "Draft the note", status: "pending" },
      { profile: "pmo", prompt: "Read the risk row", status: "pending" },
    ],
  };
}

describe("checkpointed outcomes", () => {
  it("advances to the named profile after a finished step", () => {
    const next = applyStepResult(job(), "Draft saved.");
    assert.equal(next.cursor, 1);
    assert.equal(next.steps[0].status, "done");
    assert.equal(next.steps[1].profile, "pmo");
    assert.equal(next.status, "queued");
    assert.equal(next.enabled, true);
  });

  it("freezes on approval and on a question", () => {
    const approval = applyStepResult(job(), "Reply approve pa-abc123");
    assert.equal(approval.status, "waiting_approval");
    assert.equal(approval.enabled, false);
    assert.equal(approval.cursor, 0);
    const question = applyStepResult(job(), "Question recorded. Stop and do not call more tools.");
    assert.equal(question.status, "waiting_user");
    assert.equal(classifyStepResult("I hit my tool-call limit before finishing"), "limit");
  });

  it("rejects an unknown profile", () => {
    const parsed = parseOutcomeSteps("do it", [{ profile: "shopper", prompt: "buy milk" }], ["capture", "pmo"]);
    assert.match(String(parsed), /Unknown profile/);
  });
});

describe("connector candidates", () => {
  it("proposes a disabled allowlisted entry only for a repeated uncovered gap", () => {
    const gaps = [
      { capability: "update the warranty portal" },
      { capability: "update the warranty portal" },
      { capability: "search my mail" },
      { capability: "search my mail" },
      { capability: "once only" },
    ];
    const candidates = connectorCandidates(gaps, ["smartsheet"]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, "update-the-warranty-portal");
    assert.equal(candidates[0].entry.enabled, false);
    assert.deepEqual(candidates[0].entry.allowTools, []);
  });
});

describe("saved skills", () => {
  it("tells the agent that a saved skill still waits for approval", () => {
    const skill: SavedSkill = {
      id: "skill-1",
      userId: "u",
      scope: "user",
      name: "Friday risk note",
      description: "Read the register and draft a note",
      when: ["Friday risk pass"],
      tools: ["smartsheet__search", "save_note"],
      confirmationPoints: ["save_note"],
      instructions: ["Search before writing."],
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const text = formatSavedSkills([skill]);
    assert.match(text, /Friday risk note/);
    assert.match(text, /still wait for approval/);
    assert.match(text, /does not skip the normal approval gate/);
  });
});
