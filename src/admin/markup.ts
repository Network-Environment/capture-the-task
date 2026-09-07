/** Shared admin HTML helpers and chrome. Zero frontend build. */

export type Tone = "ok" | "warn" | "err" | "info" | "idle" | "accent";

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export function pill(label: string, tone: Tone): string {
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

export function table(cols: string[], rows: string, empty: string): string {
  const head = cols.map((c) => `<th>${c}</th>`).join("");
  return (
    `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${
      rows || `<tr><td class="empty" colspan="${cols.length}">${empty}</td></tr>`
    }</tbody></table></div>`
  );
}

export function countTable(title: string, map: Record<string, number>, empty: string): string {
  const rows = Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, n]) =>
        `<tr><td class="mono strong">${esc(k)}</td><td class="num">${n.toLocaleString()}</td></tr>`
    )
    .join("");
  return `<section class="panel"><h2>${esc(title)}</h2>${table(["Key", "<span class='num'>Count</span>"], rows, empty)}</section>`;
}

export const SECTIONS = [
  { id: "overview", href: "/admin", label: "Overview" },
  { id: "capabilities", href: "/admin/capabilities", label: "Capabilities" },
  { id: "integrations", href: "/admin/integrations", label: "Integrations" },
  { id: "usage", href: "/admin/usage", label: "Usage" },
  { id: "meetings", href: "/admin/meetings", label: "Meetings" },
  { id: "jobs", href: "/admin/jobs", label: "Jobs" },
  { id: "memory", href: "/admin/memory", label: "Memory" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export function isSection(s: string): s is SectionId {
  return SECTIONS.some((x) => x.id === s);
}

export function tabs(base: string, items: { id: string; label: string }[], current: string): string {
  return `<nav class="tabs">${items
    .map((t) => {
      const on = t.id === current ? " on" : "";
      return `<a class="tab${on}" href="${esc(base)}?tab=${esc(t.id)}">${esc(t.label)}</a>`;
    })
    .join("")}</nav>`;
}

function initials(name: string): string {
  const parts = name.replace(/@.*$/, "").split(/[.\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function renderShell(opts: {
  section: string;
  signedIn: string;
  title: string;
  subtitle: string;
  body: string;
  notFound?: boolean;
}): string {
  const { signedIn, title, subtitle, body } = opts;
  const nav = SECTIONS.map((s) => {
    const on = s.id === opts.section ? " on" : "";
    return `<a class="nav-item${on}" href="${s.href}">${esc(s.label)}</a>`;
  }).join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(title)} · TaskBrain admin</title>
<script>(function(){try{var t=localStorage.getItem("tb-theme");if(t){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();</script>
<style>${ADMIN_CSS}</style></head><body>
<header><div class="head-in">
  <div class="brand">
    <div class="logo">TB</div>
    <div>
      <h1>TaskBrain</h1>
      <p>${esc(subtitle)}</p>
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
<div class="app">
  <aside class="sidebar">
    <p class="nav-label">Portal</p>
    ${nav}
  </aside>
  <main>${opts.notFound ? `<section class="panel"><h2>Not found</h2><p class="pad muted">Unknown section.</p></section>` : body}</main>
</div>
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

const ADMIN_CSS = `
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
  --radius:14px; --sidebar:220px;
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
.pad{padding:1rem 1.15rem}

header{
  position:sticky;top:0;z-index:10;
  background:color-mix(in srgb,var(--bg) 82%,transparent);
  backdrop-filter:saturate(180%) blur(12px);
  border-bottom:1px solid var(--border);
}
.head-in{margin:0 auto;padding:.85rem 1.5rem;display:flex;align-items:center;gap:1rem}
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

.app{display:flex;align-items:flex-start;min-height:calc(100vh - 58px)}
.sidebar{
  position:sticky;top:58px;flex:none;width:var(--sidebar);
  padding:1.1rem .85rem 3rem;border-right:1px solid var(--border);
  min-height:calc(100vh - 58px);
}
.nav-label{
  margin:0 .55rem .45rem;font-size:11px;font-weight:650;letter-spacing:.08em;
  text-transform:uppercase;color:var(--muted);
}
.nav-item{
  display:block;padding:.45rem .7rem;border-radius:10px;color:var(--muted);
  text-decoration:none;font-size:13.5px;font-weight:550;margin-bottom:2px;
}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item.on{background:var(--accent-soft);color:var(--accent)}
main{flex:1;min-width:0;padding:1.4rem 1.5rem 4rem;max-width:1080px}

.lede{margin:0 0 1.15rem;color:var(--muted);font-size:13.5px;max-width:62ch}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.85rem;margin-bottom:1.4rem}
.stat{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:.95rem 1.1rem;box-shadow:var(--shadow);
}
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

.tabs{display:flex;gap:.35rem;margin:0 0 1.1rem;flex-wrap:wrap}
.tab{
  padding:.35rem .85rem;border-radius:99px;text-decoration:none;font-size:13px;font-weight:600;
  color:var(--muted);border:1px solid var(--border);background:var(--surface);
}
.tab:hover{color:var(--text)}
.tab.on{background:var(--accent-soft);color:var(--accent);border-color:transparent}

.cards{display:grid;gap:.85rem;margin-bottom:1.2rem}
.card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:1rem 1.15rem;box-shadow:var(--shadow);
}
.card h3{margin:0 0 .35rem;font-size:1rem}
.card p{margin:0;font-size:13.5px;color:var(--muted)}
.card .meta{margin-top:.55rem;display:flex;flex-wrap:wrap;gap:.35rem}

.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{
  text-align:left;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--muted);padding:.6rem 1.15rem;border-bottom:1px solid var(--border);white-space:nowrap;
}
td{padding:.6rem 1.15rem;border-bottom:1px solid color-mix(in srgb,var(--border) 60%,transparent);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
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

@media (max-width:860px){
  .app{flex-direction:column}
  .sidebar{
    position:static;width:100%;min-height:0;border-right:0;border-bottom:1px solid var(--border);
    padding:.7rem 1rem;display:flex;flex-wrap:nowrap;overflow-x:auto;gap:.25rem;align-items:center;
  }
  .nav-label{display:none}
  .nav-item{flex:none;margin:0;white-space:nowrap}
  main{padding:1.1rem 1rem 3rem}
}
@media (max-width:640px){
  .head-in{padding:.7rem 1rem;gap:.6rem}
  .brand p,.live{display:none}
  td,th{padding:.55rem .8rem}
  td.clip{max-width:200px}
}
`;
