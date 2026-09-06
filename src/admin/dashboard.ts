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

  const jobRows = jobs.resources
    .map((j: Record<string, unknown>) => {
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

  const lessonRows = lessons.resources
    .map(
      (l: Record<string, unknown>) =>
        `<tr><td>${pill(String(l.kind), "info")}</td>` +
        `<td>${esc(String(l.text))}</td>` +
        `<td class="mono muted">${String(l.createdAt).slice(0, 10)}</td></tr>`
    )
    .join("");

  const eventRows = events
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

  const signedIn = principal?.name ?? "local";
  res.sendRaw(
    200,
    renderDashboard({ stats, totalTokens, modelRows, jobRows, lessonRows, eventRows, signedIn }),
    { "Content-Type": "text/html" }
  );
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

type Tone = "ok" | "warn" | "err" | "info" | "idle" | "accent";

function pill(label: string, tone: Tone): string {
  return `<span class="pill ${tone}">${esc(label)}</span>`;
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

function initials(name: string): string {
  const parts = name.replace(/@.*$/, "").split(/[.\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function table(cols: string[], rows: string, empty: string): string {
  const head = cols.map((c) => `<th>${c}</th>`).join("");
  return (
    `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${
      rows || `<tr><td class="empty" colspan="${cols.length}">${empty}</td></tr>`
    }</tbody></table></div>`
  );
}

export function renderDashboard(d: {
  stats: Awaited<ReturnType<typeof dayStats>>;
  totalTokens: number;
  modelRows: string;
  jobRows: string;
  lessonRows: string;
  eventRows: string;
  signedIn: string;
}): string {
  const { stats, totalTokens, signedIn } = d;
  const budget = Number(process.env.DAILY_TOKEN_BUDGET ?? 0);
  const pct = budget > 0 ? Math.min(100, (totalTokens / budget) * 100) : 0;
  const budgetTone = pct >= 100 ? "err" : pct >= 75 ? "warn" : "ok";
  const today = new Date().toISOString().slice(0, 10);

  const budgetBlock =
    budget > 0
      ? `<section class="panel budget">
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
    </section>`
      : "";

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>TaskBrain admin</title>
<script>(function(){try{var t=localStorage.getItem("tb-theme");if(t){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();</script>
<style>
:root{
  color-scheme:light dark;
  --bg:#f5f7fa; --surface:#fff; --surface-2:#fafbfc; --border:#e4e8ee;
  --text:#0f141a; --muted:#5f6b7a; --accent:#2f6df6; --accent-soft:rgba(47,109,246,.1);
  --ok:#0f9d58; --ok-soft:rgba(15,157,88,.12);
  --warn:#b7791f; --warn-soft:rgba(183,121,31,.13);
  --err:#d93838; --err-soft:rgba(217,56,56,.11);
  --info:#6b46c1; --info-soft:rgba(107,70,193,.11);
  --idle-soft:rgba(95,107,122,.12);
  --shadow:0 1px 2px rgba(15,20,26,.05),0 6px 18px rgba(15,20,26,.05);
  --radius:14px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0a0c10; --surface:#12161c; --surface-2:#161b22; --border:#242b35;
    --text:#e7ecf3; --muted:#8b95a5; --accent:#7aa2ff; --accent-soft:rgba(122,162,255,.14);
    --ok:#43c98b; --ok-soft:rgba(67,201,139,.14);
    --warn:#e0a94a; --warn-soft:rgba(224,169,74,.14);
    --err:#ff6b6b; --err-soft:rgba(255,107,107,.14);
    --info:#a78bfa; --info-soft:rgba(167,139,250,.14);
    --idle-soft:rgba(139,149,165,.15);
    --shadow:0 1px 2px rgba(0,0,0,.5),0 8px 26px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"]{
  --bg:#0a0c10; --surface:#12161c; --surface-2:#161b22; --border:#242b35;
  --text:#e7ecf3; --muted:#8b95a5; --accent:#7aa2ff; --accent-soft:rgba(122,162,255,.14);
  --ok:#43c98b; --ok-soft:rgba(67,201,139,.14);
  --warn:#e0a94a; --warn-soft:rgba(224,169,74,.14);
  --err:#ff6b6b; --err-soft:rgba(255,107,107,.14);
  --info:#a78bfa; --info-soft:rgba(167,139,250,.14);
  --idle-soft:rgba(139,149,165,.15);
  --shadow:0 1px 2px rgba(0,0,0,.5),0 8px 26px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--text);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.86em}
.muted{color:var(--muted)}
.strong{font-weight:600}
.num{font-variant-numeric:tabular-nums}

header{
  position:sticky;top:0;z-index:10;
  background:color-mix(in srgb,var(--bg) 82%,transparent);
  backdrop-filter:saturate(180%) blur(12px);
  border-bottom:1px solid var(--border);
}
.head-in{max-width:1180px;margin:0 auto;padding:.85rem 1.5rem;display:flex;align-items:center;gap:1rem}
.brand{display:flex;align-items:center;gap:.7rem;min-width:0}
.logo{
  width:34px;height:34px;border-radius:10px;flex:none;
  background:linear-gradient(135deg,var(--accent),#9b5cff);
  color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;letter-spacing:.02em;
}
.brand h1{font-size:1rem;margin:0;font-weight:650;letter-spacing:-.01em}
.brand p{margin:0;font-size:12px;color:var(--muted)}
.spacer{flex:1}
.live{display:flex;align-items:center;gap:.4rem;font-size:12px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
.who{display:flex;align-items:center;gap:.55rem;font-size:13px}
.avatar{
  width:28px;height:28px;border-radius:50%;flex:none;display:grid;place-items:center;
  background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:700;
}
.who a{color:var(--muted);text-decoration:none}
.who a:hover{color:var(--text)}
.iconbtn{
  width:34px;height:34px;border-radius:10px;flex:none;cursor:pointer;
  background:var(--surface);border:1px solid var(--border);color:var(--muted);
  display:grid;place-items:center;transition:color .15s,border-color .15s;
}
.iconbtn:hover{color:var(--text);border-color:var(--muted)}
.iconbtn svg{width:16px;height:16px}
.icon-sun{display:none}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]) .icon-sun{display:block}
  :root:not([data-theme="light"]) .icon-moon{display:none}
}
:root[data-theme="dark"] .icon-sun{display:block}
:root[data-theme="dark"] .icon-moon{display:none}
:root[data-theme="light"] .icon-sun{display:none}
:root[data-theme="light"] .icon-moon{display:block}

main{max-width:1180px;margin:0 auto;padding:1.6rem 1.5rem 4rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.85rem;margin-bottom:1.4rem}
.stat{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:.95rem 1.1rem;box-shadow:var(--shadow);transition:transform .15s,border-color .15s;
}
.stat:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
.stat .label{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.stat .value{font-size:1.75rem;font-weight:660;letter-spacing:-.02em;line-height:1.15;margin-top:.2rem;font-variant-numeric:tabular-nums}
.stat.alert .value{color:var(--err)}

.panel{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:var(--shadow);margin-bottom:1.2rem;overflow:hidden;
}
.panel>h2{
  margin:0;padding:.9rem 1.15rem;font-size:.82rem;font-weight:650;
  text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  border-bottom:1px solid var(--border);background:var(--surface-2);
}
.budget{padding:1.15rem}
.budget>h2{padding:0;border:0;background:none;text-transform:none;font-size:.95rem;color:var(--text);letter-spacing:-.01em}
.budget p{margin:.15rem 0 0;font-size:12.5px}
.budget-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:.8rem;flex-wrap:wrap}
.budget-num{font-size:1.05rem;white-space:nowrap}

.bar{height:6px;border-radius:99px;background:var(--idle-soft);overflow:hidden;min-width:60px;flex:1}
.bar i{display:block;height:100%;border-radius:99px;background:var(--accent)}
.bar.lg{height:9px}
.bar.ok i{background:var(--ok)}
.bar.warn i{background:var(--warn)}
.bar.err i{background:var(--err)}

.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{
  text-align:left;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--muted);padding:.6rem 1.15rem;border-bottom:1px solid var(--border);white-space:nowrap;
}
td{padding:.6rem 1.15rem;border-bottom:1px solid color-mix(in srgb,var(--border) 60%,transparent);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background .12s}
tbody tr:hover{background:var(--surface-2)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.clip{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.empty{text-align:center;color:var(--muted);padding:2rem 1rem;font-size:13px}
td.share{min-width:150px}
.share{display:flex;align-items:center;gap:.6rem}

.pill{
  display:inline-block;padding:.16rem .55rem;border-radius:99px;font-size:11.5px;font-weight:600;
  letter-spacing:.01em;white-space:nowrap;background:var(--idle-soft);color:var(--muted);
}
.pill.ok{background:var(--ok-soft);color:var(--ok)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.err{background:var(--err-soft);color:var(--err)}
.pill.info{background:var(--info-soft);color:var(--info)}
.pill.accent{background:var(--accent-soft);color:var(--accent)}

@media (max-width:640px){
  .head-in{padding:.7rem 1rem;gap:.6rem}
  main{padding:1.1rem 1rem 3rem}
  .brand p,.live{display:none}
  td,th{padding:.55rem .8rem}
  td.clip{max-width:200px}
}
</style></head><body>
<header><div class="head-in">
  <div class="brand">
    <div class="logo">TB</div>
    <div>
      <h1>TaskBrain</h1>
      <p>${today} · today's activity</p>
    </div>
  </div>
  <div class="spacer"></div>
  <div class="live"><span class="dot"></span>auto-refresh 60s</div>
  <button class="iconbtn" id="theme" type="button" title="Toggle theme" aria-label="Toggle theme">
    <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
  </button>
  <div class="who">
    <span class="avatar">${esc(initials(signedIn))}</span>
    ${signedIn !== "local" ? `<a href="/.auth/logout">Sign out</a>` : `<span class="muted">local</span>`}
  </div>
</div></header>

<main>
  <div class="grid">
    <div class="stat"><div class="label">Captures</div><div class="value">${stats.captures.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Tool calls</div><div class="value">${stats.toolCalls.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Job runs</div><div class="value">${stats.jobRuns.toLocaleString()}</div></div>
    <div class="stat${stats.errors > 0 ? " alert" : ""}"><div class="label">Errors</div><div class="value">${stats.errors.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Tokens in</div><div class="value">${stats.inputTokens.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Tokens out</div><div class="value">${stats.outputTokens.toLocaleString()}</div></div>
  </div>

  ${budgetBlock}

  <section class="panel">
    <h2>Model usage</h2>
    ${table(
      ["Model", "<span class='num'>Calls</span>", "<span class='num'>Input</span>", "<span class='num'>Output</span>", "Share"],
      d.modelRows,
      "No model calls yet today."
    )}
  </section>

  <section class="panel">
    <h2>Scheduled jobs</h2>
    ${table(["Name", "Cron", "Next run", "State", "Last", "Last result"], d.jobRows, "No jobs scheduled.")}
  </section>

  <section class="panel">
    <h2>Agent memory</h2>
    ${table(["Kind", "Lesson", "Added"], d.lessonRows, "No lessons learned yet.")}
  </section>

  <section class="panel">
    <h2>Recent events</h2>
    ${table(["Time", "Type", "Agent", "Detail"], d.eventRows, "No events yet.")}
  </section>
</main>

<script>
document.getElementById("theme").addEventListener("click", function(){
  var el = document.documentElement;
  var set = el.getAttribute("data-theme");
  var now = set || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  var next = now === "dark" ? "light" : "dark";
  el.setAttribute("data-theme", next);
  try { localStorage.setItem("tb-theme", next); } catch (e) {}
});
</script>
</body></html>`;
}
