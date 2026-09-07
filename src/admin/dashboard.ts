/**
 * Admin portal — server-rendered HTML, zero frontend build.
 * Sidebar sections: overview, capabilities, integrations, usage, meetings, jobs, memory.
 *
 * In Azure, App Service Easy Auth (Entra) gates /admin*. Locally the page is open.
 */
import { Request, Response } from "restify";
import { dayStats, recentEvents, usageBreakdown, type DayStats, type UsageBreakdown } from "../services/activityLog";
import { CosmosClient } from "@azure/cosmos";
import { listCommitmentsForDash, readHealth, recentMeetings } from "../meetings/store";
import type { CommitmentDoc, IngestHealthDoc, MeetingDoc } from "../meetings/types";
import { loadConfig } from "../config";
import { nativeToolCatalog } from "../tools/registry";
import { mcpServerCatalog, mcpServerHealth, mcpToolDefinitions, type McpServerHealth } from "../tools/mcpClient";
import { catalogSheets } from "../services/smartsheet";
import { requiresApproval } from "../services/approvals";
import { imessageEnabled } from "../channels/types";
import {
  countTable,
  esc,
  isSection,
  pill,
  renderShell,
  table,
  tabs,
  type SectionId,
  type Tone,
} from "./markup";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const db = cosmos.database(process.env.COSMOS_DB ?? "taskbrain");

const agentsConfig = loadConfig<{
  default: string;
  profiles: Record<string, { description?: string; route?: string; tools?: string | string[]; persona?: string }>;
}>("agents");
const channelsConfig = loadConfig<{
  imessage: { enabled: boolean; allowActions: boolean; identities?: Record<string, string> };
}>("channels");

export async function adminPage(req: Request, res: Response): Promise<void> {
  const principal = easyAuthPrincipal(req);
  if (process.env.WEBSITE_INSTANCE_ID && !principal) {
    res.send(401, "sign in required");
    return;
  }

  const raw = String(req.params.section ?? "overview").toLowerCase();
  const signedIn = principal?.name ?? "local";
  const tab = String((req.query as { tab?: string }).tab ?? "");

  if (raw !== "overview" && !isSection(raw)) {
    res.sendRaw(404, renderShell({
      section: "overview",
      signedIn,
      title: "Not found",
      subtitle: "unknown section",
      body: "",
      notFound: true,
    }), { "Content-Type": "text/html" });
    return;
  }

  const section: SectionId = isSection(raw) ? raw : "overview";
  const html = await renderSection(section, signedIn, tab);
  res.sendRaw(200, html, { "Content-Type": "text/html" });
}

async function renderSection(section: SectionId, signedIn: string, tab: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  switch (section) {
    case "overview": {
      const [stats, events, health] = await Promise.all([
        dayStats(),
        recentEvents(12),
        readHealth().catch(() => undefined),
      ]);
      return renderOverview({ stats, events, health, signedIn, today });
    }
    case "capabilities": {
      let mcp: { name: string; description: string }[] = [];
      if (tab === "tools") {
        try {
          const defs = await mcpToolDefinitions();
          mcp = defs.map((t) => ({ name: t.function.name, description: t.function.description ?? "" }));
        } catch {
          mcp = [];
        }
      }
      return renderCapabilities(signedIn, tab === "tools" ? "tools" : "skills", mcp);
    }
    case "integrations": {
      const [health, mcp] = await Promise.all([
        readHealth().catch(() => undefined),
        mcpServerHealth().catch(() => [] as McpServerHealth[]),
      ]);
      return renderIntegrations(signedIn, tab === "catalog" ? "catalog" : "status", health, mcp);
    }
    case "usage": {
      const [usage, events] = await Promise.all([usageBreakdown(), recentEvents(80)]);
      return renderUsage(signedIn, usage, events);
    }
    case "meetings": {
      const [health, meetings, commitments] = await Promise.all([
        readHealth().catch(() => undefined),
        recentMeetings(20).catch(() => [] as MeetingDoc[]),
        listCommitmentsForDash(40).catch(() => [] as CommitmentDoc[]),
      ]);
      return renderMeetings(signedIn, health, meetings, commitments);
    }
    case "jobs": {
      const jobs = await db.container("jobs").items.query("SELECT * FROM c ORDER BY c.nextRun").fetchAll();
      return renderJobs(signedIn, jobs.resources as Record<string, unknown>[]);
    }
    case "memory": {
      const lessons = await db
        .container("agent-memory")
        .items.query("SELECT * FROM c ORDER BY c.createdAt DESC")
        .fetchAll();
      return renderMemory(signedIn, lessons.resources as Record<string, unknown>[]);
    }
  }
}

function kpiGrid(stats: DayStats): string {
  return `<div class="grid">
    <div class="stat"><div class="label">Captures</div><div class="value">${stats.captures.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Tool calls</div><div class="value">${stats.toolCalls.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Job runs</div><div class="value">${stats.jobRuns.toLocaleString()}</div></div>
    <div class="stat${stats.errors > 0 ? " alert" : ""}"><div class="label">Errors</div><div class="value">${stats.errors.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Tokens in</div><div class="value">${stats.inputTokens.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Tokens out</div><div class="value">${stats.outputTokens.toLocaleString()}</div></div>
  </div>`;
}

function budgetBlock(totalTokens: number): string {
  const budget = Number(process.env.DAILY_TOKEN_BUDGET ?? 0);
  if (!(budget > 0)) return "";
  const pct = Math.min(100, (totalTokens / budget) * 100);
  const budgetTone = pct >= 100 ? "err" : pct >= 75 ? "warn" : "ok";
  return `<section class="panel budget">
      <div class="budget-head">
        <div>
          <h2>Daily token budget</h2>
          <p class="muted">Past the cap, non-triage calls drop to the cheap tier until midnight UTC.</p>
        </div>
        <div class="budget-num">
          <span class="mono strong">${totalTokens.toLocaleString()}</span>
          <span class="muted mono">/ ${budget.toLocaleString()}</span>
        </div>
      </div>
      <div class="bar lg ${budgetTone}"><i style="width:${pct.toFixed(2)}%"></i></div>
    </section>`;
}

function eventRowsHtml(events: Record<string, unknown>[]): string {
  return events
    .map((e) => {
      const type = String(e.type);
      return (
        `<tr><td class="mono muted">${String(e.at).slice(11, 19)}</td>` +
        `<td>${pill(type, eventTone(type))}</td>` +
        `<td class="muted">${esc(String(e.agent ?? "—"))}</td>` +
        `<td class="mono muted clip">${esc(JSON.stringify(e.detail ?? {}).slice(0, 160))}</td></tr>`
      );
    })
    .join("");
}

export function renderOverview(d: {
  stats: DayStats;
  events: Record<string, unknown>[];
  health?: IngestHealthDoc;
  signedIn: string;
  today: string;
}): string {
  const totalTokens = d.stats.inputTokens + d.stats.outputTokens;
  const h = d.health;
  const ingest = h
    ? `<section class="panel">
        <h2>Meeting ingest</h2>
        <div class="grid" style="margin:1rem 1.15rem">
          <div class="stat"><div class="label">Last run</div><div class="value" style="font-size:1rem">${esc(h.lastRunAt.slice(0, 19).replace("T", " "))}Z</div></div>
          <div class="stat${h.errors.length ? " alert" : ""}"><div class="label">Errors</div><div class="value">${h.errors.length}</div></div>
          <div class="stat"><div class="label">Ingested</div><div class="value">${h.ingested}</div></div>
        </div>
        <p class="pad muted">Full transcript index and commitments live under <a href="/admin/meetings">Meetings</a>.</p>
      </section>`
    : `<section class="panel"><h2>Meeting ingest</h2><p class="muted pad">No ingest run yet. After Graph/Teams policy is granted, the Function polls every 5 minutes.</p></section>`;

  const body = `
  <p class="lede">TaskBrain ops — capabilities, health, usage. What the agent can do, how it is performing today, which tools are live, and how people are using it.</p>
  ${kpiGrid(d.stats)}
  ${budgetBlock(totalTokens)}
  ${ingest}
  <section class="panel">
    <h2>Latest events</h2>
    ${table(["Time", "Type", "Agent", "Detail"], eventRowsHtml(d.events), "No events yet.")}
  </section>`;

  return renderShell({
    section: "overview",
    signedIn: d.signedIn,
    title: "Overview",
    subtitle: `${d.today} · today's activity`,
    body,
  });
}

export function renderCapabilities(
  signedIn: string,
  tab: "skills" | "tools",
  mcpTools: { name: string; description: string }[] = []
): string {
  const tabBar = tabs("/admin/capabilities", [
    { id: "skills", label: "Skills" },
    { id: "tools", label: "Tools" },
  ], tab);

  let inner: string;
  if (tab === "skills") {
    const cards = Object.entries(agentsConfig.profiles)
      .map(([name, p]) => {
        const allow = p.tools === "*" ? ["*"] : Array.isArray(p.tools) ? p.tools : [];
        return `<article class="card">
          <h3>${esc(name)}${agentsConfig.default === name ? ` ${pill("default", "accent")}` : ""}</h3>
          <p>${esc(p.description ?? "")}</p>
          <div class="meta">${pill(`route ${p.route ?? "—"}`, "info")} ${allow.map((t) => pill(t, "idle")).join(" ")}</div>
        </article>`;
      })
      .join("");
    inner = `<p class="lede">Capture, recall, PMO/Smartsheet, meeting follow-through, Microsoft To Do, and scheduled jobs. Personas below are the agent skills; the Tools tab is the callable surface.</p>
      <div class="cards">${cards}</div>`;
  } else {
    const native = nativeToolCatalog()
      .map(
        (t) =>
          `<tr><td class="mono strong">${esc(t.name)}</td><td>${pill("native", "info")}</td><td>${pill("open", "ok")}</td><td class="muted">${esc(t.description)}</td></tr>`
      )
      .join("");
    const mcpRows = mcpTools
      .map((t) => {
        const gate = requiresApproval(t.name) ? pill("approval required", "warn") : pill("read", "ok");
        return `<tr><td class="mono strong">${esc(t.name)}</td><td>${pill("mcp", "accent")}</td><td>${gate}</td><td class="muted">${esc(t.description)}</td></tr>`;
      })
      .join("");
    inner = `<p class="lede">Native tools always ship with the bot. MCP tools appear when the server connects. Writes listed in confirmTools park until approve pa-x.</p>
      <section class="panel"><h2>Tool catalog</h2>${table(
        ["Name", "Kind", "Gate", "Description"],
        native + mcpRows,
        "No tools registered."
      )}</section>`;
  }

  return renderShell({
    section: "capabilities",
    signedIn,
    title: "Capabilities",
    subtitle: "what the agent can do",
    body: tabBar + inner,
  });
}

export function renderIntegrations(
  signedIn: string,
  tab: "status" | "catalog",
  health?: IngestHealthDoc,
  mcp: McpServerHealth[] = []
): string {
  const tabBar = tabs("/admin/integrations", [
    { id: "status", label: "Status" },
    { id: "catalog", label: "Catalog" },
  ], tab);

  const foundry = !!process.env.FOUNDRY_ENDPOINT && !!process.env.FOUNDRY_API_KEY;
  const speech = !!process.env.SPEECH_KEY && !!process.env.SPEECH_REGION;
  const graph = !!process.env.GRAPH_CONNECTION_NAME;
  const photon = imessageEnabled();
  const sheetAliases = catalogSheets().length;

  let inner: string;
  if (tab === "status") {
    const mcpRows = mcp
      .map((s) => {
        const tone: Tone = !s.enabled ? "idle" : s.connected ? "ok" : "err";
        const label = !s.enabled ? "disabled" : s.connected ? "connected" : "down";
        const token = s.authEnv ? (s.tokenPresent ? pill("token set", "ok") : pill("token empty", "err")) : pill("no auth", "idle");
        return `<tr><td class="strong">${esc(s.name)}</td><td>${pill(label, tone)}</td><td>${token}</td><td class="num">${s.toolCount}</td><td class="muted clip">${esc(s.error ?? "—")}</td></tr>`;
      })
      .join("");
    const ingestTone: Tone = !health ? "warn" : health.errors.length ? "err" : "ok";
    const ingestLabel = !health ? "not ready" : health.errors.length ? "errors" : "ready";
    const ingestNote = !health
      ? "no run yet"
      : health.errors.length
        ? `${health.errors.length} error(s) on last run`
        : `last ${health.lastRunAt.slice(0, 16)}Z`;
    const platform: { name: string; label: string; tone: Tone; note: string }[] = [
      { name: "Microsoft Foundry", label: foundry ? "ready" : "not ready", tone: foundry ? "ok" : "warn", note: "Chat + embeddings" },
      { name: "Azure Speech", label: speech ? "ready" : "not ready", tone: speech ? "ok" : "warn", note: "Voice memos" },
      { name: "Graph To Do", label: graph ? "ready" : "not ready", tone: graph ? "ok" : "warn", note: "Task create from Teams" },
      { name: "iMessage (Photon)", label: photon ? "ready" : "not ready", tone: photon ? "ok" : "warn", note: "Spectrum stream" },
      { name: "Meeting ingest", label: ingestLabel, tone: ingestTone, note: ingestNote },
      { name: "Smartsheet catalog", label: sheetAliases > 0 ? "ready" : "not ready", tone: sheetAliases > 0 ? "ok" : "warn", note: `${sheetAliases} alias(es)` },
    ];
    const statusRows = platform
      .map(
        (r) =>
          `<tr><td class="strong">${esc(r.name)}</td><td>${pill(r.label, r.tone)}</td><td class="muted">${esc(r.note)}</td></tr>`
      )
      .join("");
    inner = `<p class="lede">Live wiring. Secrets are never shown — only whether they are present and whether MCP answered.</p>
      <section class="panel"><h2>Platform</h2>${table(["Integration", "Status", "Note"], statusRows, "—")}</section>
      <section class="panel"><h2>MCP servers</h2>${table(
        ["Server", "Link", "Auth", "<span class='num'>Tools</span>", "Error"],
        mcpRows,
        "No MCP servers in config."
      )}</section>`;
  } else {
    const servers = mcpServerCatalog()
      .map((s) => {
        const allow = (s.allowTools ?? []).map((t) => pill(t, "info")).join(" ") || pill("all", "idle");
        const confirm = (s.confirmTools ?? []).map((t) => pill(t, "warn")).join(" ") || '<span class="muted">none</span>';
        return `<tr><td class="strong">${esc(s.name)}</td><td class="mono muted clip">${esc(s.url)}</td><td class="mono">${esc(s.authEnv ?? "—")}</td><td>${allow}</td><td>${confirm}</td></tr>`;
      })
      .join("");
    const idCount = Object.keys(channelsConfig.imessage.identities ?? {}).length;
    const ch = `<tr><td class="strong">iMessage</td><td>${pill(channelsConfig.imessage.enabled ? "enabled" : "off", channelsConfig.imessage.enabled ? "ok" : "idle")}</td><td>${pill(channelsConfig.imessage.allowActions ? "actions on" : "capture only", "accent")}</td><td>${idCount} mapped identities</td></tr>
      <tr><td class="strong">Teams</td><td>${pill("enabled", "ok")}</td><td>${pill("actions on", "accent")}</td><td>Bot Framework</td></tr>`;
    inner = `<p class="lede">Declared integrations from config. Phone numbers are not listed.</p>
      <section class="panel"><h2>MCP catalog</h2>${table(["Name", "URL", "authEnv", "Allow", "Confirm writes"], servers, "None.")}</section>
      <section class="panel"><h2>Channels</h2>${table(["Channel", "State", "Policy", "Notes"], ch, "—")}</section>`;
  }

  return renderShell({
    section: "integrations",
    signedIn,
    title: "Integrations",
    subtitle: "tools and connections",
    body: tabBar + inner,
  });
}

export function renderUsage(
  signedIn: string,
  usage: UsageBreakdown,
  events: Record<string, unknown>[]
): string {
  const { stats } = usage;
  const totalTokens = stats.inputTokens + stats.outputTokens;
  const modelRows = Object.entries(stats.byModel)
    .sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens))
    .map(([m, s]) => {
      const used = s.inputTokens + s.outputTokens;
      const share = totalTokens > 0 ? (used / totalTokens) * 100 : 0;
      return (
        `<tr><td><span class="mono strong">${esc(m)}</span></td>` +
        `<td class="num">${s.calls.toLocaleString()}</td>` +
        `<td class="num">${s.inputTokens.toLocaleString()}</td>` +
        `<td class="num">${s.outputTokens.toLocaleString()}</td>` +
        `<td class="share"><div class="bar"><i style="width:${share.toFixed(1)}%"></i></div>` +
        `<span class="muted num">${share.toFixed(0)}%</span></td></tr>`
      );
    })
    .join("");

  const peopleRows = Object.entries(usage.byUser)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => {
      const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;
      return `<tr><td class="mono">${esc(short)}</td><td class="num">${n.toLocaleString()}</td></tr>`;
    })
    .join("");

  const body = `
  <p class="lede">How people used the bot today — channels, tools, models, and unique users (ids truncated).</p>
  ${kpiGrid(stats)}
  ${budgetBlock(totalTokens)}
  <section class="panel">
    <h2>Model usage</h2>
    ${table(
      ["Model", "<span class='num'>Calls</span>", "<span class='num'>Input</span>", "<span class='num'>Output</span>", "Share"],
      modelRows,
      "No model calls yet today."
    )}
  </section>
  ${countTable("Captures by channel", usage.byChannel, "No captures today.")}
  ${countTable("Captures by source", usage.bySource, "No captures today.")}
  ${countTable("Tool calls", usage.byTool, "No tool calls today.")}
  <section class="panel"><h2>People (truncated id)</h2>${table(["User", "<span class='num'>Events</span>"], peopleRows, "No user-tagged events today.")}</section>
  <section class="panel">
    <h2>Recent events</h2>
    ${table(["Time", "Type", "Agent", "Detail"], eventRowsHtml(events), "No events yet.")}
  </section>`;

  return renderShell({
    section: "usage",
    signedIn,
    title: "Usage",
    subtitle: "how people are using it",
    body,
  });
}

export function renderMeetings(
  signedIn: string,
  health?: IngestHealthDoc,
  meetings: MeetingDoc[] = [],
  commitments: CommitmentDoc[] = []
): string {
  const commitmentRows = [...commitments]
    .sort((a, b) => {
      const ao = a.status === "open" && a.due && Date.parse(a.due) < Date.now() ? 0 : 1;
      const bo = b.status === "open" && b.due && Date.parse(b.due) < Date.now() ? 0 : 1;
      return ao - bo;
    })
    .map((c) => {
      const overdue = c.status === "open" && c.due && Date.parse(c.due) < Date.now();
      const tone: Tone = c.status === "done" ? "ok" : overdue ? "err" : c.status === "open" ? "warn" : "idle";
      return (
        `<tr><td class="strong">${esc(c.ownerName)}</td>` +
        `<td>${esc(c.text)}</td>` +
        `<td class="mono muted">${esc(c.due ?? "—")}</td>` +
        `<td>${pill(overdue ? "overdue" : c.status, tone)}</td>` +
        `<td class="muted clip">${esc(c.sourceTitle)}</td></tr>`
      );
    })
    .join("");

  const meetingRows = meetings
    .map(
      (m) =>
        `<tr><td class="mono muted">${esc((m.startAt ?? m.createdAt).slice(0, 10))}</td>` +
        `<td class="strong">${esc(m.title)}</td>` +
        `<td class="muted">${esc(m.organizerName ?? m.organizerId)}</td>` +
        `<td>${(m.categories ?? []).slice(0, 3).map((t) => pill(t, "accent")).join(" ")}</td>` +
        `<td class="muted clip">${esc(m.summary)}</td></tr>`
    )
    .join("");

  const body = `${ingestHealthPanel(health)}
  <section class="panel">
    <h2>Open / overdue commitments</h2>
    ${table(["Owner", "Commitment", "Due", "Status", "From"], commitmentRows, "No commitments ingested yet.")}
  </section>
  <section class="panel">
    <h2>Recent meetings</h2>
    ${table(["Date", "Title", "Organizer", "Tags", "Summary"], meetingRows, "No meetings in the 90-day index yet.")}
  </section>`;

  return renderShell({
    section: "meetings",
    signedIn,
    title: "Meetings",
    subtitle: "ingest and follow-through",
    body,
  });
}

export function renderJobs(signedIn: string, jobs: Record<string, unknown>[]): string {
  const jobRows = jobs
    .map((j) => {
      const status = String(j.lastStatus ?? "");
      return (
        `<tr><td class="strong">${esc(String(j.name))}</td>` +
        `<td><span class="mono muted">${esc(String(j.cron ?? "one-off"))}</span></td>` +
        `<td><span class="mono muted">${esc(String(j.nextRun ?? "—"))}</span></td>` +
        `<td>${j.enabled ? pill("on", "ok") : pill("paused", "idle")}</td>` +
        `<td>${status ? pill(status, statusTone(status)) : '<span class="muted">—</span>'}</td>` +
        `<td class="muted clip">${esc(String(j.lastResultPreview ?? ""))}</td></tr>`
      );
    })
    .join("");
  const body = `<section class="panel">
    <h2>Scheduled jobs</h2>
    ${table(["Name", "Cron", "Next run", "State", "Last", "Last result"], jobRows, "No jobs scheduled.")}
  </section>`;
  return renderShell({ section: "jobs", signedIn, title: "Jobs", subtitle: "scheduled agent work", body });
}

export function renderMemory(signedIn: string, lessons: Record<string, unknown>[]): string {
  const orgLessonRows = lessons
    .filter((l) => l.userId === "org")
    .map(
      (l) =>
        `<tr><td>${pill(String(l.kind), "info")}</td>` +
        `<td>${esc(String(l.text))}</td>` +
        `<td class="mono muted">${String(l.createdAt).slice(0, 10)}</td></tr>`
    )
    .join("");
  const lessonRows = lessons
    .filter((l) => l.userId !== "org")
    .map(
      (l) =>
        `<tr><td>${pill(String(l.kind), "info")}</td>` +
        `<td>${esc(String(l.text))}</td>` +
        `<td class="mono muted">${String(l.createdAt).slice(0, 10)}</td></tr>`
    )
    .join("");
  const body = `<section class="panel">
    <h2>Org lessons</h2>
    ${table(["Kind", "Lesson", "Added"], orgLessonRows, "No org lessons yet.")}
  </section>
  <section class="panel">
    <h2>Agent memory</h2>
    ${table(["Kind", "Lesson", "Added"], lessonRows, "No lessons learned yet.")}
  </section>`;
  return renderShell({ section: "memory", signedIn, title: "Memory", subtitle: "agent and org lessons", body });
}

function ingestHealthPanel(h?: IngestHealthDoc): string {
  if (!h) {
    return `<section class="panel"><h2>Meeting ingest</h2><p class="muted pad">No ingest run yet. After Graph/Teams policy is granted, the Function polls every 5 minutes.</p></section>`;
  }
  const err = h.errors?.length
    ? h.errors.slice(0, 4).map((e) => `<div class="muted" style="padding:.2rem 1.15rem">${esc(e)}</div>`).join("")
    : `<p class="muted pad">No Graph errors on the last run.</p>`;
  return `<section class="panel">
    <h2>Meeting ingest</h2>
    <div class="grid" style="margin:1rem 1.15rem">
      <div class="stat"><div class="label">Last run</div><div class="value" style="font-size:1rem">${esc(h.lastRunAt.slice(0, 19).replace("T", " "))}Z</div></div>
      <div class="stat"><div class="label">Organizers</div><div class="value">${h.scanned}</div></div>
      <div class="stat"><div class="label">Ingested</div><div class="value">${h.ingested}</div></div>
      <div class="stat"><div class="label">Skipped</div><div class="value">${h.skipped}</div></div>
      <div class="stat${h.errors.length ? " alert" : ""}"><div class="label">Errors</div><div class="value">${h.errors.length}</div></div>
    </div>
    ${err}
  </section>`;
}

function easyAuthPrincipal(req: Request): { id: string; name: string } | undefined {
  const id = req.header("x-ms-client-principal-id");
  if (!id) return undefined;
  const name =
    req.header("x-ms-client-principal-name") ??
    claim(req, "preferred_username") ??
    claim(req, "name") ??
    id;
  return { id, name };
}

function claim(req: Request, typ: string): string | undefined {
  const raw = req.header("x-ms-client-principal");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      claims?: { typ: string; val: string }[];
    };
    return parsed.claims?.find((c) => c.typ === typ || c.typ.endsWith(`/${typ}`))?.val;
  } catch {
    return undefined;
  }
}

function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s.includes("ok") || s.includes("success")) return "ok";
  if (s.includes("err") || s.includes("fail")) return "err";
  if (s.includes("retry") || s.includes("pending")) return "warn";
  return "idle";
}

function eventTone(type: string): Tone {
  if (type === "error") return "err";
  if (type === "capture") return "accent";
  if (type === "job_run") return "warn";
  if (type === "tool_call") return "ok";
  return "info";
}
