/**
 * The channel-agnostic capture pipeline.
 *
 * Every channel adapter (Teams, iMessage via Photon, future ones) normalizes
 * its inbound message into a CaptureInput, calls processCapture, and renders
 * the returned Outbound in whatever the channel supports (Adaptive Card,
 * plain text, markdown). Nothing in here knows about Bot Framework or Photon.
 *
 * Order of operations is fixed and every path ends in either a saved artifact
 * or an explicit message to the user (invariant #9).
 */
import { transcribeBuffer } from "./services/transcription";
import { triage, answerQuestion, runAgent, TriageResult } from "./services/agent";
import { saveNote, recall } from "./services/brain";
import { getRecentTurns, appendTurn } from "./services/session";
import { logActivity } from "./services/activityLog";
import { handleApprovalCommand } from "./services/approvals";
import { Channel } from "./channels/types";

export interface CaptureInput {
  userId: string; // canonical user id (Entra object id) — channels must resolve to this
  channel: Channel;
  text?: string;
  audio?: Buffer; // raw bytes of a voice memo, if any
  /** Channel policy: whether "action" captures (tools, scheduling) are allowed here. */
  allowActions: boolean;
  /**
   * Optional hook a channel can pass so task creation can use channel-bound
   * auth (Teams → Graph OAuth). Absent on channels without it; tasks then
   * fall back to the brain.
   */
  createTask?: (title: string, detail?: string, due?: string) => Promise<void>;
  /** Opaque per-channel reference stored on scheduled jobs for delivery. */
  conversationRef?: unknown;
}

export interface Outbound {
  title: string;
  body: string; // markdown-ish; channels may strip formatting
  tags: string[];
  /** Short line kept in the follow-up session window. */
  summaryLine: string;
}

export async function processCapture(input: CaptureInput): Promise<Outbound> {
  const { userId, channel } = input;

  // 0. Approval commands short-circuit everything.
  const approval = await handleApprovalCommand(userId, input.text ?? "");
  if (approval) {
    return { title: "Approval", body: approval, tags: [], summaryLine: approval.slice(0, 120) };
  }

  // 1. Resolve input text (voice → transcript).
  let text = (input.text ?? "").trim();
  let source: "text" | "voice" = "text";
  if (input.audio) {
    text = await transcribeBuffer(input.audio);
    source = "voice";
    if (!text) {
      return {
        title: "Couldn't hear that",
        body: "Couldn't make out that recording — mind trying again?",
        tags: [],
        summaryLine: "transcription empty",
      };
    }
  }
  if (!text) {
    return {
      title: "Hi",
      body: "Send me a thought — text or a voice clip — and I'll file it.",
      tags: [],
      summaryLine: "empty input",
    };
  }

  void logActivity({ type: "capture", userId, detail: { source, channel, chars: text.length } });

  // 2. Short follow-up window only (never the full thread).
  const recent = await getRecentTurns(userId);

  // 3. Triage on the cheap tier.
  const result = await triage(text, recent);
  await appendTurn(userId, "user", text);

  // 4. Execute.
  const out = await execute(input, text, source, result);
  await appendTurn(userId, "assistant", out.summaryLine);
  return out;
}

async function execute(
  input: CaptureInput,
  text: string,
  source: "text" | "voice",
  r: TriageResult
): Promise<Outbound> {
  const { userId } = input;

  switch (r.kind) {
    case "task": {
      let line = `**${r.title}**` + (r.due ? ` — due ${r.due}` : "");
      if (input.createTask) {
        try {
          await input.createTask(r.title, r.detail, r.due);
          line += "\n✓ Created in Microsoft To Do";
        } catch {
          line += "\n⚠ To Do not connected — saved to the brain instead";
        }
      } else {
        line += "\n✓ Saved to the brain (To Do available from Teams)";
      }
      await saveNote(userId, { kind: "task", title: r.title, body: r.detail || text, tags: r.tags, source });
      return { title: "Task captured", body: line, tags: r.tags, summaryLine: `Filed task: ${r.title}` };
    }

    case "idea":
    case "reference": {
      const { path } = await saveNote(userId, {
        kind: r.kind,
        title: r.title,
        body: r.detail || text,
        tags: r.tags,
        links: r.links,
        source,
      });
      const links = r.links.length ? `\nLinked: ${r.links.map((l) => `[[${l}]]`).join(", ")}` : "";
      return {
        title: r.kind === "idea" ? "Idea filed" : "Reference filed",
        body: `**${r.title}**\n\`${path}\`${links}`,
        tags: r.tags,
        summaryLine: `Filed ${r.kind}: ${r.title}`,
      };
    }

    case "question": {
      const hits = await recall(userId, text, 8);
      const answer = await answerQuestion(text, hits);
      return { title: "From your brain", body: answer, tags: [], summaryLine: answer.slice(0, 200) };
    }

    case "action": {
      if (!input.allowActions) {
        // Governance lever: some channels are capture-only.
        await saveNote(userId, { kind: "reference", title: text.slice(0, 60), body: text, tags: ["pending-action"], source });
        return {
          title: "Saved, not executed",
          body:
            "Actions (Smartsheet, scheduling, tools) aren't enabled on this channel. " +
            "I saved the request to your brain — run it from Teams to execute.",
          tags: ["pending-action"],
          summaryLine: "Action deferred (channel policy)",
        };
      }
      const result = await runAgent({ userId, conversationRef: input.conversationRef }, text);
      return { title: "Done", body: result, tags: [], summaryLine: result.slice(0, 200) };
    }

    case "followup": {
      const resolved = await triage(r.resolvedText, []);
      if (resolved.kind === "followup") {
        return {
          title: "Need more context",
          body: "I couldn't tell what that follow-up refers to — the window may have expired. Say it as a full thought and I'll file it.",
          tags: [],
          summaryLine: "Follow-up unresolved",
        };
      }
      return execute(input, r.resolvedText, source, resolved);
    }
  }
}
