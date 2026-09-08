/**
 * Admin portal — server-rendered HTML, zero frontend build.
 * Sidebar sections: overview, capabilities, integrations, usage, org, meetings, jobs, memory.
 *
 * In Azure, App Service Easy Auth (Entra) gates /admin*. Locally the page is open.
 */
import { Request, Response } from "restify";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  dayStats,
  logActivity,
  normalizeAttribution,
  recentEvents,
  usageBreakdown,
  type DayStats,
  type UsageBreakdown,
} from "../services/activityLog";
import { CosmosClient } from "@azure/cosmos";
import {
  listCommitmentsForDash,
  listTranscriptAvailability,
  queueTranscriptSelections,
  readHealth,
  recentMeetings,
  transcriptSelectionKey,
} from "../meetings/store";
import type {
  CommitmentDoc,
  IngestHealthDoc,
  MeetingDoc,
  TranscriptAvailabilityDoc,
} from "../meetings/types";
import { loadConfig } from "../config";
import { nativeToolCatalog } from "../tools/registry";
import { mcpServerCatalog, mcpServerHealth, mcpToolDefinitions, type McpServerHealth } from "../tools/mcpClient";
import { catalogSheets } from "../services/smartsheet";
import { requiresApproval } from "../services/approvals";
import { imessageEnabled } from "../channels/types";
import {
  listOrgDirectory,
  orgCounts,
  savePerson,
  saveRole,
  saveUnit,
} from "../org/store";
import { parseAliases } from "../org/resolve";
import type { OrgDirectory } from "../org/types";
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
  const query = req.query as { tab?: string; notice?: string };
  const tab = String(query.tab ?? "");

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
  const html = await renderSection(section, signedIn, tab, String(query.notice ?? ""));
  res.sendRaw(200, html, { "Content-Type": "text/html" });
}

async function renderSection(
  section: SectionId,
  signedIn: string,
  tab: string,
  notice: string
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  switch (section) {
    case "overview": {
      const [stats, events, health, counts] = await Promise.all([
        dayStats(),
        recentEvents(12),
        readHealth().catch(() => undefined),
        orgCounts().catch(() => ({ people: 0, units: 0, roles: 0 })),
      ]);
      return renderOverview({ stats, events, health, signedIn, today, orgCounts: counts });
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
    case "org": {
      const dir = await listOrgDirectory().catch(
        () => ({ units: [], people: [], roles: [] }) as OrgDirectory
      );
      const orgTab = tab === "teams" || tab === "roles" ? tab : "people";
      return renderOrg(signedIn, orgTab, dir, notice);
    }
    case "meetings": {
      const [health, meetings, commitments, transcripts] = await Promise.all([
        readHealth().catch(() => undefined),
        recentMeetings(20).catch(() => [] as MeetingDoc[]),
        listCommitmentsForDash(40).catch(() => [] as CommitmentDoc[]),
        listTranscriptAvailability(500).catch(
          () => [] as TranscriptAvailabilityDoc[]
        ),
      ]);
      return renderMeetings(
        signedIn,
        health,
        meetings,
        commitments,
        transcripts,
        notice
      );
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
      const attribution = normalizeAttribution(e);
      return (
        `<tr><td class="mono muted">${String(e.at).slice(11, 19)}</td>` +
        `<td>${pill(type, eventTone(type))}</td>` +
        `<td>${pill(attribution.origin, "info")}</td>` +
        `<td>${pill(attribution.channel, "idle")}</td>` +
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
  orgCounts?: { people: number; units: number; roles?: number };
}): string {
  const totalTokens = d.stats.inputTokens + d.stats.outputTokens;
  const h = d.health;
  const ingest = h
    ? `<section class="panel">
        <h2>Transcript discovery</h2>
        <div class="grid" style="margin:1rem 1.15rem">
          <div class="stat"><div class="label">Last run</div><div class="value" style="font-size:1rem">${esc(h.lastRunAt.slice(0, 19).replace("T", " "))}Z</div></div>
          <div class="stat${h.errors.length ? " alert" : ""}"><div class="label">Errors</div><div class="value">${h.errors.length}</div></div>
          <div class="stat"><div class="label">Discovered</div><div class="value">${h.discovered ?? 0}</div></div>
        </div>
        <p class="pad muted">Full transcript index and commitments live under <a href="/admin/meetings">Meetings</a>.</p>
      </section>`
    : `<section class="panel"><h2>Transcript discovery</h2><p class="muted pad">No discovery run yet. After Graph/Teams policy is granted, the Function checks every 5 minutes without spending summary tokens.</p></section>`;

  const peopleN = d.orgCounts?.people ?? 0;
  const unitsN = d.orgCounts?.units ?? 0;
  const body = `
  <p class="lede">TaskBrain ops — capabilities, health, usage. What the agent can do, how it is performing today, which tools are live, and how people are using it.</p>
  <p class="lede"><a href="/admin/org">${peopleN} people, ${unitsN} teams</a> in the org directory.</p>
  ${kpiGrid(d.stats)}
  ${budgetBlock(totalTokens)}
  ${ingest}
  <section class="panel">
    <h2>Latest events</h2>
    ${table(["Time", "Type", "Origin", "Channel", "Agent", "Detail"], eventRowsHtml(d.events), "No events yet.")}
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
      { name: "Transcript discovery", label: ingestLabel, tone: ingestTone, note: ingestNote },
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
  <p class="lede">How people used the bot today — origin, channel, input mode, tools, models, and unique users (ids truncated).</p>
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
  ${countTable("Tokens by origin", usage.tokensByOrigin, "No attributed model tokens today.")}
  ${countTable("Activity by channel", usage.byChannel, "No activity today.")}
  ${countTable("Activity by origin", usage.byOrigin, "No activity today.")}
  ${countTable("Captures by input mode", usage.byInputMode, "No captures today.")}
  ${countTable("Tool calls", usage.byTool, "No tool calls today.")}
  <section class="panel"><h2>People (truncated id)</h2>${table(["User", "<span class='num'>Events</span>"], peopleRows, "No user-tagged events today.")}</section>
  <section class="panel">
    <h2>Recent events</h2>
    ${table(["Time", "Type", "Origin", "Channel", "Agent", "Detail"], eventRowsHtml(events), "No events yet.")}
  </section>`;

  return renderShell({
    section: "usage",
    signedIn,
    title: "Usage",
    subtitle: "how people are using it",
    body,
  });
}

function csrfSecret(): string {
  return process.env.ADMIN_APP_SECRET ?? process.env.COSMOS_KEY ?? "local-test-only";
}

export function meetingCsrfScope(keys: string[]): string {
  return Buffer.from([...new Set(keys)].sort().join("\n"), "utf8").toString(
    "base64url"
  );
}

export function meetingCsrfToken(scope: string, expiresAt = Date.now() + 3600_000): string {
  const payload = `${expiresAt}.${scope}`;
  const signature = createHmac("sha256", csrfSecret())
    .update(payload)
    .digest("base64url");
  return Buffer.from(`${payload}.${signature}`, "utf8").toString("base64url");
}

export function verifyMeetingCsrf(token: string, scope: string): boolean {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const first = decoded.indexOf(".");
    const last = decoded.lastIndexOf(".");
    if (first < 1 || last <= first) return false;
    const expires = Number(decoded.slice(0, first));
    const tokenScope = decoded.slice(first + 1, last);
    const signature = decoded.slice(last + 1);
    if (!Number.isFinite(expires) || expires < Date.now() || tokenScope !== scope) {
      return false;
    }
    const expected = createHmac("sha256", csrfSecret())
      .update(`${expires}.${scope}`)
      .digest("base64url");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function selectedValues(body: Record<string, unknown>): string[] {
  const value = body.selection;
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

export async function queueMeetingSummaries(
  req: Request,
  res: Response
): Promise<void> {
  const principal = easyAuthPrincipal(req);
  if (process.env.WEBSITE_INSTANCE_ID && !principal) {
    res.send(401, "sign in required");
    return;
  }
  const origin = req.header("origin");
  const host = req.header("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        res.send(403, "invalid request origin");
        return;
      }
    } catch {
      res.send(403, "invalid request origin");
      return;
    }
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scope = String(body._scope ?? "");
  const token = String(body._csrf ?? "");
  if (!verifyMeetingCsrf(token, scope)) {
    res.send(403, "invalid or expired request");
    return;
  }
  const allowed = new Set(
    Buffer.from(scope, "base64url").toString("utf8").split("\n").filter(Boolean)
  );
  const selected = selectedValues(body)
    .filter((key) => allowed.has(key))
    .slice(0, 25);
  if (!selected.length) {
    res.header("Location", "/admin/meetings?notice=none");
    res.send(303);
    return;
  }
  try {
    const result = await queueTranscriptSelections(
      selected,
      principal?.id ?? "local"
    );
    void logActivity({
      type: "meeting_summary",
      userId: principal?.id,
      origin: "admin_summary",
      channel: "internal",
      trigger: "admin_queue",
      detail: { queued: result.queued, unchanged: result.unchanged },
    });
    const notice = result.queued
      ? `queued-${result.queued}`
      : "already-queued";
    res.header("Location", `/admin/meetings?notice=${notice}`);
    res.send(303);
  } catch (err) {
    console.error("[admin] queue meeting summaries failed:", err);
    res.header("Location", "/admin/meetings?notice=error");
    res.send(303);
  }
}

export type OrgTab = "people" | "teams" | "roles";

function field(body: Record<string, unknown>, key: string): string {
  return String(body[key] ?? "").trim();
}

function selectHtml(
  name: string,
  items: { id: string; label: string }[],
  selected?: string,
  empty = "—"
): string {
  const opts = [`<option value="">${esc(empty)}</option>`].concat(
    items.map(
      (i) =>
        `<option value="${esc(i.id)}"${i.id === selected ? " selected" : ""}>${esc(i.label)}</option>`
    )
  );
  return `<select name="${esc(name)}">${opts.join("")}</select>`;
}

function orgNoticeHtml(notice: string): string {
  if (notice === "saved") return `<p class="pad">${pill("saved", "ok")} Directory updated.</p>`;
  if (notice === "archived") return `<p class="pad">${pill("archived", "warn")} Record is no longer active.</p>`;
  if (notice === "missing") return `<p class="pad muted">Name is required.</p>`;
  if (notice === "error") return `<p class="pad">${pill("error", "err")} Could not save the org record.</p>`;
  return "";
}

function orgFormChrome(tab: OrgTab, ids: string[]): { scope: string; csrf: string; hidden: string } {
  const scope = meetingCsrfScope([`org:${tab}`, ...ids]);
  const csrf = meetingCsrfToken(scope);
  const hidden =
    `<input type="hidden" name="_scope" value="${esc(scope)}">` +
    `<input type="hidden" name="_csrf" value="${esc(csrf)}">` +
    `<input type="hidden" name="_tab" value="${esc(tab)}">`;
  return { scope, csrf, hidden };
}

export function renderOrg(
  signedIn: string,
  tab: OrgTab,
  dir: OrgDirectory,
  notice = ""
): string {
  const tabBar = tabs("/admin/org", [
    { id: "people", label: "People" },
    { id: "teams", label: "Teams" },
    { id: "roles", label: "Roles" },
  ], tab);
  const unitOpts = dir.units
    .filter((u) => u.status === "active")
    .map((u) => ({ id: u.id, label: u.name }));
  const personOpts = dir.people
    .filter((p) => p.status === "active")
    .map((p) => ({ id: p.id, label: p.displayName }));
  const unitName = (id?: string) => dir.units.find((u) => u.id === id)?.name ?? "—";
  const personName = (id?: string) => dir.people.find((p) => p.id === id)?.displayName ?? "—";

  let inner: string;
  if (tab === "teams") {
    const ids = dir.units.map((u) => u.id);
    const { hidden } = orgFormChrome(tab, ids);
    const rows = dir.units
      .map((u) => {
        const { hidden: rowHidden } = orgFormChrome(tab, ids);
        return (
          `<tr><td class="strong">${esc(u.name)}</td>` +
          `<td class="muted">${esc(u.parentId ? unitName(u.parentId) : "—")}</td>` +
          `<td class="muted clip">${esc(u.purpose || "—")}</td>` +
          `<td>${pill(u.status, u.status === "active" ? "ok" : "idle")}</td>` +
          `<td><form method="post" action="/admin/org">${rowHidden}` +
          `<input type="hidden" name="id" value="${esc(u.id)}">` +
          `<input type="hidden" name="name" value="${esc(u.name)}">` +
          `<input type="hidden" name="parentId" value="${esc(u.parentId ?? "")}">` +
          `<input type="hidden" name="purpose" value="${esc(u.purpose)}">` +
          `<button class="ghost" type="submit" name="_action" value="archive">Archive</button></form></td></tr>`
        );
      })
      .join("");
    inner = `${orgNoticeHtml(notice)}
      <section class="panel">
        <h2>Add team</h2>
        <form class="form" method="post" action="/admin/org">
          ${hidden}
          <input type="hidden" name="_action" value="save">
          <label>Name <input name="name" required maxlength="80"></label>
          <label>Parent ${selectHtml("parentId", unitOpts)}</label>
          <label class="span2">Purpose / mandate <textarea name="purpose" maxlength="400"></textarea></label>
          <div class="actions"><button type="submit">Save team</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>Teams</h2>
        ${table(["Name", "Parent", "Purpose", "Status", ""], rows, "No teams yet.")}
      </section>`;
  } else if (tab === "roles") {
    const ids = dir.roles.map((r) => r.id);
    const { hidden } = orgFormChrome(tab, ids);
    const rows = dir.roles
      .map((r) => {
        const { hidden: rowHidden } = orgFormChrome(tab, ids);
        return (
          `<tr><td class="strong">${esc(r.title)}</td>` +
          `<td>${esc(personName(r.personId))}</td>` +
          `<td class="muted">${esc(r.unitId ? unitName(r.unitId) : "—")}</td>` +
          `<td class="muted clip">${esc(r.mandate || "—")}</td>` +
          `<td>${pill(r.status, r.status === "active" ? "ok" : "idle")}</td>` +
          `<td><form method="post" action="/admin/org">${rowHidden}` +
          `<input type="hidden" name="id" value="${esc(r.id)}">` +
          `<input type="hidden" name="personId" value="${esc(r.personId)}">` +
          `<input type="hidden" name="title" value="${esc(r.title)}">` +
          `<input type="hidden" name="unitId" value="${esc(r.unitId ?? "")}">` +
          `<input type="hidden" name="mandate" value="${esc(r.mandate)}">` +
          `<button class="ghost" type="submit" name="_action" value="archive">Archive</button></form></td></tr>`
        );
      })
      .join("");
    inner = `${orgNoticeHtml(notice)}
      <section class="panel">
        <h2>Add role</h2>
        <form class="form" method="post" action="/admin/org">
          ${hidden}
          <input type="hidden" name="_action" value="save">
          <label>Title <input name="title" required maxlength="80"></label>
          <label>Person ${selectHtml("personId", personOpts, undefined, "Select person")}</label>
          <label>Team ${selectHtml("unitId", unitOpts)}</label>
          <label class="span2">Mandate <textarea name="mandate" maxlength="400"></textarea></label>
          <div class="actions"><button type="submit">Save role</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>Roles</h2>
        ${table(["Title", "Person", "Team", "Mandate", "Status", ""], rows, "No named roles yet.")}
      </section>`;
  } else {
    const ids = dir.people.map((p) => p.id);
    const { hidden } = orgFormChrome("people", ids);
    const rows = dir.people
      .map((p) => {
        const { hidden: rowHidden } = orgFormChrome("people", ids);
        const hats = dir.roles
          .filter((r) => r.personId === p.id && r.status === "active")
          .map((r) => r.title)
          .join(", ");
        return (
          `<tr><td class="strong">${esc(p.displayName)}</td>` +
          `<td class="muted">${esc(p.title ?? "—")}</td>` +
          `<td class="muted">${esc(p.unitId ? unitName(p.unitId) : "—")}</td>` +
          `<td class="muted">${esc(p.managerPersonId ? personName(p.managerPersonId) : "—")}</td>` +
          `<td class="muted clip">${esc(p.mandate || "—")}</td>` +
          `<td class="muted clip">${esc(hats || "—")}</td>` +
          `<td>${pill(p.status, p.status === "active" ? "ok" : "idle")}</td>` +
          `<td><form method="post" action="/admin/org">${rowHidden}` +
          `<input type="hidden" name="id" value="${esc(p.id)}">` +
          `<input type="hidden" name="displayName" value="${esc(p.displayName)}">` +
          `<input type="hidden" name="entraId" value="${esc(p.entraId ?? "")}">` +
          `<input type="hidden" name="aliases" value="${esc(p.aliases.join(", "))}">` +
          `<input type="hidden" name="title" value="${esc(p.title ?? "")}">` +
          `<input type="hidden" name="managerPersonId" value="${esc(p.managerPersonId ?? "")}">` +
          `<input type="hidden" name="unitId" value="${esc(p.unitId ?? "")}">` +
          `<input type="hidden" name="mandate" value="${esc(p.mandate)}">` +
          `<button class="ghost" type="submit" name="_action" value="archive">Archive</button></form></td></tr>`
        );
      })
      .join("");
    inner = `${orgNoticeHtml(notice)}
      <section class="panel">
        <h2>Add or update person</h2>
        <p class="pad muted">Optional Entra object id ties Teams/iMessage identity. Aliases (comma-separated) match meeting owners like "Val".</p>
        <form class="form" method="post" action="/admin/org">
          ${hidden}
          <input type="hidden" name="_action" value="save">
          <label>Name <input name="displayName" required maxlength="80"></label>
          <label>Title <input name="title" maxlength="80"></label>
          <label>Entra object id <input name="entraId" maxlength="64" class="mono"></label>
          <label>Aliases <input name="aliases" placeholder="Val, Valerie"></label>
          <label>Home team ${selectHtml("unitId", unitOpts)}</label>
          <label>Manager ${selectHtml("managerPersonId", personOpts)}</label>
          <label class="span2">Mandate (what they should be doing) <textarea name="mandate" maxlength="400"></textarea></label>
          <div class="actions"><button type="submit">Save person</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>People</h2>
        ${table(["Name", "Title", "Team", "Manager", "Mandate", "Roles", "Status", ""], rows, "No people in the directory yet.")}
      </section>`;
  }

  return renderShell({
    section: "org",
    signedIn,
    title: "Org",
    subtitle: "who reports to whom, and what they should be doing",
    body: tabBar + inner,
  });
}

function requireAdminPrincipal(req: Request, res: Response): { id: string; name: string } | "local" | undefined {
  const principal = easyAuthPrincipal(req);
  if (process.env.WEBSITE_INSTANCE_ID && !principal) {
    res.send(401, "sign in required");
    return undefined;
  }
  const origin = req.header("origin");
  const host = req.header("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        res.send(403, "invalid request origin");
        return undefined;
      }
    } catch {
      res.send(403, "invalid request origin");
      return undefined;
    }
  }
  return principal ?? "local";
}

export async function saveOrgDirectory(req: Request, res: Response): Promise<void> {
  const who = requireAdminPrincipal(req, res);
  if (!who) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tabRaw = field(body, "_tab");
  const tab: OrgTab = tabRaw === "teams" || tabRaw === "roles" ? tabRaw : "people";
  const redirect = (notice: string) => {
    res.header("Location", `/admin/org?tab=${tab}&notice=${notice}`);
    res.send(303);
  };
  const scope = field(body, "_scope");
  if (!verifyMeetingCsrf(field(body, "_csrf"), scope)) {
    res.send(403, "invalid or expired request");
    return;
  }
  const allowed = new Set(
    Buffer.from(scope, "base64url").toString("utf8").split("\n").filter(Boolean)
  );
  if (!allowed.has(`org:${tab}`)) {
    res.send(403, "invalid request scope");
    return;
  }
  const action = field(body, "_action") || "save";
  const id = field(body, "id");
  if (id && !allowed.has(id)) {
    res.send(403, "invalid request scope");
    return;
  }
  try {
    if (tab === "teams") {
      const name = field(body, "name");
      if (!name) return redirect("missing");
      await saveUnit({
        id: id || undefined,
        name,
        parentId: field(body, "parentId") || undefined,
        purpose: field(body, "purpose"),
        archive: action === "archive",
      });
    } else if (tab === "roles") {
      const title = field(body, "title");
      const personId = field(body, "personId");
      if (!title || !personId) return redirect("missing");
      await saveRole({
        id: id || undefined,
        personId,
        title,
        unitId: field(body, "unitId") || undefined,
        mandate: field(body, "mandate"),
        archive: action === "archive",
      });
    } else {
      const displayName = field(body, "displayName");
      if (!displayName) return redirect("missing");
      await savePerson({
        id: id || undefined,
        displayName,
        entraId: field(body, "entraId") || undefined,
        aliases: parseAliases(field(body, "aliases")),
        managerPersonId: field(body, "managerPersonId") || undefined,
        unitId: field(body, "unitId") || undefined,
        title: field(body, "title") || undefined,
        mandate: field(body, "mandate"),
        archive: action === "archive",
      });
    }
    void logActivity({
      type: "tool_call",
      userId: who === "local" ? undefined : who.id,
      origin: "system",
      channel: "internal",
      trigger: "admin_org",
      detail: { tab, action, id: id || undefined },
    });
    redirect(action === "archive" ? "archived" : "saved");
  } catch (err) {
    console.error("[admin] save org failed:", err);
    redirect("error");
  }
}

export function renderMeetings(
  signedIn: string,
  health?: IngestHealthDoc,
  meetings: MeetingDoc[] = [],
  commitments: CommitmentDoc[] = [],
  transcripts: TranscriptAvailabilityDoc[] = [],
  notice = ""
): string {
  const selectable = transcripts.filter(
    (t) => t.status === "available" || t.status === "failed"
  );
  const selectionKeys = selectable.map((t) =>
    transcriptSelectionKey(t.organizerId, t.transcriptId)
  );
  const scope = meetingCsrfScope(selectionKeys);
  const csrf = meetingCsrfToken(scope);
  const counts = transcripts.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});
  const transcriptStats = [
    "available",
    "queued",
    "processing",
    "summarized",
    "failed",
    "skipped_short",
  ]
    .map(
      (status) =>
        `<div class="stat${status === "failed" && counts[status] ? " alert" : ""}">` +
        `<div class="label">${esc(status.replace("_", " "))}</div>` +
        `<div class="value">${counts[status] ?? 0}</div></div>`
    )
    .join("");
  const transcriptRows = transcripts
    .map((t) => {
      const key = transcriptSelectionKey(t.organizerId, t.transcriptId);
      const canSelect = t.status === "available" || t.status === "failed";
      const tone: Tone =
        t.status === "summarized"
          ? "ok"
          : t.status === "failed"
            ? "err"
            : t.status === "queued" || t.status === "processing"
              ? "warn"
              : t.status === "available"
                ? "accent"
                : "idle";
      return (
        `<tr><td>${canSelect ? `<input type="checkbox" name="selection" value="${esc(key)}" aria-label="Select ${esc(t.titleHint ?? t.transcriptId)}">` : ""}</td>` +
        `<td class="mono muted">${esc((t.createdDateTime ?? t.discoveredAt).slice(0, 16).replace("T", " "))}</td>` +
        `<td class="strong">${esc(t.titleHint ?? "Untitled meeting")}</td>` +
        `<td class="muted">${esc(t.organizerName ?? t.organizerId)}</td>` +
        `<td>${pill(t.status.replace("_", " "), tone)}</td>` +
        `<td class="muted clip">${esc(t.error ?? "—")}</td></tr>`
      );
    })
    .join("");
  const noticeHtml =
    notice.startsWith("queued-")
      ? `<p class="pad">${pill("queued", "ok")} ${esc(notice.slice(7))} transcript(s) will be summarized by the next Function run.</p>`
      : notice === "already-queued"
        ? `<p class="pad muted">Those transcripts were already queued, processing, or summarized.</p>`
        : notice === "none"
          ? `<p class="pad muted">Select at least one available or failed transcript.</p>`
          : notice === "error"
            ? `<p class="pad">${pill("error", "err")} Could not queue the selection.</p>`
            : "";

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
    <h2>Transcript availability</h2>
    ${noticeHtml}
    <div class="grid" style="margin:1rem 1.15rem">${transcriptStats}</div>
    <p class="pad muted">Teams creates the transcript. TaskBrain only downloads and summarizes selected meetings; raw VTT is never stored.</p>
    <form method="post" action="/admin/meetings/summarize">
      <input type="hidden" name="_scope" value="${esc(scope)}">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      ${table(["Select", "Date", "Meeting", "Organizer", "Status", "Error"], transcriptRows, "No transcripts discovered in the last 30 days.")}
      <div class="pad"><button type="submit"${selectable.length ? "" : " disabled"}>Summarize selected</button></div>
    </form>
  </section>
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
    subtitle: "transcript discovery and follow-through",
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
    return `<section class="panel"><h2>Transcript discovery</h2><p class="muted pad">No discovery run yet. After Graph/Teams policy is granted, the Function checks every 5 minutes without spending summary tokens.</p></section>`;
  }
  const err = h.errors?.length
    ? h.errors.slice(0, 4).map((e) => `<div class="muted" style="padding:.2rem 1.15rem">${esc(e)}</div>`).join("")
    : `<p class="muted pad">No Graph errors on the last run.</p>`;
  return `<section class="panel">
    <h2>Transcript discovery</h2>
    <div class="grid" style="margin:1rem 1.15rem">
      <div class="stat"><div class="label">Last run</div><div class="value" style="font-size:1rem">${esc(h.lastRunAt.slice(0, 19).replace("T", " "))}Z</div></div>
      <div class="stat"><div class="label">Organizers</div><div class="value">${h.scanned}</div></div>
      <div class="stat"><div class="label">Discovered</div><div class="value">${h.discovered ?? 0}</div></div>
      <div class="stat"><div class="label">Existing</div><div class="value">${h.skipped}</div></div>
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
