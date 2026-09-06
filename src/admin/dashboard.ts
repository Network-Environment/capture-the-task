/**
 * Admin dashboard — one server-rendered HTML page, zero frontend build.
 * Shows: today's stats + token spend by model, scheduled jobs, agent memory,
 * and the recent event stream.
 *
 * In Azure, App Service Easy Auth (Entra) gates /admin. Only users assigned
 * to the TaskBrain Admin enterprise app can sign in. /api/messages and
 * /healthz stay anonymous. Locally there is no Easy Auth, so the page is
 * open on loopback.
 */
import { Request, Response } from "restify";
import { dayStats, recentEvents } from "../services/activityLog";
import { CosmosClient } from "@azure/cosmos";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const db = cosmos.database(process.env.COSMOS_DB ?? "taskbrain");

export async function adminPage(req: Request, res: Response): Promise<void> {
  const principal = easyAuthPrincipal(req);
  if (process.env.WEBSITE_INSTANCE_ID && !principal) {
    res.send(401, "sign in required");
    return;
  }

  const [stats, events, jobs, lessons] = await Promise.all([
    dayStats(),
    recentEvents(60),
    db.container("jobs").items.query("SELECT * FROM c ORDER BY c.nextRun").fetchAll(),
    db.container("agent-memory").items.query("SELECT * FROM c ORDER BY c.createdAt DESC").fetchAll(),
  ]);

  const modelRows = Object.entries(stats.byModel)
    .map(
      ([m, s]) =>
        `<tr><td>${esc(m)}</td><td>${s.calls}</td><td>${s.inputTokens.toLocaleString()}</td><td>${s.outputTokens.toLocaleString()}</td></tr>`
    )
    .join("");

  const jobRows = jobs.resources
    .map(
      (j: Record<string, unknown>) =>
        `<tr><td>${esc(String(j.name))}</td><td>${esc(String(j.cron ?? "one-off"))}</td>` +
        `<td>${esc(String(j.nextRun ?? ""))}</td><td>${j.enabled ? "on" : "paused"}</td>` +
        `<td>${esc(String(j.lastStatus ?? "—"))}</td><td class="dim">${esc(String(j.lastResultPreview ?? ""))}</td></tr>`
    )
    .join("");

  const lessonRows = lessons.resources
    .map(
      (l: Record<string, unknown>) =>
        `<tr><td>${esc(String(l.kind))}</td><td>${esc(String(l.text))}</td><td class="dim">${String(l.createdAt).slice(0, 10)}</td></tr>`
    )
    .join("");

  const eventRows = events
    .map(
      (e) =>
        `<tr><td class="dim">${String(e.at).slice(11, 19)}</td><td>${esc(String(e.type))}</td>` +
        `<td>${esc(String(e.agent ?? ""))}</td><td class="dim">${esc(JSON.stringify(e.detail ?? {}).slice(0, 160))}</td></tr>`
    )
    .join("");

  const signedIn = principal?.name ?? "local";
  res.sendRaw(200, html(stats, modelRows, jobRows, lessonRows, eventRows, signedIn), {
    "Content-Type": "text/html",
  });
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

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function html(
  stats: Awaited<ReturnType<typeof dayStats>>,
  modelRows: string,
  jobRows: string,
  lessonRows: string,
  eventRows: string,
  signedIn: string
): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="60">
<title>TaskBrain admin</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:2rem;max-width:1100px;color:#1a1a1a}
  h1{font-size:1.3rem} h2{font-size:1rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.3rem}
  .who{color:#888;font-size:13px;margin-top:-.6rem}
  .cards{display:flex;gap:1rem;flex-wrap:wrap}
  .card{border:1px solid #ddd;border-radius:8px;padding:.8rem 1.2rem;min-width:110px}
  .card b{display:block;font-size:1.4rem}
  table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{padding:.35rem .6rem;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
  .dim{color:#888} th{color:#555}
</style></head><body>
<h1>TaskBrain — today</h1>
<p class="who">${esc(signedIn)}${signedIn !== "local" ? ' · <a href="/.auth/logout">sign out</a>' : ""}</p>
<div class="cards">
  <div class="card"><b>${stats.captures}</b>captures</div>
  <div class="card"><b>${stats.toolCalls}</b>tool calls</div>
  <div class="card"><b>${stats.jobRuns}</b>job runs</div>
  <div class="card"><b>${stats.errors}</b>errors</div>
  <div class="card"><b>${stats.inputTokens.toLocaleString()}</b>tokens in</div>
  <div class="card"><b>${stats.outputTokens.toLocaleString()}</b>tokens out</div>
</div>
<h2>Model usage (today)</h2>
<table><tr><th>Model</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th></tr>${modelRows || "<tr><td colspan=4 class=dim>none yet</td></tr>"}</table>
<h2>Scheduled jobs</h2>
<table><tr><th>Name</th><th>Cron</th><th>Next run</th><th>State</th><th>Last</th><th>Last result</th></tr>${jobRows || "<tr><td colspan=6 class=dim>none</td></tr>"}</table>
<h2>Agent memory (lessons)</h2>
<table><tr><th>Kind</th><th>Lesson</th><th>Added</th></tr>${lessonRows || "<tr><td colspan=3 class=dim>none yet</td></tr>"}</table>
<h2>Recent events</h2>
<table><tr><th>Time</th><th>Type</th><th>Agent</th><th>Detail</th></tr>${eventRows || "<tr><td colspan=4 class=dim>none yet</td></tr>"}</table>
</body></html>`;
}
