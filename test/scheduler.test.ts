import "./setup";
import { test } from "node:test";
import assert from "node:assert";
import { computeNextRun } from "../src/services/scheduler";

test("cron: Fridays 4pm advances to a Friday", () => {
  const next = new Date(computeNextRun("0 16 * * 5", undefined, new Date("2026-09-03T12:00:00Z")));
  assert.strictEqual(next.getUTCDay() === 5 || next.getDay() === 5, true);
});

test("runOnce passes through", () => {
  assert.strictEqual(
    computeNextRun(undefined, "2026-12-01T09:00:00Z"),
    new Date("2026-12-01T09:00:00Z").toISOString()
  );
});

test("missing schedule throws", () => {
  assert.throws(() => computeNextRun(undefined, undefined));
});
