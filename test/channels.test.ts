import "./setup";
import { test } from "node:test";
import assert from "node:assert";
import { resolveIMessageUser, phoneForUser, toPlainText } from "../src/channels/types";
import { botWasMentioned, isPersonalTeamsConversation, stripBotMention } from "../src/channels/teamsText";

test("unknown phone numbers resolve to nobody (allowlist)", () => {
  assert.strictEqual(resolveIMessageUser("+19999999999"), undefined);
});

test("identity map round-trips", () => {
  const phone = "+16152393232";
  const user = resolveIMessageUser(phone);
  assert.ok(user);
  assert.strictEqual(phoneForUser(user!), phone);
});

test("plain-text rendering strips markdown", () => {
  const out = toPlainText("Task captured", "**Call vendor** — due 2026-09-05\n`path/x.md`", ["pmo"]);
  assert.ok(!out.includes("**"));
  assert.ok(!out.includes("`"));
  assert.ok(out.endsWith("#pmo"));
});

test("Teams @mention markup is stripped; other people are left intact", () => {
  const bot = { id: "28:bot", name: "TaskBrain" };
  const entities = [
    { type: "mention", text: "<at>TaskBrain</at>", mentioned: { id: "28:bot", name: "TaskBrain" } },
    { type: "mention", text: "<at>Adam</at>", mentioned: { id: "29:adam", name: "Adam" } },
  ];
  const text = stripBotMention("<at>TaskBrain</at> tell <at>Adam</at> to file the window", entities, bot);
  assert.equal(text, "tell <at>Adam</at> to file the window");
  assert.equal(botWasMentioned(entities, bot.id, bot.name), true);
  assert.equal(
    botWasMentioned(undefined, bot.id, bot.name, "<at>TaskBrain</at> what's open"),
    true
  );
  assert.equal(isPersonalTeamsConversation("channel"), false);
  assert.equal(isPersonalTeamsConversation("personal"), true);
});
