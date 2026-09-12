import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasPlaudTranscript,
  parsePlaudTranscriptId,
  PlaudClient,
  plaudTranscriptId,
  recentPlaudFiles,
  renderPlaudTranscript,
  type PlaudTokenMap,
  type PlaudTokenStore,
} from "../src/meetings/plaud";

class MemoryTokenStore implements PlaudTokenStore {
  loads = 0;
  saves = 0;

  constructor(public tokens: PlaudTokenMap) {}

  async load(): Promise<PlaudTokenMap> {
    this.loads++;
    return structuredClone(this.tokens);
  }

  async save(tokens: PlaudTokenMap): Promise<void> {
    this.tokens = structuredClone(tokens);
    this.saves++;
  }
}

describe("Plaud metadata", () => {
  it("filters the 30-day window and recognizes transcript readiness", () => {
    const now = Date.parse("2026-09-11T12:00:00Z");
    const files = recentPlaudFiles(
      [
        { id: "new", created_at: "2026-09-01T12:00:00" },
        { id: "old", created_at: "2026-07-01T12:00:00Z" },
      ],
      30,
      now
    );
    assert.deepEqual(files.map((file) => file.id), ["new"]);
    assert.equal(
      hasPlaudTranscript({
        id: "new",
        source_list: [{ data_type: "transaction" }],
      }),
      true
    );
    assert.equal(hasPlaudTranscript({ id: "new", source_list: [] }), false);
  });

  it("round-trips source ids even when recording ids contain colons", () => {
    const id = plaudTranscriptId("owner", "recording:one");
    assert.equal(id, "plaud:owner:recording:one");
    assert.deepEqual(parsePlaudTranscriptId(id), {
      accountId: "owner",
      recordingId: "recording:one",
    });
    assert.equal(parsePlaudTranscriptId("teams-id"), undefined);
  });

  it("renders timestamped transcript JSON as speaker text", () => {
    const rendered = renderPlaudTranscript(
      JSON.stringify([
        { speaker: "Adam", content: "First item", start_time: 0 },
        { speaker: "Val", content: "Second item", start_time: 5000 },
      ])
    );
    assert.equal(rendered, "Adam: First item\nVal: Second item");
    assert.equal(renderPlaudTranscript("plain transcript"), "plain transcript");
  });
});

describe("Plaud OAuth client", () => {
  it("refreshes an expired token, persists rotation, and lists files", async () => {
    const store = new MemoryTokenStore({
      owner: {
        access_token: "expired",
        refresh_token: "refresh-old",
        expires_at: 0,
      },
    });
    const requests: string[] = [];
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/oauth/third-party/access-token/refresh")) {
        assert.equal(
          new URLSearchParams(String(init?.body)).get("refresh_token"),
          "refresh-old"
        );
        return Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        });
      }
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer access-new"
      );
      return Response.json({
        data: [{ id: "file-1", name: "Weekly review" }],
        page: 1,
      });
    }) as typeof fetch;

    const files = await new PlaudClient("owner", store, fetcher).listFiles();
    assert.equal(files[0]?.id, "file-1");
    assert.equal(store.tokens.owner?.refresh_token, "refresh-new");
    assert.equal(store.loads, 1);
    assert.equal(store.saves, 1);
    assert.equal(requests.length, 2);
  });

  it("downloads a transcript block without persisting its text", async () => {
    const store = new MemoryTokenStore({
      owner: {
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 3600_000,
      },
    });
    const fetcher = (async (
      input: string | URL | Request
    ): Promise<Response> => {
      const url = String(input);
      if (url === "https://signed.example/transcript") {
        return new Response(
          JSON.stringify([{ speaker: "Owner", content: "Ship it" }])
        );
      }
      return Response.json({
        id: "file-1",
        source_list: [
          {
            data_type: "transaction",
            data_link: "https://signed.example/transcript",
          },
        ],
      });
    }) as typeof fetch;

    const transcript = await new PlaudClient(
      "owner",
      store,
      fetcher
    ).getTranscript("file-1");
    assert.equal(transcript, "Owner: Ship it");
    assert.equal(store.saves, 0);
  });
});
