import { randomUUID } from "node:crypto";
import express from "express";
import { chromium, type Browser, type Page } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assertPublicHttpUrl } from "./ssrf.js";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.MCP_TOKEN?.trim() ?? "";
const NAV_TIMEOUT_MS = 20_000;
const SNAPSHOT_MAX = 8_000;

let browser: Browser | undefined;
let page: Page | undefined;

async function chromePage(): Promise<Page> {
  browser ??= await chromium.launch({ headless: true });
  if (!page || page.isClosed()) {
    const ctx = await browser.newContext({
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
    });
    page = await ctx.newPage();
  }
  return page;
}

function flattenA11y(node: unknown, lines: string[] = []): string[] {
  if (!node || typeof node !== "object") return lines;
  const n = node as { role?: string; name?: string; children?: unknown[] };
  const role = n.role ?? "unknown";
  const name = (n.name ?? "").replace(/\s+/g, " ").trim();
  if (name) lines.push(`${role}: ${name}`);
  for (const c of n.children ?? []) flattenA11y(c, lines);
  return lines;
}

function truncate(text: string): string {
  if (text.length <= SNAPSHOT_MAX) return text;
  return `${text.slice(0, SNAPSHOT_MAX)}\n…[truncated ${text.length - SNAPSHOT_MAX} chars]`;
}

function createMcp(): McpServer {
  const server = new McpServer({ name: "taskbrain-browser", version: "0.1.0" });
  server.tool(
    "navigate",
    "Open a public http(s) URL in headless Chromium. No login, click, or download.",
    { url: z.string() },
    async ({ url }) => {
      const href = assertPublicHttpUrl(url);
      const p = await chromePage();
      const res = await p.goto(href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      const title = await p.title();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              url: p.url(),
              title,
              status: res?.status() ?? null,
            }),
          },
        ],
      };
    }
  );
  server.tool(
    "snapshot",
    "Accessibility text of the current page. Not a screenshot. Truncated.",
    { dummy: z.string().optional() },
    async () => {
      const p = page;
      if (!p || p.isClosed()) {
        return { content: [{ type: "text" as const, text: "No page open. Call navigate first." }] };
      }
      const snap = await p.accessibility.snapshot({ interestingOnly: true });
      const lines = flattenA11y(snap);
      const body = [`url: ${p.url()}`, `title: ${await p.title()}`, ...lines].join("\n");
      return { content: [{ type: "text" as const, text: truncate(body) }] };
    }
  );
  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

app.use("/mcp", (req, res, next) => {
  if (!TOKEN) {
    res.status(503).json({ error: "MCP_TOKEN unset" });
    return;
  }
  const hdr = req.header("authorization") ?? "";
  if (hdr !== `Bearer ${TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  try {
    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (transport) transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id) transports.delete(id);
      };
      const mcp = createMcp();
      await mcp.connect(transport);
    } else {
      res.status(400).json({ error: "Bad or missing MCP session" });
      return;
    }
    await transport!.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error).message.slice(0, 180) });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).end();
    return;
  }
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`browser mcp on :${PORT}`);
});
