import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canViewMeetings, denyMeetings } from "../src/meetings/access";
import {
  mergeDiscoveryItems,
  sliceOrganizers,
  withinBackfillWindow,
} from "../src/meetings/ingest";
import { applyMatches, orgLessonTexts, overlapScore, ownerKey } from "../src/meetings/match";
import { parseMeetingSummary } from "../src/meetings/summarize";
import { capSummary, capTranscript, isTooShort, MAX_SUMMARY_CHARS, MAX_TRANSCRIPT_CHARS, parseVtt } from "../src/meetings/vtt";
import { transcriptsDeltaPath } from "../src/meetings/graph";
import {
  parseTranscriptSelectionKey,
  transcriptSelectionKey,
} from "../src/meetings/store";
import type { CommitmentDoc, MeetingSummary } from "../src/meetings/types";

const ADAM = "bceb24c5-ef85-4301-9ab2-073805d535aa";
const VAL = "4f323599-0df8-47f7-aa01-46dbb211894c";

function summary(over: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    title: "Standup",
    categories: ["ops"],
    summary: "Talked through the pipeline.",
    decisions: ["Ship Friday"],
    actions: [{ text: "file the change window", ownerName: "Adam", due: "2026-09-10" }],
    risks: [],
    openQuestions: [],
    attendees: ["adam", "val"],
    ...over,
  };
}

describe("vtt", () => {
  it("strips cues and speaker tags", () => {
    const raw = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
<v Adam>Hello there from the standup call today

2
00:00:02.000 --> 00:00:04.000
<v Val>We should file the change window by Friday
`;
    const spoken = parseVtt(raw);
    assert.match(spoken, /Hello there/);
    assert.match(spoken, /change window/);
    assert.doesNotMatch(spoken, /WEBVTT|00:00/);
  });

  it("skips short meetings and caps size", () => {
    assert.equal(isTooShort("only a few words here"), true);
    const long = Array(50).fill("word").join(" ");
    assert.equal(isTooShort(long), false);
    const huge = "x".repeat(MAX_TRANSCRIPT_CHARS + 50);
    assert.ok(capTranscript(huge).length <= MAX_TRANSCRIPT_CHARS + 20);
    assert.equal(capSummary("y".repeat(MAX_SUMMARY_CHARS + 10)).length, MAX_SUMMARY_CHARS);
  });
});

describe("delta and scan", () => {
  it("builds organizer-scoped delta path", () => {
    assert.match(transcriptsDeltaPath("abc"), /getAllTranscripts\(meetingOrganizerUserId='abc'\)/);
  });

  it("round-robins organizers without repeating in one slice", () => {
    const users = [0, 1, 2, 3, 4];
    const a = sliceOrganizers(users, 3, 3);
    assert.deepEqual(a.slice, [3, 4, 0]);
    const b = sliceOrganizers(users, a.next, 3);
    assert.deepEqual(b.slice, [1, 2, 3]);
    assert.deepEqual(sliceOrganizers([], 0).slice, []);
  });

  it("limits the first metadata backfill to 30 days", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    assert.equal(withinBackfillWindow("2026-08-20T12:00:00Z", now), true);
    assert.equal(withinBackfillWindow("2026-07-01T12:00:00Z", now), false);
    assert.equal(withinBackfillWindow(undefined, now), false);
    const old = { id: "old", createdDateTime: "2026-07-01T12:00:00Z" };
    const recent = { id: "recent", createdDateTime: "2026-08-20T12:00:00Z" };
    assert.deepEqual(
      mergeDiscoveryItems([old, recent], [old, recent], false, now).map(
        (t) => t.id
      ),
      ["recent"]
    );
    assert.deepEqual(
      mergeDiscoveryItems([old], [recent], true, now).map((t) => t.id),
      ["old", "recent"]
    );
  });

  it("round-trips transcript selection keys without exposing transcript content", () => {
    const key = transcriptSelectionKey("organizer-1", "MSo:transcript/1");
    assert.deepEqual(parseTranscriptSelectionKey(key), {
      organizerId: "organizer-1",
      id: "MSotranscript1",
    });
  });
});

describe("structured summary", () => {
  it("validates JSON and drops empty actions", () => {
    const parsed = parseMeetingSummary(
      JSON.stringify({
        title: "Budget review",
        categories: ["finance"],
        summary: "Approved the Q4 spend.",
        decisions: ["Hold vendor"],
        actions: [{ text: "Send PO", ownerName: "Val", due: "2026-09-12" }, { text: "" }],
        risks: ["slip"],
        openQuestions: ["who signs?"],
        attendees: ["Val"],
      })
    );
    assert.equal(parsed?.title, "Budget review");
    assert.equal(parsed?.actions.length, 1);
    assert.equal(parseMeetingSummary("not json"), undefined);
    assert.equal(parseMeetingSummary("{}"), undefined);
  });
});

describe("commitments", () => {
  it("matches same owner + similar work and caps org lessons", () => {
    assert.ok(overlapScore("file the change window", "file change window Friday") >= 0.45);
    assert.equal(ownerKey({ ownerName: "Adam" }), "adam");
    const open: CommitmentDoc[] = [
      {
        id: "c1",
        ownerKey: "adam",
        ownerName: "Adam",
        text: "file the change window",
        due: "2026-09-01",
        status: "open",
        sourceMeetingId: "old",
        sourceTitle: "Prior standup",
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ];
    const { upserts, matched } = applyMatches(open, summary(), "new", "Today standup");
    assert.equal(matched, 1);
    assert.equal(upserts[0]?.status, "done");
    const lessons = orgLessonTexts(summary({ actions: [{ text: "a", ownerName: "Val" }] }), 2);
    assert.ok(lessons.length <= 2);
  });

  it("creates a new open commitment when nothing matches", () => {
    const { upserts, matched } = applyMatches([], summary(), "m1", "Standup");
    assert.equal(matched, 0);
    assert.equal(upserts[0]?.status, "open");
    assert.equal(upserts[0]?.ownerKey, "adam");
  });
});

describe("authorization", () => {
  it("allows Adam and Val only", () => {
    assert.equal(canViewMeetings(ADAM), true);
    assert.equal(canViewMeetings(VAL.toUpperCase()), true);
    assert.equal(canViewMeetings("00000000-0000-0000-0000-000000000000"), false);
    assert.match(denyMeetings(), /designated org operators/);
  });
});
