import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentSkillCatalog,
  agentSkillsPromptBlock,
} from "../src/services/agentSkills";

describe("TaskBrain runtime skills", () => {
  it("loads work follow-through as instructions rather than a tool", () => {
    const skill = agentSkillCatalog().find(
      (entry) => entry.name === "work-followthrough"
    );
    assert.ok(skill);
    assert.ok(skill.skill.tools.includes("assess_assignment"));
    assert.ok(skill.skill.tools.includes("assign_work"));

    const prompt = agentSkillsPromptBlock(["work-followthrough"]);
    assert.match(prompt, /Before assign_work, call assess_assignment/);
    assert.match(prompt, /never guess an Entra id/i);
    assert.match(prompt, /assign only if they still want that owner/i);
  });

  it("fails closed when a profile names an unknown skill", () => {
    assert.throws(
      () => agentSkillsPromptBlock(["not-a-skill"]),
      /unknown skill/i
    );
  });
});
