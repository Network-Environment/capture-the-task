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
    assert.match(text, /last few hours of this private chat/i);
    assert.match(text, /what you asked it to remember/i);
    assert.match(text, /Ask about a specific area/);
    assert.match(text, /What is limited right now/);
    assert.match(text, /does not delete the Microsoft To Do task/);
    assert.match(text, /designated meeting viewers/);
    assert.match(text, /phone numbers already linked/);
    assert.match(text, /organization’s connection/);
    assert.doesNotMatch(text, /read-only/);
    assert.doesNotMatch(text, /Cosmos|Bicep|MCP|Admin/i);
  });

  it("states that calendar changes wait for approval and stay on the requester's calendar", () => {
    const text = formatUserGuide("calendar", full);
    assert.match(text, /approve pa-/i);
    assert.match(text, /never open another person’s calendar/i);
    const mail = formatUserGuide("mail", full);
    assert.match(mail, /after you approve/i);
    const files = formatUserGuide("files", full);
    assert.match(files, /after you approve/i);
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
    assert.match(overviewOff, /Shared project changes are read-only/);
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
    assert.match(imessage, /same sign-in works in Teams and iMessage/);
    assert.doesNotMatch(imessage, /need Teams/);
  });
});
