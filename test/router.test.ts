import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitiesFromError, chatSamplingParams, type ChatCapabilities } from "../src/services/router";

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
