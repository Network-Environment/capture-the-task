import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderCapabilities,
  renderIntegrations,
  renderJobs,
  renderMeetings,
  renderMemory,
  renderOverview,
  renderUsage,
  renderOrg,
  meetingCsrfScope,
  meetingCsrfToken,
  verifyMeetingCsrf,
  queryOf,
  renderExecutionGraph,
  readExecutionGraphApi,
  mutateExecutionGraphApi,
} from "../src/admin/dashboard";
import type { DayStats, UsageBreakdown } from "../src/services/activityLog";
import type { CommitmentDoc, MeetingDoc } from "../src/meetings/types";

const emptyStats: DayStats = {
  captures: 0,
  toolCalls: 0,
  jobRuns: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  byModel: {},
};

const emptyUsage: UsageBreakdown = {
  stats: emptyStats,
  byChannel: {},
  byOrigin: {},
  byInputMode: {},
  byTool: {},
  byUser: {},
  tokensByOrigin: {},
};

function responseRecorder(): {
  res: { send: (status: number, body?: unknown) => void; header: () => void };
  status: () => number | undefined;
} {
  let code: number | undefined;
  return {
    res: {
      send: (status) => {
        code = status;
      },
      header: () => {},
    },
    status: () => code,
  };
}

describe("admin portal", () => {
  it("renders the execution graph without destructive page refresh", () => {
    const prior = process.env.EXECUTION_GRAPH_ENABLED;
    const priorWrites = process.env.EXECUTION_GRAPH_WRITES_ENABLED;
    process.env.EXECUTION_GRAPH_ENABLED = "true";
    process.env.EXECUTION_GRAPH_WRITES_ENABLED = "false";
    try {
      const html = renderExecutionGraph("local");
      assert.match(html, /id="execution-graph"/);
      assert.match(html, /\/admin\/api\/graph/);
      assert.match(html, /\/admin\/assets\/graph\.js/);
      assert.match(html, /Accessible execution list/);
      assert.doesNotMatch(html, /http-equiv="refresh"/);
      assert.match(html, /id="graph-new-task" type="button" disabled/);
    } finally {
      if (prior === undefined) delete process.env.EXECUTION_GRAPH_ENABLED;
      else process.env.EXECUTION_GRAPH_ENABLED = prior;
      if (priorWrites === undefined) delete process.env.EXECUTION_GRAPH_WRITES_ENABLED;
      else process.env.EXECUTION_GRAPH_WRITES_ENABLED = priorWrites;
    }
  });

  it("protects graph APIs with Easy Auth, same-origin, and CSRF before data access", async () => {
    const priorWebsite = process.env.WEBSITE_INSTANCE_ID;
    const priorGraph = process.env.EXECUTION_GRAPH_ENABLED;
    const priorWrites = process.env.EXECUTION_GRAPH_WRITES_ENABLED;
    try {
      process.env.EXECUTION_GRAPH_ENABLED = "true";
      process.env.EXECUTION_GRAPH_WRITES_ENABLED = "true";
      process.env.WEBSITE_INSTANCE_ID = "production";
      const unauth = responseRecorder();
      await readExecutionGraphApi(
        {
          header: () => undefined,
          getQuery: () => "",
        } as never,
        unauth.res as never
      );
      assert.equal(unauth.status(), 401);

      delete process.env.WEBSITE_INSTANCE_ID;
      const crossOrigin = responseRecorder();
      await mutateExecutionGraphApi(
        {
          header: (name: string) =>
            name === "origin" ? "https://evil.example" : name === "host" ? "localhost" : undefined,
          body: {},
        } as never,
        crossOrigin.res as never
      );
      assert.equal(crossOrigin.status(), 403);

      const badCsrf = responseRecorder();
      await mutateExecutionGraphApi(
        { header: () => undefined, body: { scope: "graph:mutate", csrf: "bad" } } as never,
        badCsrf.res as never
      );
      assert.equal(badCsrf.status(), 403);
    } finally {
      if (priorWebsite === undefined) delete process.env.WEBSITE_INSTANCE_ID;
      else process.env.WEBSITE_INSTANCE_ID = priorWebsite;
      if (priorGraph === undefined) delete process.env.EXECUTION_GRAPH_ENABLED;
      else process.env.EXECUTION_GRAPH_ENABLED = priorGraph;
      if (priorWrites === undefined) delete process.env.EXECUTION_GRAPH_WRITES_ENABLED;
      else process.env.EXECUTION_GRAPH_WRITES_ENABLED = priorWrites;
    }
  });

  it("overview has a sidebar and does not dump recent meetings", () => {
    const html = renderOverview({
      stats: emptyStats,
      events: [],
      signedIn: "local",
      today: "2026-09-07",
    });
    assert.match(html, /href="\/admin\/capabilities"/);
    assert.match(html, /href="\/admin\/integrations"/);
    assert.match(html, /href="\/admin\/usage"/);
    assert.match(html, /href="\/admin\/graph"/);
    assert.match(html, /href="\/admin\/org"/);
    assert.match(html, /0 people, 0 teams/);
    assert.match(html, /TaskBrain ops/);
    assert.match(html, /No discovery run yet/);
    assert.doesNotMatch(html, /No meetings in the 90-day index yet/);
    assert.doesNotMatch(html, /No commitments ingested yet/);
  });

  it("capabilities lists a profile and a native tool", () => {
    const skills = renderCapabilities("local", "skills");
    assert.match(skills, /pmo/);
    assert.match(skills, /Skills/);
    const tools = renderCapabilities("local", "tools", [
      { name: "smartsheet__search", description: "Search sheets" },
      { name: "smartsheet__update_rows", description: "Update rows" },
      { name: "browser__navigate", description: "Open URL", status: "down" },
    ]);
    assert.match(tools, /save_note/);
    assert.match(tools, /lookup_org/);
    assert.match(tools, /web_search/);
    assert.match(tools, /smartsheet__search/);
    assert.match(tools, /browser__navigate/);
    assert.match(tools, />down</);
    assert.match(tools, /approval required/);
  });

  it("reads ?tab= from the raw query string restify hands over", () => {
    // Without the queryParser plugin restify passes the raw string, so reading
    // `.tab` off req.query returned undefined and every tab link was a no-op.
    assert.equal(queryOf({ getQuery: () => "tab=tools" }).get("tab"), "tools");
    assert.equal(queryOf({ getQuery: () => "tab=catalog" }).get("tab"), "catalog");
    assert.equal(queryOf({ getQuery: () => "" }).get("tab"), null);
    assert.equal(
      queryOf({ getQuery: () => "notice=saved&tab=tools" }).get("notice"),
      "saved"
    );
  });

  it("an unreachable server still lists its tools, and a timeout reads as such", () => {
    const tools = renderCapabilities("local", "tools", [
      { name: "browser__navigate", description: "Open URL", status: "timeout" },
      { name: "browser__snapshot", description: "Read page", status: "timeout" },
    ]);
    assert.match(tools, /browser__navigate/);
    assert.match(tools, /browser__snapshot/);
    assert.match(tools, />timeout</);
    assert.doesNotMatch(tools, />down</);

    const html = renderIntegrations("local", "status", undefined, [
      {
        name: "browser",
        enabled: true,
        url: "https://browser.example/mcp",
        authEnv: "BROWSER_MCP_TOKEN",
        tokenPresent: true,
        connected: false,
        toolCount: 0,
        error: "browser did not answer within 10000ms",
        timedOut: true,
      },
    ]);
    assert.match(html, />timeout</);
    assert.doesNotMatch(html, />down</);
  });

  it("integrations status shows Smartsheet token empty without printing a secret", () => {
    delete process.env.SMARTSHEET_API_TOKEN;
    const html = renderIntegrations(
      "local",
      "status",
      undefined,
      [
        {
          name: "smartsheet",
          enabled: true,
          url: "https://mcp.smartsheet.com",
          authEnv: "SMARTSHEET_API_TOKEN",
          tokenPresent: false,
          connected: false,
          toolCount: 0,
          error: "connect failed",
        },
        {
          name: "browser",
          enabled: true,
          url: "https://browser.example/mcp",
          authEnv: "BROWSER_MCP_TOKEN",
          tokenPresent: true,
          connected: true,
          toolCount: 2,
        },
      ]
    );
    assert.match(html, /smartsheet/);
    assert.match(html, /browser/);
    assert.match(html, /navigate, snapshot/);
    assert.match(html, />connected</);
    assert.match(html, /token empty/);
    assert.match(html, /Web search/);
    assert.doesNotMatch(html, /Bearer /);
    const catalog = renderIntegrations("local", "catalog");
    assert.match(catalog, /authEnv/);
    assert.match(catalog, /SMARTSHEET_API_TOKEN/);
    assert.match(catalog, />browser</);
    assert.match(catalog, /BROWSER_MCP_TOKEN/);
    assert.match(catalog, /env:BROWSER_MCP_URL/);
    assert.doesNotMatch(catalog, /\+1/);
  });

  it("meetings empty states and ingest health stay on the meetings section", () => {
    const empty = renderMeetings("local");
    assert.match(empty, /No discovery run yet/);
    assert.match(empty, /No commitments ingested yet/);
    assert.match(empty, /No meetings in the 90-day index yet/);
    assert.match(empty, /No transcripts discovered in the last 30 days/);

    const html = renderMeetings(
      "Adam",
      {
        id: "latest",
        organizerId: "_system",
        lastRunAt: "2026-09-06T12:00:00.000Z",
        scanned: 4,
        ingested: 1,
        skipped: 2,
        matched: 1,
        errors: ["Graph 403: policy"],
      },
      [
        {
          id: "m1",
          organizerId: "o",
          organizerName: "Adam",
          transcriptId: "t",
          title: "Standup",
          categories: ["ops"],
          summary: "Decided Friday",
          decisions: [],
          actions: [],
          risks: [],
          openQuestions: [],
          attendees: [],
          path: "x",
          createdAt: "2026-09-06T12:00:00.000Z",
          embedding: [],
        } satisfies MeetingDoc,
      ],
      [
        {
          id: "c1",
          ownerKey: "adam",
          ownerName: "Adam",
          text: "file window",
          due: "2026-01-01",
          status: "open",
          sourceMeetingId: "m1",
          sourceTitle: "Standup",
          createdAt: "2026-09-06T12:00:00.000Z",
          updatedAt: "2026-09-06T12:00:00.000Z",
        } satisfies CommitmentDoc,
      ],
      [
        {
          id: "tx1",
          organizerId: "o",
          organizerName: "Adam",
          transcriptId: "tx1",
          meetingId: "meeting1",
          titleHint: "Budget review",
          createdDateTime: "2026-09-06T12:00:00.000Z",
          discoveredAt: "2026-09-06T12:05:00.000Z",
          updatedAt: "2026-09-06T12:05:00.000Z",
          status: "available",
        },
      ],
      "queued-1"
    );
    assert.match(html, /Organizers/);
    assert.match(html, />4</);
    assert.match(html, /file window/);
    assert.match(html, /Standup/);
    assert.match(html, /Graph 403/);
    assert.match(html, /Budget review/);
    assert.match(html, /Summarize selected/);
    assert.match(html, /action="\/admin\/meetings\/summarize"/);
    assert.match(html, /name="_csrf"/);
    assert.match(html, /1 transcript\(s\)/);
    assert.doesNotMatch(html, /Summarize all/);
    assert.doesNotMatch(html, /WEBVTT/);
  });

  it("meeting CSRF token is bound to the displayed transcript scope", () => {
    const scope = meetingCsrfScope(["o::tx1", "o::tx2"]);
    const token = meetingCsrfToken(scope);
    assert.equal(verifyMeetingCsrf(token, scope), true);
    assert.equal(verifyMeetingCsrf(token, meetingCsrfScope(["o::tx1"])), false);
  });

  it("jobs, memory, and usage empty states render", () => {
    assert.match(renderJobs("local", []), /No jobs scheduled/);
    const mem = renderMemory("local", [
      { userId: "org", kind: "self", text: "Watch ops follow-through", createdAt: "2026-09-06" },
    ]);
    assert.match(mem, /Watch ops follow-through/);
    assert.match(mem, /No lessons learned yet/);
    const usage = renderUsage("local", emptyUsage, []);
    assert.match(usage, /No model calls yet today/);
    assert.match(usage, /Activity by origin/);
    assert.match(usage, /Captures by input mode/);
    assert.match(usage, /Recent events/);
  });

  it("org people tab has CSRF-bound save form and no bulk-delete", () => {
    const html = renderOrg("local", "people", {
      units: [],
      people: [
        {
          id: "per-val",
          kind: "person",
          displayName: "Valerie Moraru",
          aliases: ["Val"],
          mandate: "Keep the register honest",
          status: "active",
          createdAt: "2026-09-08T00:00:00Z",
          updatedAt: "2026-09-08T00:00:00Z",
        },
      ],
      roles: [],
    });
    assert.match(html, /href="\/admin\/org\?tab=teams"/);
    assert.match(html, /href="\/admin\/org\?tab=roles"/);
    assert.match(html, /action="\/admin\/org"/);
    assert.match(html, /name="_csrf"/);
    assert.match(html, /Valerie Moraru/);
    assert.match(html, /Save person/);
    assert.match(html, /Archive/);
    assert.doesNotMatch(html, /Delete all/);
    const teams = renderOrg("local", "teams", { units: [], people: [], roles: [] });
    assert.match(teams, /Save team/);
    const roles = renderOrg("local", "roles", { units: [], people: [], roles: [] });
    assert.match(roles, /Save role/);
    const scope = meetingCsrfScope(["org:people", "per-val"]);
    assert.equal(verifyMeetingCsrf(meetingCsrfToken(scope), scope), true);
  });
});
