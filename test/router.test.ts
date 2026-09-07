import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSamplingParams } from "../src/services/router";

test("gpt-5-mini uses max_completion_tokens and drops temperature", () => {
  const p = chatSamplingParams("gpt-5-mini", 1200, 0.3);
  assert.equal(p.max_completion_tokens, 1200);
  assert.equal(p.max_tokens, undefined);
  assert.equal(p.temperature, undefined);
});

test("gpt-4.1-mini keeps max_tokens and temperature", () => {
  const p = chatSamplingParams("gpt-4.1-mini", 600, 0);
  assert.equal(p.max_tokens, 600);
  assert.equal(p.max_completion_tokens, undefined);
  assert.equal(p.temperature, 0);
});
