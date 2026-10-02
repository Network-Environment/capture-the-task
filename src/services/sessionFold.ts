/**
 * Folds turns that fell off the session cap into one short summary.
 * The turn is already saved before this runs. A model failure uses a
 * deterministic fallback and never throws to the caller answering the user.
 * The summary is not retained as a memory fact.
 */
import type { Channel } from "../channels/types";
import { route } from "./router";
import {
  SUMMARY_CAP,
  appendTurn,
  commitThreadSummary,
  fallbackSummary,
  type AppendResult,
  type SessionTurn,
} from "./session";

const FOLD_INSTRUCTION =
  "Rewrite the existing summary and the dropped turns into at most 120 words. " +
  "Keep names, decisions, open questions, and what was filed. Drop greetings. " +
  "Add nothing that is not already in the summary or the dropped turns. " +
  "Output plain text only.";

export async function foldDroppedTurns(input: {
  userId: string;
  conversationId: string;
  previousSummary?: string;
  dropped: SessionTurn[];
}): Promise<void> {
  if (!input.dropped.length) return;
  let summary = fallbackSummary(input.previousSummary, input.dropped);
  try {
    const dropped = input.dropped
      .map((turn) => `${turn.role}: ${(turn.body ?? turn.text).replace(/\s+/g, " ").trim()}`)
      .join("\n");
    const res = await route(
      "triage",
      [
        { role: "system", content: FOLD_INSTRUCTION },
        {
          role: "user",
          content: `Existing summary:\n${input.previousSummary?.trim() || "(none)"}\n\nDropped turns:\n${dropped}`,
        },
      ],
      { attribution: { origin: "system", channel: "internal", trigger: "session_condense" } }
    );
    const text = res.choices[0]?.message?.content?.trim();
    if (text) summary = text.slice(0, SUMMARY_CAP);
  } catch (err) {
    console.error("[session] condense failed; keeping the trimmed fallback:", err);
  }
  try {
    const saved = await commitThreadSummary(
      input.userId,
      input.conversationId,
      summary,
      input.previousSummary,
      input.dropped
    );
    if (!saved) console.error("[session] condensed summary was not saved");
  } catch (err) {
    console.error("[session] condensed summary write failed:", err);
  }
}

async function foldIfNeeded(userId: string, result: AppendResult): Promise<void> {
  if (!result.dropped.length || !result.storedConversationId) return;
  await foldDroppedTurns({
    userId,
    conversationId: result.storedConversationId,
    previousSummary: result.previousSummary,
    dropped: result.dropped,
  });
}

export async function recordConversationTurn(input: {
  userId: string;
  role: "user" | "assistant";
  text: string;
  conversationId?: string;
  scope: "private" | "group";
  channel?: Channel;
  intent?: string;
  outcome?: string;
  references?: string[];
  body?: string;
}): Promise<void> {
  try {
    const result = await appendTurn(input.userId, input.role, input.text, input.conversationId, {
      scope: input.scope,
      channel: input.channel,
      intent: input.intent,
      outcome: input.outcome,
      references: input.references,
      body: input.body,
    });
    await foldIfNeeded(input.userId, result);
  } catch (err) {
    console.error("[session] record failed:", err);
  }
}
