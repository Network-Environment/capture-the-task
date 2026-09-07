import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canViewMeetings, denyMeetings } from "../src/meetings/access";
import { sliceOrganizers } from "../src/meetings/ingest";
import { applyMatches, orgLessonTexts, overlapScore, ownerKey } from "../src/meetings/match";
import { parseMeetingSummary } from "../src/meetings/summarize";
import { capSummary, capTranscript, isTooShort, MAX_SUMMARY_CHARS, MAX_TRANSCRIPT_CHARS, parseVtt } from "../src/meetings/vtt";
import { transcriptsDeltaPath } from "../src/meetings/graph";
import { renderDashboard } from "../src/admin/dashboard";
import type { DayStats } from "../src/services/activityLog";
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

describe("dashboard", () => {
  const emptyStats: DayStats = {
    captures: 0,
    toolCalls: 0,
    jobRuns: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    byModel: {},
  };

  it("renders empty meeting panels", () => {
    const html = renderDashboard({
      stats: emptyStats,
      totalTokens: 0,
      modelRows: "",
      jobRows: "",
      lessonRows: "",
      eventRows: "",
      signedIn: "local",
    });
    assert.match(html, /No ingest run yet/);
    assert.match(html, /No commitments ingested yet/);
    assert.match(html, /No meetings in the 90-day index yet/);
    assert.match(html, /No org lessons yet/);
  });

  it("renders ingest health, meetings, and overdue commitments", () => {
    const html = renderDashboard({
      stats: emptyStats,
      totalTokens: 0,
      modelRows: "",
      jobRows: "",
      lessonRows: "",
      orgLessonRows: `<tr><td>self</td><td>Watch ops follow-through</td><td>2026-09-06</td></tr>`,
      eventRows: "",
      commitmentRows: `<tr><td>Adam</td><td>file window</td><td>2026-01-01</td><td>overdue</td><td>Standup</td></tr>`,
      meetingRows: `<tr><td>2026-09-06</td><td>Standup</td><td>Adam</td><td>ops</td><td>Decided Friday</td></tr>`,
      health: {
        id: "latest",
        organizerId: "_system",
        lastRunAt: "2026-09-06T12:00:00.000Z",
        scanned: 4,
        ingested: 1,
        skipped: 2,
        matched: 1,
        errors: ["Graph 403: policy"],
      },
      signedIn: "Adam",
    });
    assert.match(html, /Organizers/);
    assert.match(html, />4</);
    assert.match(html, /file window/);
    assert.match(html, /Standup/);
    assert.match(html, /Watch ops follow-through/);
    assert.match(html, /Graph 403/);
    assert.doesNotMatch(html, /WEBVTT/);
  });
});
