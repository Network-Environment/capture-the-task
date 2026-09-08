/**
 * Public-web research helpers: search hit shaping, SSRF checks, snapshot
 * truncation, and per-turn caps. Page HTML is never persisted from here.
 */

export const MAX_SEARCHES_PER_TURN = 1;
export const MAX_BROWSER_PER_TURN = 3;
export const SEARCH_TIMEOUT_MS = 8_000;
export const NAV_TIMEOUT_MS = 20_000;
export const SNAPSHOT_MAX_CHARS = 8_000;
export const SEARCH_HIT_MIN = 5;
export const SEARCH_HIT_MAX = 8;

const BROWSER_TOOLS = new Set(["navigate", "snapshot"]);

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchBudget {
  searches: number;
  browserCalls: number;
}

export function ensureResearchBudget(ctx: { research?: ResearchBudget }): ResearchBudget {
  if (!ctx.research) ctx.research = { searches: 0, browserCalls: 0 };
  return ctx.research;
}

export function consumeSearchBudget(ctx: { research?: ResearchBudget }): string | undefined {
  const b = ensureResearchBudget(ctx);
  if (b.searches >= MAX_SEARCHES_PER_TURN) {
    return "Search cap for this turn already used. Work from the hits you have, or open a URL the user named.";
  }
  b.searches += 1;
  return undefined;
}

export function consumeBrowserBudget(ctx: { research?: ResearchBudget }): string | undefined {
  const b = ensureResearchBudget(ctx);
  if (b.browserCalls >= MAX_BROWSER_PER_TURN) {
    return "Browser cap for this turn already used (navigate + snapshot). Summarize from what you have.";
  }
  b.browserCalls += 1;
  return undefined;
}

export function isBrowserMcpTool(server: string, tool: string): boolean {
  return server === "browser" && BROWSER_TOOLS.has(tool);
}

export function clampSearchCount(count?: number): number {
  const n = Number.isFinite(count) ? Math.floor(count as number) : SEARCH_HIT_MAX;
  return Math.min(SEARCH_HIT_MAX, Math.max(SEARCH_HIT_MIN, n));
}

export function shapeSearchHits(hits: SearchHit[], max = SEARCH_HIT_MAX): string {
  const rows = hits.slice(0, max).filter((h) => h.url);
  if (!rows.length) return "No web results.";
  return rows
    .map((h, i) => {
      const snippet = (h.snippet || "").replace(/\s+/g, " ").trim().slice(0, 220);
      return `${i + 1}. ${h.title || "(untitled)"}\n   ${h.url}${snippet ? `\n   ${snippet}` : ""}`;
    })
    .join("\n");
}

export function hitsFromTavily(data: unknown): SearchHit[] {
  const results =
    (data as { results?: { title?: string; url?: string; content?: string }[] }).results ?? [];
  return results.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

export function hitsFromBrave(data: unknown): SearchHit[] {
  const results =
    (data as { web?: { results?: { title?: string; url?: string; description?: string }[] } })
      .web?.results ?? [];
  return results.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

export function hitsFromBing(data: unknown): SearchHit[] {
  const values =
    (data as { webPages?: { value?: { name?: string; url?: string; snippet?: string }[] } })
      .webPages?.value ?? [];
  return values.map((r) => ({
    title: r.name ?? "",
    url: r.url ?? "",
    snippet: r.snippet ?? "",
  }));
}

export function truncateSnapshot(text: string, max = SNAPSHOT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const n = m.slice(1).map((p) => Number(p));
  if (n.some((x) => x > 255)) return undefined;
  return n;
}

export function isBlockedIp(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) {
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
    if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  }
  const o = ipv4Octets(h);
  if (!o) return false;
  const [a, b] = o;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function parsePublicHttpUrl(raw: string): { href: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return { error: "Invalid URL." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "Only public http(s) URLs are allowed." };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return { error: "That host is not allowed." };
  }
  if (isBlockedIp(host)) {
    return { error: "Private, loopback, and link-local addresses are blocked." };
  }
  return { href: u.href };
}

export async function assertPublicHttpUrl(raw: string): Promise<{ href: string } | { error: string }> {
  const parsed = parsePublicHttpUrl(raw);
  if ("error" in parsed) return parsed;
  const host = new URL(parsed.href).hostname;
  if (ipv4Octets(host) || host.includes(":")) return parsed;

  const { lookup } = await import("node:dns/promises");
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => isBlockedIp(a.address))) {
      return { error: "Host resolves to a private or link-local address." };
    }
  } catch {
    return { error: "Could not resolve that host." };
  }
  return parsed;
}

export async function webSearch(query: string, count?: number): Promise<string> {
  const q = query.trim();
  if (!q) return "Search query was empty.";
  const key = process.env.WEB_SEARCH_API_KEY?.trim();
  if (!key) return "Web search is not configured (WEB_SEARCH_API_KEY).";

  const n = clampSearchCount(count);
  const engine = (process.env.WEB_SEARCH_ENGINE ?? "tavily").toLowerCase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    if (engine === "bing") {
      const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=${n}`;
      const res = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": key },
        signal: ctrl.signal,
      });
      if (!res.ok) return `Web search failed (${res.status}).`;
      return shapeSearchHits(hitsFromBing(await res.json()), n);
    }
    if (engine === "brave") {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`;
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": key,
        },
        signal: ctrl.signal,
      });
      if (!res.ok) return `Web search failed (${res.status}).`;
      return shapeSearchHits(hitsFromBrave(await res.json()), n);
    }
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: q,
        max_results: n,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return `Web search failed (${res.status}).`;
    return shapeSearchHits(hitsFromTavily(await res.json()), n);
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message;
    return `Web search failed: ${msg}`;
  } finally {
    clearTimeout(timer);
  }
}
