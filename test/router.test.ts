import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetExceeded,
  capabilitiesFromError,
  chatSamplingParams,
  completionProblem,
  type ChatCapabilities,
} from "../src/services/router";

const legacy: ChatCapabilities = { completionParam: "max_tokens", allowTemperature: true };

test("legacy deployments send max_tokens and temperature", () => {
  const p = chatSamplingParams(legacy, 600, 0);
  assert.equal(p.max_tokens, 600);
  assert.equal(p.max_completion_tokens, undefined);
  assert.equal(p.temperature, 0);
});

test("a max_tokens rejection switches the deployment to max_completion_tokens", () => {
  const caps = capabilitiesFromError(
    legacy,
    "400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
  );
  assert.ok(caps);
  const p = chatSamplingParams(caps, 1200, 0.3);
  assert.equal(p.max_completion_tokens, 1200);
  assert.equal(p.max_tokens, undefined);
});

test("a temperature rejection drops temperature but keeps the token param", () => {
  const reasoning: ChatCapabilities = { completionParam: "max_completion_tokens", allowTemperature: true };
  const caps = capabilitiesFromError(
    reasoning,
    "400 Unsupported value: 'temperature' does not support 0.3 with this model."
  );
  assert.ok(caps);
  const p = chatSamplingParams(caps, 1200, 0.3);
  assert.equal(p.temperature, undefined);
  assert.equal(p.max_completion_tokens, 1200);
});

test("unrelated errors do not change capabilities", () => {
  assert.equal(capabilitiesFromError(legacy, "429 rate limit exceeded"), undefined);
});

test("reasoning effort is sent until a deployment rejects it", () => {
  const params = chatSamplingParams(legacy, 8000, 0, "low");
  assert.equal(params.reasoning_effort, "low");
  const rejected = capabilitiesFromError(
    legacy,
    "400 Unsupported parameter: 'reasoning_effort' is not supported with this model."
  );
  assert.equal(rejected?.allowReasoningEffort, false);
  assert.equal(chatSamplingParams(rejected!, 8000, 0, "low").reasoning_effort, undefined);
});

test("an empty completion is unusable and a tool call is not", () => {
  assert.equal(completionProblem({ finish_reason: "stop", message: { content: "" } }), "empty");
  assert.equal(completionProblem({ finish_reason: "length", message: { content: "" } }), "length");
  assert.equal(
    completionProblem({ finish_reason: "tool_calls", message: { content: "", tool_calls: [{}] } }),
    undefined
  );
  assert.equal(completionProblem({ finish_reason: "stop", message: { content: "Filed." } }), undefined);
});

test("a corrupt token counter does not trip the daily budget", () => {
  assert.equal(budgetExceeded(Number.NaN, 5_000_000), false);
  assert.equal(budgetExceeded(4_999_999, 5_000_000), false);
  assert.equal(budgetExceeded(5_000_000, 5_000_000), true);
});
