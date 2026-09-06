import "./setup";
import { test } from "node:test";
import assert from "node:assert";
import { resolveIMessageUser, phoneForUser, toPlainText } from "../src/channels/types";

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
