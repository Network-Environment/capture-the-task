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
import {
  triage,
  answerQuestion,
  respondConversationally,
  runAgent,
  interpretIntent,
  TriageResult,
} from "./services/agent";
import { saveNote, recall, deleteNote } from "./services/brain";
import {
  getRecentTurns,
  appendTurn,
  getPendingClarification,
  setPendingClarification,
  isUndoCommand,
  getLastCapture,
  setLastCapture,
} from "./services/session";
import { logActivity } from "./services/activityLog";
import { handleApprovalCommand } from "./services/approvals";
import { agentProfileFor, isPmoRequest, maybeProposeSheetUpdate } from "./services/smartsheet";
import { Channel } from "./channels/types";
import { graphEnabled, searchExecutionGraph } from "./graph/store";
import { canViewMeetings } from "./meetings/access";
import {
  evaluateOperation,
  planNeedsClarification,
  type ChannelPolicy,
  type InterpretedIntent,
  type IntentPlan,
} from "./services/intent";
import { channelPolicy } from "./channels/types";
import { executeApprovedAction } from "./tools/registry";
import { claimInboundEvent, finishInboundEvent } from "./services/inboundReceipts";
import { assessInboundQuality } from "./services/inboundQuality";

export interface CaptureInput {
  userId: string; // canonical user id (Entra object id) — channels must resolve to this
  channel: Channel;
  text?: string;
  audio?: Buffer; // raw bytes of a voice memo, if any
  /** Stable source event id used for durable idempotency by channel adapters. */
  eventId?: string;
  /** Channel conversation/thread scope for follow-up state. */
  conversationId?: string;
  /** Explicit adapter capabilities. Legacy allowActions is accepted during migration. */
  policy?: ChannelPolicy;
  allowActions?: boolean;
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
  if (!input.eventId) return processCaptureCore(input);
  if (!(await claimInboundEvent(input.channel, input.eventId, input.userId))) {
    return {
      title: "Already received",
      body: "I already processed that message, so I didn't do it twice.",
      tags: [],
      summaryLine: "Duplicate message ignored",
    };
  }
  try {
    const out = await processCaptureCore(input);
    await finishInboundEvent(input.channel, input.eventId, "completed");
    return out;
  } catch (err) {
    await finishInboundEvent(input.channel, input.eventId, "failed");
    throw err;
  }
}

async function processCaptureCore(input: CaptureInput): Promise<Outbound> {
  const { userId, channel } = input;

  // 1. Resolve input text (voice → transcript) before interpreting approvals.
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

  const currentPolicy =
    input.policy ??
    channelPolicy(input.channel, { allowActions: input.allowActions ?? false });
  const approval = await handleApprovalCommand(
    userId,
    text,
    currentPolicy,
    executeApprovedAction
  );
  if (approval) {
    return { title: "Approval", body: approval, tags: [], summaryLine: approval.slice(0, 120) };
  }

  if (isUndoCommand(text)) {
    const capture = await getLastCapture(userId, input.conversationId);
    if (!capture) {
      return {
        title: "Nothing to undo",
        body: "I don’t have a recent capture in this chat to undo. Say it again if you want it filed.",
        tags: [],
        summaryLine: "Undo with no last capture",
      };
    }
    const removed = await deleteNote(userId, capture.id, capture.path);
    await setLastCapture(userId, input.conversationId, undefined);
    const body = removed
      ? `Removed **${capture.title}** from your brain. Microsoft To Do items are not reversed from chat.`
      : `I couldn’t find **${capture.title}** in the brain anymore, so there was nothing left to delete.`;
    void logActivity({
      type: "capture",
      userId,
      origin: "user_message",
      channel,
      inputMode: source,
      trigger: "undo_capture",
      detail: { noteId: capture.id, removed },
    });
    return { title: "Undone", body, tags: [], summaryLine: `Undid capture: ${capture.title}` };
  }

  const attribution = {
    origin: "user_message" as const,
    channel,
    inputMode: source,
  };
  // 2. Short follow-up window only (never the full thread).
  const recent = await getRecentTurns(userId, input.conversationId);
  let pending = await getPendingClarification(userId, input.conversationId);
  if (pending && /^(never mind|nevermind|cancel|forget (it|that))[\s.!]*$/i.test(text)) {
    await setPendingClarification(userId, input.conversationId, undefined);
    return {
      title: "Cancelled",
      body: "Got it — I dropped that unresolved request.",
      tags: [],
      summaryLine: "Cancelled pending clarification",
    };
  }
  if (pending && Date.now() - Date.parse(pending.createdAt) > 15 * 60_000) {
    await setPendingClarification(userId, input.conversationId, undefined);
    pending = undefined;
  }

  const quality = assessInboundQuality(text, recent, Boolean(pending));
  if (quality.disposition !== "proceed") {
    const response =
      quality.response ??
      "I’m not sure what outcome you want. What would you like me to do with that?";
    await appendTurn(userId, "user", text, input.conversationId, {
      intent: `quality_${quality.disposition}`,
    });
    await appendTurn(userId, "assistant", response, input.conversationId, {
      intent: `quality_${quality.disposition}`,
      outcome:
        quality.disposition === "clarify"
          ? "waiting_for_clarification"
          : quality.disposition,
    });
    if (quality.disposition === "clarify") {
      const reason =
        quality.reason === "low_signal"
          ? "nonsense"
          : quality.reason === "repeated_unresolved"
            ? "repeated"
            : "insufficient_context";
      const clarificationPlan: IntentPlan = {
        disposition: "clarify",
        reason,
        confidence: 1,
        assumptions: [],
        clarification: response,
        intents: [
          {
            kind: "clarify",
            standalone: text,
            confidence: 1,
            explicit: false,
            question: response,
          },
        ],
      };
      await setPendingClarification(userId, input.conversationId, {
        plan: clarificationPlan,
        originalText: text,
        question: response,
        createdAt: new Date().toISOString(),
      });
    }
    void logActivity({
      type: "inbound_quality",
      userId,
      ...attribution,
      trigger: "inbound_quality_gate",
      detail: {
        disposition: quality.disposition,
        reason: quality.reason,
      },
    });
    const title =
      quality.disposition === "help"
        ? "TaskBrain"
        : quality.disposition === "refuse"
          ? "I can’t do that"
          : "Quick clarification";
    return { title, body: response, tags: [], summaryLine: response.slice(0, 200) };
  }

  void logActivity({
    type: "capture",
    userId,
    ...attribution,
    detail: { source, channel, chars: text.length },
  });

  const shadow = process.env.INTENT_SHADOW_MODE !== "false";
  const enabled = process.env.INTENT_GATEWAY_ENABLED !== "false";
  let plan: IntentPlan | undefined;
  if (enabled || shadow) {
    const interpretationText = pending
      ? `Pending original request: ${pending.originalText}\nPending question: ${pending.question}\nCurrent message: ${text}`
      : text;
    try {
      plan = await interpretIntent(interpretationText, recent, attribution);
    } catch (err) {
      if (!shadow) throw err;
      console.error("[intent] shadow interpretation failed:", err);
    }
  }
  if (plan) {
    void logActivity({
      type: "intent",
      userId,
      ...attribution,
      trigger: shadow ? "intent_shadow" : "intent_interpretation",
      detail: {
        confidenceBand: plan.confidence >= 0.9 ? "high" : plan.confidence >= 0.72 ? "medium" : "low",
        kinds: plan.intents.map((i) => i.kind),
        ambiguous: planNeedsClarification(plan),
        assumptions: plan.assumptions.length,
      },
    });
    if (plan.disposition === "help" || plan.disposition === "refuse") {
      void logActivity({
        type: "inbound_quality",
        userId,
        ...attribution,
        trigger: "quality_intent_disagreement",
        detail: {
          quality: "proceed",
          intent: plan.disposition,
          reason: plan.reason,
        },
      });
    }
  }

  if (enabled && !shadow && plan) {
    await appendTurn(userId, "user", text, input.conversationId, {
      intent: plan.intents.map((i) => i.kind).join(","),
    });
    if (plan.disposition === "help" || plan.disposition === "refuse") {
      if (pending && !plan.continuesPending) {
        await setPendingClarification(userId, input.conversationId, undefined);
      }
      const response =
        plan.response ??
        (plan.disposition === "refuse"
          ? "I can’t help with that request, but I can help with a safe alternative."
          : "I can help capture tasks and ideas, recall notes, or work with enabled systems.");
      await appendTurn(userId, "assistant", response, input.conversationId, {
        intent: plan.disposition,
        outcome: plan.disposition,
      });
      void logActivity({
        type: "inbound_quality",
        userId,
        ...attribution,
        trigger: "intent_disposition",
        detail: { disposition: plan.disposition, reason: plan.reason },
      });
      return {
        title: plan.disposition === "refuse" ? "I can’t do that" : "TaskBrain",
        body: response,
        tags: [],
        summaryLine: response.slice(0, 200),
      };
    }
    if (
      planNeedsClarification(plan) &&
      process.env.CLARIFICATION_ENFORCEMENT_ENABLED === "true"
    ) {
      const question =
        plan.clarification ??
        plan.intents.find((i) => i.question)?.question ??
        plan.intents.find((i) => i.ambiguity)?.ambiguity ??
        "What would you like me to do with that?";
      await setPendingClarification(userId, input.conversationId, {
        plan,
        originalText:
          pending && plan.continuesPending ? pending.originalText : text,
        question,
        createdAt: new Date().toISOString(),
      });
      await appendTurn(userId, "assistant", question, input.conversationId, {
        intent: "clarify",
        outcome: "waiting_for_clarification",
      });
      void logActivity({
        type: "clarification",
        userId,
        ...attribution,
        trigger: "intent_ambiguity",
        detail: {
          reason: plan.intents.find((i) => i.ambiguity)?.ambiguity ?? "low_confidence",
        },
      });
      return { title: "Quick clarification", body: question, tags: [], summaryLine: question };
    }
    if (pending) await setPendingClarification(userId, input.conversationId, undefined);
    const out = await executePlan(input, plan, recent, source);
    await appendTurn(userId, "assistant", out.summaryLine, input.conversationId, {
      intent: plan.intents.map((i) => i.kind).join(","),
      outcome: out.summaryLine,
    });
    return out;
  }

  // 3. Triage on the cheap tier.
  const result = await triage(text, recent, attribution);
  const kind =
    (result.kind === "question" || result.kind === "conversation") && isPmoRequest(text)
      ? ({ kind: "action" } as TriageResult)
      : result;
  if (shadow && plan) {
    void logActivity({
      type: "intent",
      userId,
      ...attribution,
      trigger: "intent_shadow_comparison",
      detail: {
        legacyKind: kind.kind,
        proposedKinds: plan.intents.map((i) => i.kind),
        wouldClarify: planNeedsClarification(plan),
        mismatch: !legacyMatchesPlan(kind.kind, plan),
      },
    });
  }
  await appendTurn(userId, "user", text, input.conversationId);

  const captureKinds = new Set(["task", "idea", "reference"]);
  if (
    process.env.LEGACY_TRIAGE_WRITES_ENABLED !== "true" &&
    (captureKinds.has(kind.kind) || kind.kind === "followup")
  ) {
    const body =
      "I didn’t save that automatically. Tell me if this is a task, an idea, or a question — or prefix it with `task:` / `idea:`.";
    await appendTurn(userId, "assistant", body, input.conversationId, {
      intent: "clarify",
      outcome: "legacy_triage_write_blocked",
    });
    void logActivity({
      type: "triage",
      userId,
      ...attribution,
      trigger: "legacy_triage_write_blocked",
      detail: { kind: kind.kind },
    });
    return {
      title: "Quick clarification",
      body,
      tags: [],
      summaryLine: body,
    };
  }

  // 4. Execute.
  const out = await execute(input, text, source, kind, recent);
  await appendTurn(userId, "assistant", out.summaryLine, input.conversationId);
  return out;
}

function legacyMatchesPlan(kind: TriageResult["kind"], plan: IntentPlan): boolean {
  if (plan.intents.length !== 1) return false;
  const proposed = plan.intents[0];
  if (kind === "conversation") return proposed.kind === "respond";
  if (kind === "question") return proposed.kind === "read";
  if (kind === "action") return proposed.kind === "act";
  if (kind === "followup") return proposed.kind === "clarify";
  return proposed.kind === "capture" && proposed.captureKind === kind;
}

async function executePlan(
  input: CaptureInput,
  plan: IntentPlan,
  recent: Awaited<ReturnType<typeof getRecentTurns>>,
  source: "text" | "voice"
): Promise<Outbound> {
  const outputs: Outbound[] = [];
  for (const intent of plan.intents) {
    outputs.push(await executeIntent(input, intent, recent, source));
  }
  if (outputs.length === 1) return outputs[0];
  return {
    title: "Done",
    body: outputs.map((o) => `**${o.title}**\n${o.body}`).join("\n\n"),
    tags: [...new Set(outputs.flatMap((o) => o.tags))],
    summaryLine: outputs.map((o) => o.summaryLine).join("; ").slice(0, 500),
  };
}

async function executeIntent(
  input: CaptureInput,
  intent: InterpretedIntent,
  recent: Awaited<ReturnType<typeof getRecentTurns>>,
  source: "text" | "voice"
): Promise<Outbound> {
  const policy =
    input.policy ??
    channelPolicy(input.channel, { allowActions: input.allowActions ?? false });
  const auth = { explicit: intent.explicit, confidence: intent.confidence, channel: policy };
  if (intent.kind === "respond") {
    return execute(input, intent.standalone, source, { kind: "conversation" }, recent);
  }
  if (intent.kind === "read") {
    if (isPmoRequest(intent.standalone)) {
      const result = await runAgent(
        {
          userId: input.userId,
          conversationRef: input.conversationRef,
          origin: "user_message",
          channel: input.channel,
          inputMode: source,
          authorization: auth,
        },
        intent.standalone,
        "pmo",
        recent
      );
      return { title: "TaskBrain", body: result, tags: [], summaryLine: result.slice(0, 500) };
    }
    return execute(input, intent.standalone, source, { kind: "question" }, recent);
  }
  if (intent.kind === "capture") {
    const decision = evaluateOperation(
      { name: `capture_${intent.captureKind}`, effect: "personal_write", reversible: true, description: "Save personal capture" },
      auth
    );
    void logActivity({
      type: "policy",
      userId: input.userId,
      origin: "user_message",
      channel: input.channel,
      inputMode: source,
      trigger: "capture_policy",
      detail: {
        effect: "personal_write",
        decision: decision.decision,
        confidenceBand: intent.confidence >= 0.9 ? "high" : intent.confidence >= 0.72 ? "medium" : "low",
      },
    });
    if (decision.decision !== "execute") {
      return {
        title: "Need clarification",
        body: decision.reason,
        tags: [],
        summaryLine: decision.reason,
      };
    }
    const common = {
      title: intent.title || intent.standalone.slice(0, 80),
      detail: intent.detail ?? intent.standalone,
      tags: intent.tags ?? [],
    };
    if (intent.captureKind === "task") {
      return execute(
        input,
        intent.standalone,
        source,
        { kind: "task", ...common, due: intent.due },
        recent,
        false
      );
    }
    return execute(input, intent.standalone, source, {
      kind: intent.captureKind ?? "reference",
      ...common,
      links: intent.links ?? [],
    }, recent);
  }
  if (intent.kind === "act") {
    if (!policy.allowPersonalWrites && !policy.allowSharedWrites) {
      return {
        title: "Not executed",
        body: "Actions are not enabled for this channel or conversation.",
        tags: [],
        summaryLine: "Action blocked by channel policy",
      };
    }
    const result = await runAgent(
      {
        userId: input.userId,
        conversationRef: input.conversationRef,
        origin: "user_message",
        channel: input.channel,
        inputMode: source,
        authorization: auth,
      },
      intent.standalone,
      agentProfileFor("action", intent.standalone),
      recent
    );
    return { title: "TaskBrain", body: result, tags: [], summaryLine: result.slice(0, 500) };
  }
  return {
    title: "Quick clarification",
    body: intent.question ?? intent.ambiguity ?? "What would you like me to do?",
    tags: [],
    summaryLine: "Waiting for clarification",
  };
}

async function execute(
  input: CaptureInput,
  text: string,
  source: "text" | "voice",
  r: TriageResult,
  recent: Awaited<ReturnType<typeof getRecentTurns>>,
  allowInferredSheetProposal = false
): Promise<Outbound> {
  const { userId } = input;
  const effectivePolicy =
    input.policy ??
    channelPolicy(input.channel, { allowActions: input.allowActions ?? false });
  const attribution = {
    origin: "user_message" as const,
    channel: input.channel,
    inputMode: source,
  };

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
        await saveNote(
        userId,
        { kind: "task", title: r.title, body: r.detail || text, tags: r.tags, source },
        attribution
      ).then((saved) =>
        setLastCapture(userId, input.conversationId, {
          id: saved.id,
          path: saved.path,
          title: r.title,
          createdAt: new Date().toISOString(),
        })
      );
      if (allowInferredSheetProposal && effectivePolicy.allowSharedWrites) {
        const proposed = await maybeProposeSheetUpdate(userId, {
          title: r.title,
          detail: r.detail,
          due: r.due,
        });
        if (proposed) line += proposed;
      }
      return { title: "Task captured", body: line, tags: r.tags, summaryLine: `Filed task: ${r.title}` };
    }

    case "idea":
    case "reference": {
      const { path, id } = await saveNote(
        userId,
        {
          kind: r.kind,
          title: r.title,
          body: r.detail || text,
          tags: r.tags,
          links: r.links,
          source,
        },
        attribution
      );
      await setLastCapture(userId, input.conversationId, {
        id,
        path,
        title: r.title,
        createdAt: new Date().toISOString(),
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
      const [hits, graph] = await Promise.all([
        recall(userId, text, 8, attribution),
        graphEnabled() && canViewMeetings(userId)
          ? searchExecutionGraph(text, userId, { limit: 24, depth: 1 }, attribution).catch(
              (err) => {
                console.error("[graph] question recall failed (non-fatal):", err);
                return undefined;
              }
            )
          : undefined,
      ]);
      const graphContext = graph?.nodes.length
        ? [
            ...graph.nodes.map(
              (node) =>
                `${node.id} | ${node.type} | ${node.status ?? "n/a"} | ${node.title}` +
                `${node.due ? ` | due ${node.due}` : ""}` +
                `${node.description ? `\n${node.description}` : ""}`
            ),
            ...graph.edges.map(
              (edge) => `${edge.fromId} -[${edge.type}]-> ${edge.toId}`
            ),
          ].join("\n")
        : "";
      const answer = await answerQuestion(text, hits, attribution, graphContext, recent);
      return { title: "From your brain", body: answer, tags: [], summaryLine: answer.slice(0, 200) };
    }

    case "conversation": {
      const response = await respondConversationally(text, recent, attribution);
      return {
        title: "TaskBrain",
        body: response,
        tags: [],
        summaryLine: response.slice(0, 200),
      };
    }

    case "action": {
      if (!effectivePolicy.allowPersonalWrites && !effectivePolicy.allowSharedWrites) {
        return {
          title: "Not executed",
          body:
            "Actions (Smartsheet, scheduling, tools) aren't enabled on this channel. " +
            "I did not save a pending-action note. Run it from Teams to execute.",
          tags: ["pending-action"],
          summaryLine: "Action deferred (channel policy)",
        };
      }
      const result = await runAgent(
        {
          userId,
          conversationRef: input.conversationRef,
          ...attribution,
          authorization: {
            explicit: true,
            confidence: 1,
            channel: effectivePolicy,
          },
        },
        text,
        agentProfileFor("action", text),
        recent
      );
      return { title: "Done", body: result, tags: [], summaryLine: result.slice(0, 200) };
    }

    case "followup": {
      const resolved = await triage(r.resolvedText, recent, attribution);
      if (resolved.kind === "followup") {
        return {
          title: "Need more context",
          body: "I couldn't tell what that follow-up refers to — the window may have expired. Say it as a full thought and I'll file it.",
          tags: [],
          summaryLine: "Follow-up unresolved",
        };
      }
      return execute(input, r.resolvedText, source, resolved, recent, allowInferredSheetProposal);
    }
  }
}
