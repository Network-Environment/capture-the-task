function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const n = m.slice(1).map((p) => Number(p));
  if (n.some((x) => x > 255)) return undefined;
  return n;
}

function isBlockedIp(host: string): boolean {
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
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function assertPublicHttpUrl(raw: string): string {
  const u = new URL(String(raw ?? "").trim());
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only public http(s) URLs are allowed.");
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
    throw new Error("That host is not allowed.");
  }
  if (isBlockedIp(host)) {
    throw new Error("Private, loopback, and link-local addresses are blocked.");
  }
  return u.href;
}
