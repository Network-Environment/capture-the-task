import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatUserGuide } from "../src/services/userGuide";

const full = {
  canViewMeetings: true,
  graphEnabled: true,
  graphWritesEnabled: true,
};

describe("TaskBrain user guide", () => {
  it("gives an overview with try-saying examples and no operator internals", () => {
    const text = formatUserGuide("overview", full);
    assert.match(text, /capture-and-follow-through/i);
    assert.match(text, /Try saying:/);
    assert.match(text, /Ask about a specific area/);
    assert.doesNotMatch(text, /Cosmos|Bicep|MCP|Admin/i);
  });

  it("states that calendar access cannot change meetings", () => {
    const text = formatUserGuide("calendar", full);
    assert.match(text, /cannot create, move, cancel, or decline meetings/i);
  });

  it("goes deeper on a named topic", () => {
    const text = formatUserGuide("work", full);
    assert.match(text, /Work follow-through/i);
    assert.match(text, /Have Val do the generator warranty review/);
    assert.match(text, /do not read colleagues’ calendars/i);
  });

  it("hides meeting-summary depth when the user is not a viewer", () => {
    const overview = formatUserGuide("overview", { ...full, canViewMeetings: false });
    assert.doesNotMatch(overview, /search stored meeting summaries/);
    const meetings = formatUserGuide("meetings", { ...full, canViewMeetings: false });
    assert.match(meetings, /designated meeting viewers/i);
    assert.doesNotMatch(meetings, /who committed to what/);
  });

  it("omits shared graph writes when the graph is off or read-only", () => {
    const off = formatUserGuide("projects", { ...full, graphEnabled: false });
    assert.match(off, /not enabled in this environment/i);
    assert.doesNotMatch(off, /source of truth for project/);
    const overviewOff = formatUserGuide("overview", { ...full, graphEnabled: false });
    assert.doesNotMatch(overviewOff, /Shared projects/);
    const readOnly = formatUserGuide("projects", {
      ...full,
      graphWritesEnabled: false,
    });
    assert.match(readOnly, /Creating or changing graph items is not enabled/);
  });

  it("notes group-chat and iMessage limits", () => {
    const group = formatUserGuide("overview", { ...full, scope: "group", channel: "teams" });
    assert.match(group, /group chat/i);
    assert.match(group, /will not save personal tasks/i);
    const imessage = formatUserGuide("calendar", { ...full, channel: "imessage" });
    assert.match(imessage, /On iMessage/);
  });
});
