import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentSkillCatalog,
  agentSkillsPromptBlock,
} from "../src/services/agentSkills";
import { loadConfig } from "../src/config";

describe("TaskBrain runtime skills", () => {
  it("loads work follow-through as instructions rather than a tool", () => {
    const skill = agentSkillCatalog().find(
      (entry) => entry.name === "work-followthrough"
    );
    assert.ok(skill);
    assert.ok(skill.skill.tools.includes("assess_assignment"));
    assert.ok(skill.skill.tools.includes("assign_work"));

    const prompt = agentSkillsPromptBlock(["work-followthrough"]);
    assert.match(prompt, /Before named assign_work, call assess_assignment/);
    assert.match(prompt, /never guess an Entra id/i);
    assert.match(prompt, /assign only if they still want that owner/i);
  });

  it("loads daily and timeline workflows as runtime skills", () => {
    const prompt = agentSkillsPromptBlock([
      "daily-followthrough",
      "timeline-planning",
    ]);
    assert.match(prompt, /never invent or hard-code a daily timer/i);
    assert.match(prompt, /Individuals receive only their own plate/i);
    assert.match(prompt, /Distinguish committed due dates from calculated estimates/i);
  });

  it("loads user orientation as a capture skill that calls the guide tool", () => {
    const skill = agentSkillCatalog().find((entry) => entry.name === "user-orientation");
    assert.ok(skill);
    assert.deepEqual(skill.skill.tools, ["explain_taskbrain"]);
    const prompt = agentSkillsPromptBlock(["user-orientation"]);
    assert.match(prompt, /Always call explain_taskbrain/i);
    assert.match(prompt, /Never capture, schedule, or assign from a help request/i);
    const agents = loadConfig<{
      profiles: Record<string, { skills?: string[] }>;
    }>("agents");
    assert.ok(agents.profiles.capture.skills?.includes("user-orientation"));
  });

  it("fails closed when a profile names an unknown skill", () => {
    assert.throws(
      () => agentSkillsPromptBlock(["not-a-skill"]),
      /unknown skill/i
    );
  });
});
