import { route } from "../services/router";
import { capSummary } from "./vtt";
import type { MeetingSummary } from "./types";

const EMPTY: MeetingSummary = {
  title: "Untitled meeting",
  categories: [],
  summary: "",
  decisions: [],
  actions: [],
  risks: [],
  openQuestions: [],
  attendees: [],
};

export function parseMeetingSummary(raw: string): MeetingSummary | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<MeetingSummary>;
    if (!parsed.summary && !parsed.title) return undefined;
    return {
      title: capSummary(String(parsed.title || EMPTY.title)).slice(0, 180),
      categories: arr(parsed.categories).slice(0, 8),
      summary: capSummary(String(parsed.summary ?? "")),
      decisions: arr(parsed.decisions).slice(0, 12),
      actions: (Array.isArray(parsed.actions) ? parsed.actions : [])
        .slice(0, 20)
        .map((a) => ({
          text: capSummary(String(a.text ?? "")).slice(0, 280),
          ownerName: String(a.ownerName ?? "unassigned").slice(0, 80),
          ownerId: a.ownerId ? String(a.ownerId) : undefined,
          due: a.due ? String(a.due).slice(0, 32) : undefined,
        }))
        .filter((a) => a.text),
      risks: arr(parsed.risks).slice(0, 8),
      openQuestions: arr(parsed.openQuestions).slice(0, 8),
      attendees: arr(parsed.attendees).slice(0, 30),
    };
  } catch {
    return undefined;
  }
}

function arr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).slice(0, 240)).filter(Boolean);
}

export async function summarizeTranscript(input: {
  transcript: string;
  titleHint?: string;
  organizerName?: string;
}): Promise<MeetingSummary> {
  const res = await route(
    "synthesis",
    [
      {
        role: "system",
        content:
          "You extract org situational awareness from a Teams meeting transcript. " +
          "Focus on decisions, commitments (who will do what by when), risks, and open questions. " +
          "Be concrete; do not invent attendees or owners. Output ONLY JSON: " +
          '{"title":"","categories":[],"summary":"","decisions":[],' +
          '"actions":[{"text":"","ownerName":"","due":""}],"risks":[],"openQuestions":[],"attendees":[]}',
      },
      {
        role: "user",
        content:
          `Organizer: ${input.organizerName ?? "unknown"}\n` +
          `Title hint: ${input.titleHint ?? "none"}\n\n${input.transcript}`,
      },
    ],
    {
      json: true,
      attribution: {
        origin: "admin_summary",
        channel: "internal",
        trigger: "meeting_summary",
      },
    }
  );
  return parseMeetingSummary(res.choices[0]?.message?.content ?? "") ?? {
    ...EMPTY,
    title: input.titleHint ?? EMPTY.title,
    summary: "Could not structure this meeting.",
  };
}
