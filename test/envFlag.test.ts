import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envFlag } from "../src/config";

function withEnv(name: string, value: string | undefined, run: () => void): void {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    run();
  } finally {
    if (prior == null) delete process.env[name];
    else process.env[name] = prior;
  }
}

describe("boolean app settings", () => {
  it("accepts Bicep-style True/False as well as lowercase", () => {
    withEnv("TB_FLAG", "False", () => assert.equal(envFlag("TB_FLAG", true), false));
    withEnv("TB_FLAG", "True", () => assert.equal(envFlag("TB_FLAG", false), true));
    withEnv("TB_FLAG", "false", () => assert.equal(envFlag("TB_FLAG", true), false));
    withEnv("TB_FLAG", " TRUE ", () => assert.equal(envFlag("TB_FLAG", false), true));
  });

  it("falls back to the default when unset or unrecognized", () => {
    withEnv("TB_FLAG", undefined, () => {
      assert.equal(envFlag("TB_FLAG", true), true);
      assert.equal(envFlag("TB_FLAG", false), false);
    });
    withEnv("TB_FLAG", "maybe", () => assert.equal(envFlag("TB_FLAG", true), true));
  });
});
