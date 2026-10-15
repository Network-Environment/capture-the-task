const SECRET = /((?:bearer|api[_-]?key|token|password|secret)\s*[:=]\s*)(\S+)|bearer\s+[a-z0-9._~+/-]{6,}/gi;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redactText(value: string): string {
  return value
    .replace(SECRET, "$1[redacted]")
    .replace(PHONE, "[phone]")
    .replace(EMAIL, "[email]")
    .replace(/sk-[a-z0-9]{8,}/gi, "[redacted]");
}

function isCredentialKey(key: string, value: unknown): boolean {
  // Usage counters such as inputTokens are not credentials.
  if (typeof value === "number" && /tokens$/i.test(key)) return false;
  return /authorization|token|secret|password|api[-_]?key|cookie/i.test(key);
}

export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactText(value).slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactUnknown(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (isCredentialKey(key, item)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactUnknown(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}
