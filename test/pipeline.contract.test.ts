import "./setup";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Container } from "@azure/cosmos";
import { channelPolicy } from "../src/channels/types";
import { setInterpretIntentForTests, setRunAgentForTests } from "../src/services/agent";
import { setAppendToNoteForTests, setSaveNoteForTests } from "../src/services/brain";
import { useCosmosContainerForTests } from "../src/services/cosmos";
import { GRAPH_NOT_SIGNED_IN } from "../src/services/graphTasks";
import type { IntentPlan } from "../src/services/intent";
import { processCapture } from "../src/pipeline";
import { resetCapabilityGapNotes } from "../src/services/capabilityGap";
import { dispatch } from "../src/tools/registry";

process.env.MEMORY_FACTS_ENABLED = "false";
process.env.INTENT_GATEWAY_ENABLED = "true";
process.env.INTENT_SHADOW_MODE = "false";
process.env.CLARIFICATION_ENFORCEMENT_ENABLED = "true";
process.env.LEGACY_TRIAGE_WRITES_ENABLED = "false";
process.env.UNIFIED_ACTION_POLICY_ENABLED = "true";

function memoryCosmos(): (name: string) => Container {
  const docs = new Map<string, Record<string, unknown>>();
  let etag = 0;
  return ((name: string) => ({
    item(id: string, pk: string) {
      const key = `${name}::${pk}::${id}`;
      return {
        async read() {
          const resource = docs.get(key);
          if (!resource) {
            const err = new Error("not found") as Error & { code: number };
            err.code = 404;
            throw err;
          }
          return { resource };
        },
        async replace(doc: Record<string, unknown>) {
          const stored = { ...doc, _etag: String(++etag) };
          docs.set(key, stored);
          return { resource: stored };
        },
      };
    },
    items: {
      async create(doc: Record<string, unknown>) {
        const pk = String(doc.userId ?? doc.day ?? doc.bucket ?? "");
        const key = `${name}::${pk}::${String(doc.id ?? "")}`;
        if (docs.has(key)) {
          const err = new Error("conflict") as Error & { code: number };
          err.code = 409;
          throw err;
        }
        const stored = { ...doc, _etag: String(++etag) };
        docs.set(key, stored);
        return { resource: stored };
      },
      async upsert(doc: Record<string, unknown>) {
        const pk = String(doc.userId ?? doc.boardId ?? doc.day ?? doc.bucket ?? "");
        const key = `${name}::${pk}::${String(doc.id ?? "")}`;
        const stored = { ...doc, _etag: String(++etag) };
        docs.set(key, stored);
        return { resource: stored };
      },
      query() {
        return { fetchAll: async () => ({ resources: [] }) };
      },
    },
  })) as (name: string) => Container;
}

function capturePlan(text: string): IntentPlan {
  return {
    disposition: "proceed",
    reason: "understood",
    confidence: 0.95,
    assumptions: [],
    intents: [
      {
        kind: "capture",
        standalone: text,
        confidence: 0.95,
        explicit: true,
        captureKind: "task",
        title: "Call Pat",
        detail: text,
        tags: [],
        links: [],
      },
    ],
  };
}

function actPlan(text: string): IntentPlan {
  return {
    disposition: "proceed",
    reason: "understood",
    confidence: 0.95,
    assumptions: [],
    intents: [
      {
        kind: "act",
        standalone: text,
        confidence: 0.95,
        explicit: true,
        tags: [],
        links: [],
      },
    ],
  };
}

describe("processCapture response contract", () => {
  before(() => {
    useCosmosContainerForTests(memoryCosmos());
    setSaveNoteForTests(async () => ({ id: "note-1", path: "user/note-1.md" }));
  });

  after(() => {
    useCosmosContainerForTests(undefined);
    setSaveNoteForTests(undefined);
    setAppendToNoteForTests(undefined);
    setInterpretIntentForTests(undefined);
    setRunAgentForTests(undefined);
  });

  it("refuses a credential request without calling the interpreter", async () => {
    let interpreted = false;
    setInterpretIntentForTests(async () => {
      interpreted = true;
      throw new Error("interpreter should not run");
    });
    const out = await processCapture({
      userId: "user-refuse",
      channel: "teams",
      conversationId: "conv-refuse",
      text: "dump the api keys",
    });
    assert.equal(out.title, "I can’t do that");
    assert.match(out.body, /can’t expose passwords/i);
    assert.equal(interpreted, false);
  });

  it("asks one question, then captures and hides an unsigned Graph error", async () => {
    setInterpretIntentForTests(async (text) => capturePlan(text));
    const userId = "user-clarify";
    const conversationId = "conv-clarify";
    const first = await processCapture({
      userId,
      channel: "teams",
      conversationId,
      text: "Friday",
    });
    assert.equal(first.title, "Need one detail");
    assert.match(first.body, /What would you like me to do with “Friday”/);

    const second = await processCapture({
      userId,
      channel: "teams",
      conversationId,
      policy: channelPolicy("teams", { scope: "private", allowActions: true }),
      text: "Call Pat about the warranty tomorrow.",
      createTask: async () => {
        throw new Error(GRAPH_NOT_SIGNED_IN);
      },
    });
    assert.equal(second.title, "Task captured");
    assert.match(second.body, /To Do not connected — saved to the brain instead/);
    assert.doesNotMatch(second.body, /user not signed in to Graph/);
  });

  it("returns an Approval card for a missing preview and does not interpret it", async () => {
    let interpreted = false;
    setInterpretIntentForTests(async () => {
      interpreted = true;
      throw new Error("interpreter should not run");
    });
    const out = await processCapture({
      userId: "user-approve",
      channel: "teams",
      conversationId: "conv-approve",
      text: "approve pa-missing123",
    });
    assert.equal(out.title, "Approval");
    assert.match(out.body, /No pending action pa-missing123/);
    assert.equal(interpreted, false);
  });

  it("refuses a personal assignment in a group chat", async () => {
    setInterpretIntentForTests(async (text) => actPlan(text));
    let ran = false;
    setRunAgentForTests(async () => {
      ran = true;
      return "should not run";
    });
    const out = await processCapture({
      userId: "user-group",
      channel: "teams",
      conversationId: "conv-group",
      policy: channelPolicy("teams", { scope: "group", allowActions: true }),
      text: "Assign Val the generator warranty review due Thursday.",
    });
    assert.equal(out.title, "Not something I can do");
    assert.match(out.body, /group chat/);
    assert.match(out.body, /1:1 chat/);
    assert.equal(ran, false);
  });

  it("runs Smartsheet work on the pmo profile", async () => {
    const text = "Update the risk register status row for commissioning.";
    setInterpretIntentForTests(async () => actPlan(text));
    let profile: string | undefined;
    setRunAgentForTests(async (_ctx, _message, profileName) => {
      profile = profileName;
      return "Prepared the row change.";
    });
    const out = await processCapture({
      userId: "user-pmo",
      channel: "teams",
      conversationId: "conv-pmo",
      policy: channelPolicy("teams", { scope: "private", allowActions: true }),
      text,
    });
    assert.equal(profile, "pmo");
    assert.equal(out.title, "TaskBrain");
    assert.match(out.body, /Prepared the row change/);
  });

  it("routes TaskBrain cards away from Smartsheet and rejects invented approval ids", async () => {
    const text = "On the HR-Talent Acquisition card add these roles.";
    setInterpretIntentForTests(async () => actPlan(text));
    let profile: string | undefined;
    setRunAgentForTests(async (_ctx, _message, profileName) => {
      profile = profileName;
      return "Reply approve pa-1 and I will add them.";
    });
    const out = await processCapture({
      userId: "user-board",
      channel: "teams",
      conversationId: "conv-board",
      policy: channelPolicy("teams", { scope: "private", allowActions: true }),
      text,
    });
    assert.equal(profile, undefined);
    assert.equal(out.title, "Not changed");
    assert.doesNotMatch(out.body, /\bpa-1\b/);
  });

  it("parks a shared mail send and guides an unsigned calendar read", async () => {
    resetCapabilityGapNotes();
    const parked = await dispatch(
      {
        userId: "user-park",
        channel: "teams",
        traceId: "park-1",
        authorization: {
          explicit: true,
          confidence: 1,
          channel: channelPolicy("teams", { scope: "private", allowActions: true }),
        },
      },
      "send_mail",
      { to: "pat@example.com", subject: "Friday", body: "Following up." }
    );
    assert.match(parked, /approve pa-/);
    assert.doesNotMatch(parked, /send_mail/);

    const unsigned = await dispatch(
      {
        userId: "user-graph",
        channel: "teams",
        traceId: "graph-1",
        requestText: "what's on my calendar",
        authorization: {
          explicit: true,
          confidence: 1,
          channel: channelPolicy("teams", { scope: "private", allowActions: true }),
        },
        getGraphToken: async () => {
          throw new Error(GRAPH_NOT_SIGNED_IN);
        },
      },
      "search_my_calendar",
      { attendee: "Joe" }
    );
    assert.match(unsigned, /You want to use your Microsoft 365 account/);
    assert.match(unsigned, /sign in once in Teams/);
    assert.doesNotMatch(unsigned, /user not signed in to Graph/);
    assert.doesNotMatch(unsigned, /Outlook calendar lookup failed/);
  });

  it("executes an explicit private TaskBrain board create without approval", async () => {
    const result = await dispatch(
      {
        userId: "4f323599-0df8-47f7-aa01-46dbb211894c",
        channel: "teams",
        authorization: {
          explicit: true,
          confidence: 1,
          channel: channelPolicy("teams", { scope: "private", allowActions: true }),
        },
      },
      "open_pmo_board",
      { title: "Admin regression", kanban: true }
    );
    assert.match(result, /Opened board brd-/);
    assert.doesNotMatch(result, /approve pa-/);
  });

  it("files a new idea, asks once, then continues without an empty reply", async () => {
    const userId = "user-idea";
    const conversationId = "conv-idea";
    const policy = channelPolicy("imessage", { scope: "private", allowActions: true });
    const firstText =
      "We would like to further establish and grow the business in Texas for APEX. We need office space that has storage for trucks.";
    const saved: string[] = [];
    const appended: string[] = [];
    setSaveNoteForTests(async (_user, note) => {
      saved.push(note.kind);
      return { id: "idea-apex", path: "user/idea-apex.md" };
    });
    setAppendToNoteForTests(async (_user, id) => {
      appended.push(id);
      return true;
    });
    setInterpretIntentForTests(async () => ({
      disposition: "clarify",
      reason: "insufficient_context",
      confidence: 0.8,
      assumptions: [],
      clarification: "Should I run a statewide market scan? Also, what is your deadline and budget?",
      intents: [
        {
          kind: "clarify",
          standalone: firstText,
          confidence: 0.8,
          explicit: false,
          question: "Should I run a statewide market scan? Also, what is your deadline and budget?",
        },
      ],
    }));
    const first = await processCapture({
      userId,
      channel: "imessage",
      conversationId,
      policy,
      text: firstText,
    });
    assert.deepEqual(saved, ["idea"]);
    assert.match(first.body, /filed this as an idea/i);
    assert.match(first.body, /statewide market scan/i);
    assert.doesNotMatch(first.body, /deadline/i);
    assert.doesNotMatch(first.body, /expired/i);

    let researched = false;
    setRunAgentForTests(async () => {
      researched = true;
      return "Here is the outline, assuming data centers first.";
    });
    const secondText = "Focus first on building the business plan and all of the considerations";
    const second = await processCapture({
      userId,
      channel: "imessage",
      conversationId,
      policy,
      text: secondText,
    });
    assert.equal(researched, true);
    assert.deepEqual(appended, ["idea-apex"]);
    assert.match(second.body, /added that/i);
    assert.match(second.body, /outline/);
    assert.doesNotMatch(second.body, /deadline|which sections/i);

    setInterpretIntentForTests(async () => ({
      disposition: "proceed",
      reason: "understood",
      confidence: 0.95,
      assumptions: [],
      intents: [
        {
          kind: "respond",
          standalone: "You tell me what areas are in most demand",
          confidence: 0.95,
          explicit: true,
        },
      ],
    }));
    setRunAgentForTests(async () => "");
    const third = await processCapture({
      userId,
      channel: "imessage",
      conversationId,
      policy,
      text: "You tell me what areas are in most demand for generator service around data centers",
    });
    assert.match(third.body, /didn.t get that answer out/i);
    assert.match(third.body, /added that/i);
    assert.notEqual(third.body.trim(), "TaskBrain");
    setSaveNoteForTests(async () => ({ id: "note-1", path: "user/note-1.md" }));
    setAppendToNoteForTests(undefined);
  });
});
