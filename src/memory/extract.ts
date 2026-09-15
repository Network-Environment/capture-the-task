import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { route } from "../services/router";
import type { ExtractedFact, MemoryNetwork } from "./types";

const NETWORKS = new Set<MemoryNetwork>(["world", "experience", "opinion", "observation"]);

export function parseRetainPayload(raw: string): ExtractedFact[] {
  const json = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: { facts?: unknown };
  try {
    parsed = JSON.parse(json) as { facts?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.facts)) return [];
  return parsed.facts
    .map((item) => normalizeExtracted(item))
    .filter((item): item is ExtractedFact => Boolean(item));
}

function normalizeExtracted(item: unknown): ExtractedFact | undefined {
  if (!item || typeof item !== "object") return undefined;
  const row = item as Record<string, unknown>;
  const text = String(row.text ?? "").trim();
  const network = String(row.network ?? "") as MemoryNetwork;
  if (!text || !NETWORKS.has(network)) return undefined;
  const entities = Array.isArray(row.entities)
    ? row.entities.map((value) => String(value).trim()).filter(Boolean).slice(0, 8)
    : [];
  const confidence =
    typeof row.confidence === "number" && row.confidence >= 0 && row.confidence <= 1
      ? row.confidence
      : undefined;
  return {
    text: text.slice(0, 600),
    network,
    validFrom: isoOrUndefined(row.validFrom),
    validTo: isoOrUndefined(row.validTo),
    mentionedAt: isoOrUndefined(row.mentionedAt),
    entities,
    confidence,
    orgRelevant: row.orgRelevant === true,
  };
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export async function extractNarrativeFacts(chunk: string): Promise<ExtractedFact[]> {
  const text = chunk.trim().slice(0, 6_000);
  if (!text) return [];
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Extract 2-5 self-contained narrative facts from the text. " +
        "Each fact must stand alone without pronouns that need the rest of the chunk. " +
        "network: world (objective shared events/decisions), experience (first-person history), " +
        "opinion (a belief), observation (preference-neutral entity summary). " +
        "Set orgRelevant true only for world facts that matter to the organization, not private chores. " +
        "Include ISO occurrence interval when dates exist. " +
        'Output ONLY JSON: {"facts":[{"text":"...","network":"world","validFrom":null,"validTo":null,' +
        '"mentionedAt":"ISO","entities":["Name"],"confidence":0.8,"orgRelevant":false}]}',
    },
    { role: "user", content: text },
  ];
  try {
    const res = await route("triage", messages, { json: true });
    return parseRetainPayload(res.choices[0]?.message?.content ?? "").slice(0, 5);
  } catch (err) {
    console.error("[memory] fact extract failed (non-fatal):", err);
    return [];
  }
}

export function parseQueryWindow(query: string, now = new Date()): { from?: string; to?: string } {
  const iso = [...query.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
  if (iso.length >= 2) return { from: iso[0], to: iso[1] };
  if (iso.length === 1) return { from: iso[0], to: iso[0] };
  const lower = query.toLowerCase();
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const today = startOfDay(now);
  if (/\byesterday\b/.test(lower)) {
    const y = new Date(today.getTime() - 86_400_000);
    return { from: y.toISOString().slice(0, 10), to: y.toISOString().slice(0, 10) };
  }
  if (/\blast week\b/.test(lower)) {
    const from = new Date(today.getTime() - 7 * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
  }
  if (/\bthis month\b/.test(lower)) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
  }
  return {};
}

export function intervalsOverlap(
  factFrom: string | undefined,
  factTo: string | undefined,
  windowFrom: string,
  windowTo: string
): boolean {
  const start = (factFrom ?? factTo ?? "").slice(0, 10);
  const end = (factTo ?? factFrom ?? "").slice(0, 10);
  if (!start && !end) return false;
  const a = start || end;
  const b = end || start;
  return a <= windowTo && b >= windowFrom;
}
