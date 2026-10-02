import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMailDraft, searchMyMail, searchSharedMail, validEmail } from "../src/services/graphMailbox";
import { fileHitsFromSearch, formatFileHits } from "../src/services/graphFiles";
import { createCalendarEvent } from "../src/services/graphCalendar";

describe("requester Microsoft 365 actions", () => {
  it("searches only the signed-in mailbox and keeps the message id", async () => {
    const result = await searchMyMail(
      "token",
      "commissioning",
      5,
      (async () =>
        new Response(
          JSON.stringify({
            value: [
              {
                id: "msg-1",
                subject: "Commissioning",
                receivedDateTime: "2026-09-01T12:00:00Z",
                bodyPreview: "Follow up Friday",
                from: { emailAddress: { name: "Morgan" } },
              },
            ],
          }),
          { status: 200 }
        )) as typeof fetch
    );
    assert.match(result, /Id: msg-1/);
    assert.match(result, /Morgan/);
    assert.equal(validEmail("pat@example.com"), true);
    assert.equal(validEmail("not an email"), false);
  });

  it("searches only the configured shared mailbox", async () => {
    const prior = process.env.SHARED_MAILBOX;
    process.env.SHARED_MAILBOX = "jjrmac@netenv.com";
    const urls: string[] = [];
    try {
      const result = await searchSharedMail(
        "token",
        "commissioning",
        5,
        (async (url: string | URL | Request) => {
          urls.push(String(url));
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }) as typeof fetch
      );
      assert.match(result, /jjrmac@netenv.com/);
      assert.equal(urls.length, 1);
      assert.match(urls[0], /\/users\/jjrmac%40netenv.com\/messages/);
      assert.doesNotMatch(urls[0], /\/me\/messages/);
    } finally {
      if (prior === undefined) delete process.env.SHARED_MAILBOX;
      else process.env.SHARED_MAILBOX = prior;
    }
  });

  it("creates a draft and does not call send", async () => {
    const urls: string[] = [];
    const result = await createMailDraft(
      "token",
      { to: "pat@example.com", subject: "Friday", body: "See you then." },
      (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ id: "draft-9" }), { status: 201 });
      }) as typeof fetch
    );
    assert.match(result, /has not been sent/);
    assert.match(result, /draft-9/);
    assert.equal(urls.some((url) => url.endsWith("/send")), false);
  });

  it("creates a calendar event on /me/events", async () => {
    let body = "";
    const result = await createCalendarEvent(
      "token",
      { subject: "Review", start: "2026-10-02T09:00:00", end: "2026-10-02T09:30:00", attendees: "a@example.com" },
      (async (_url: string | URL | Request, init?: RequestInit) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: "evt-1" }), { status: 201 });
      }) as typeof fetch
    );
    assert.match(result, /evt-1/);
    assert.match(body, /Central Standard Time/);
    assert.match(body, /a@example.com/);
  });

  it("keeps drive and item ids from a file search", () => {
    const text = formatFileHits(
      fileHitsFromSearch({
        value: [
          {
            hitsContainers: [
              {
                hits: [
                  {
                    resource: {
                      id: "item-1",
                      name: "notes.txt",
                      parentReference: { driveId: "drive-1" },
                      webUrl: "https://example.sharepoint.com/notes",
                    },
                  },
                ],
              },
            ],
          },
        ],
      })
    );
    assert.match(text, /Id: item-1/);
    assert.match(text, /Drive: drive-1/);
  });
});
