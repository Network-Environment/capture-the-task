const MIN_WORDS = 40;
export const MAX_TRANSCRIPT_CHARS = 24_000;
export const MAX_SUMMARY_CHARS = 6_000;

export function parseVtt(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t === "WEBVTT") continue;
    if (/^\d+$/.test(t)) continue;
    if (/^\d{2}:\d{2}/.test(t)) continue;
    if (t.startsWith("NOTE")) continue;
    const spoken = t.replace(/<[^>]+>/g, "").replace(/^<v[^>]*>/, "").replace(/<\/v>$/, "");
    if (spoken) lines.push(spoken);
  }
  return lines.join("\n");
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function isTooShort(text: string): boolean {
  return wordCount(text) < MIN_WORDS;
}

export function capTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return text.slice(0, MAX_TRANSCRIPT_CHARS) + "\n[truncated]";
}

export function capSummary(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return text.slice(0, MAX_SUMMARY_CHARS);
}
