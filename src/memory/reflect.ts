import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { route } from "../services/router";
import { userBankId } from "./banks";
import { recallMemory, recallPromptBlock } from "./recall";
import { getMemoryProfile, opinionFactsForText, putMemoryFact } from "./store";
import type { MemoryFact, RecalledFact } from "./types";

export function applyOpinionConfidence(
  current: number | undefined,
  stance: "agree" | "contradict" | "new"
): number {
  const base = current ?? 0.5;
  if (stance === "agree") return Math.min(0.95, base + 0.08);
  if (stance === "contradict") return Math.max(0.15, base - 0.12);
  return 0.55;
}

export async function reflectMemory(input: {
  userId: string;
  question: string;
  updateOpinion?: boolean;
}): Promise<string> {
  const recalled = await recallMemory(input.userId, input.question);
  if (!recalled.facts.length) {
    return "I do not have retained facts that answer that yet.";
  }
  const profile = await getMemoryProfile(userBankId(input.userId));
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Answer only from recalled memory facts. Cite sources as source:sourceId. " +
        `Disposition — skepticism ${profile.skepticism}/5, literalism ${profile.literalism}/5, empathy ${profile.empathy}/5. ` +
        "If evidence is thin, say so. Do not invent work status. " +
        (input.updateOpinion
          ? 'End with a JSON line: {"opinion":{"text":"...","stance":"agree|contradict|new","entities":["org-person:..."]}} or {"opinion":null}.'
          : "Do not form a new org-wide judgment about a person."),
    },
    {
      role: "user",
      content: `FACTS:\n${recallPromptBlock(recalled)}\n\nQuestion: ${input.question}`,
    },
  ];
  const res = await route("synthesis", messages);
  const answer = res.choices[0]?.message?.content ?? "No reflection generated.";
  if (input.updateOpinion) {
    await maybeUpdateOpinion(input.userId, answer, recalled.facts).catch((err) =>
      console.error("[memory] opinion update failed (non-fatal):", err)
    );
  }
  const cites = recalled.citations.length ? `\n\nSources: ${recalled.citations.join(", ")}` : "";
  return stripOpinionJson(answer) + cites;
}

function stripOpinionJson(answer: string): string {
  return answer.replace(/\n?\{[\s\S]*"opinion"[\s\S]*\}\s*$/, "").trim();
}

async function maybeUpdateOpinion(
  userId: string,
  answer: string,
  facts: RecalledFact[]
): Promise<void> {
  const match = answer.match(/\{[\s\S]*"opinion"[\s\S]*\}/);
  if (!match) return;
  let parsed: { opinion?: { text?: string; stance?: string; entities?: string[] } | null };
  try {
    parsed = JSON.parse(match[0]) as typeof parsed;
  } catch {
    return;
  }
  if (!parsed.opinion?.text) return;
  const bankId = userBankId(userId);
  const entityIds = (parsed.opinion.entities ?? []).filter((id) => id.startsWith("org-person:"));
  const existing = entityIds.length ? await opinionFactsForText(bankId, entityIds) : [];
  const prior = existing[0];
  const stance =
    parsed.opinion.stance === "agree" || parsed.opinion.stance === "contradict"
      ? parsed.opinion.stance
      : "new";
  await putMemoryFact({
    id: prior?.id,
    bankId,
    network: "opinion",
    text: parsed.opinion.text.slice(0, 600),
    confidence: applyOpinionConfidence(prior?.confidence, stance),
    entityIds: entityIds.length ? entityIds : facts.flatMap((hit) => hit.fact.entityIds).slice(0, 8),
    source: "chat",
    sourceId: "reflect",
    mentionedAt: new Date().toISOString(),
  });
}

export function dispositionLine(profile: { skepticism: number; literalism: number; empathy: number }): string {
  return `skepticism ${profile.skepticism}/5, literalism ${profile.literalism}/5, empathy ${profile.empathy}/5`;
}
