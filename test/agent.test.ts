import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTriageResult } from "../src/services/agent";
import { WORKING_RESPONSE } from "../src/channels/types";

test("casual conversation is a non-persistent triage kind", () => {
  assert.deepEqual(
    normalizeTriageResult('{"kind":"conversation"}'),
    { kind: "conversation", tags: [], links: [], detail: "" }
  );
});

test("invalid triage output fails safe without creating a note", () => {
  assert.deepEqual(normalizeTriageResult("not json"), { kind: "conversation" });
  assert.deepEqual(normalizeTriageResult('{"kind":"unknown"}'), { kind: "conversation" });
  assert.deepEqual(normalizeTriageResult('{"kind":"idea"}'), { kind: "conversation" });
});

test("capture fields are normalized for valid persistent kinds", () => {
  assert.deepEqual(
    normalizeTriageResult('{"kind":"idea","title":"Test","detail":"Keep this"}'),
    {
      kind: "idea",
      title: "Test",
      detail: "Keep this",
      tags: [],
      links: [],
    }
  );
});

test("both adapters hide queue internals behind a natural acknowledgement", () => {
  assert.equal(WORKING_RESPONSE, "Got it — I’m working on that.");
  assert.doesNotMatch(WORKING_RESPONSE, /queue|request id/i);
});
