import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canApplyPref, defaultQueues, parseExecutionQueues, workingStyleLine } from "../src/org/prefs";
import { workAdaptiveCard } from "../src/work/cards";
import { newWorkId, type WorkAssignment } from "../src/work/types";
import type { OrgPerson } from "../src/org/types";

function person(over: Partial<OrgPerson> = {}): OrgPerson {
  return {
    id: "per-val",
    kind: "person",
    displayName: "Valerie Moraru",
    aliases: ["Val"],
    mandate: "",
    status: "active",
    createdAt: "2026-09-15T00:00:00Z",
    updatedAt: "2026-09-15T00:00:00Z",
    ...over,
  };
}

describe("work assignment", () => {
  it("defaults queues to teams and formats the org one-liner", () => {
    assert.deepEqual(defaultQueues(person()), ["teams"]);
    assert.deepEqual(parseExecutionQueues("todo planner todo"), ["todo", "planner"]);
    const line = workingStyleLine(
      person({
        executionQueues: ["todo"],
        nudgeChannel: "email",
        workingNotes: "reviews Smartsheet Monday AM",
      })
    );
    assert.match(line, /Work: todo \+ Teams card/);
    assert.match(line, /Nudge: email/);
    assert.match(line, /Monday AM/);
  });

  it("does not let inferred prefs override admin or explicit", () => {
    assert.equal(canApplyPref("admin", "explicit"), false);
    assert.equal(canApplyPref("explicit", "inferred"), false);
    assert.equal(canApplyPref("inferred", "explicit"), true);
    assert.equal(canApplyPref(undefined, "inferred"), true);
  });

  it("builds an Adaptive Card bound to the work id", () => {
    const work: WorkAssignment = {
      id: newWorkId(),
      ownerPersonId: "per-val",
      title: "File the change window",
      due: "2026-09-19",
      source: "chat",
      status: "open",
      destinations: [],
      createdAt: "2026-09-15T00:00:00Z",
      updatedAt: "2026-09-15T00:00:00Z",
    };
    const card = workAdaptiveCard(work);
    assert.equal(card.type, "AdaptiveCard");
    const actions = card.actions as { title: string; data: { taskbrainWork: string; workId: string } }[];
    assert.deepEqual(
      actions.map((a) => a.data.taskbrainWork),
      ["accept", "done", "snooze"]
    );
    assert.equal(actions[0]?.data.workId, work.id);
  });
});
