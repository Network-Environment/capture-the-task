import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTriageResult } from "../src/services/agent";
import { THINKING_RESPONSE } from "../src/channels/types";

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

test("both adapters share the requested thinking acknowledgement", () => {
  assert.equal(THINKING_RESPONSE, "thinking about response");
});
