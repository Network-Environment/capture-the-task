import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchMyCalendar } from "../src/services/graphCalendar";

function event(
  id: string,
  subject: string,
  start: string,
  attendee: string,
  cancelled = false,
  organizer = "Requester"
) {
  return {
    id,
    subject,
    start: { dateTime: start, timeZone: "Central Standard Time" },
    end: { dateTime: start, timeZone: "Central Standard Time" },
    isCancelled: cancelled,
    attendees: [{ emailAddress: { name: attendee, address: `${attendee}@example.com` } }],
    organizer: { emailAddress: { name: organizer } },
  };
}

describe("requester calendar search", () => {
  it("pages, filters by resolved attendee, and returns newest events first", async () => {
    const requested: string[] = [];
    const pages = [
      {
        value: [
          event("old", "Project review", "2026-01-10T10:00:00", "Joe Smith"),
          event("other", "Other meeting", "2026-02-10T10:00:00", "Pat Jones"),
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page=2",
      },
      {
        value: [
          event("new", "Project review", "2026-08-10T10:00:00", "Requester", false, "Joe Smith"),
          event("cancelled", "Cancelled", "2026-09-01T10:00:00", "Joe Smith", true),
        ],
      },
    ];
    const fetchMock = async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(JSON.stringify(pages[requested.length - 1]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await searchMyCalendar(
      "token",
      { attendee: "Joe", limit: 2 },
      fetchMock as typeof fetch,
      async () => ({ names: ["joe smith"], addresses: [] })
    );

    assert.equal(requested.length, 2);
    assert.ok(result.indexOf("2026-08-10") < result.indexOf("2026-01-10"));
    assert.doesNotMatch(result, /Other meeting|Cancelled/);
    assert.match(requested[0], /\/me\/calendarView/);
  });

  it("returns a clarification result before Graph when a name is ambiguous", async () => {
    let fetched = false;
    const result = await searchMyCalendar(
      "token",
      { attendee: "Chris" },
      (async () => {
        fetched = true;
        throw new Error("should not fetch");
      }) as typeof fetch,
      async () => ({
        names: [],
        addresses: [],
        ambiguity: 'More than one active person matches "Chris": Chris A, Chris B',
      })
    );

    assert.equal(fetched, false);
    assert.match(result, /^CALENDAR_CLARIFICATION_REQUIRED:/);
  });
});
