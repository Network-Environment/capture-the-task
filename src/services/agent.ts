/**
 * The agent brain — router-driven, tool-capable, profile-based.
 *
 * Profiles (config/agents.json) are personas-as-data: persona prompt + tool
 * allowlist + model route. One agent loop serves all of them today; each
 * profile lifts out to its own worker if true multi-agent is ever needed.
 *
 * Two memories, deliberately separate:
 *  - the user's second brain (brain.ts): THEIR knowledge, retrieved on demand
 *  - agent self-memory (agentMemory.ts): the agent's operational lessons,
 *    injected into every agent prompt
 */
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { route, routeWithEscalation, TaskClass } from "./router";
import { allToolDefinitions, dispatch, ToolContext } from "../tools/registry";
import { lessonsPromptBlock } from "./agentMemory";
import { logActivity, type ActivityAttribution } from "./activityLog";
import { RecallHit } from "./brain";
import { SessionTurn } from "./session";
import { loadConfig } from "../config";
import { catalogPromptBlock } from "./smartsheet";
import { orgPromptBlock } from "../org/store";
const agentsConfig = loadConfig<{ default: string; profiles: Record<string, unknown> }>("agents");

export type TriageResult =
  | { kind: "task"; title: string; detail: string; due?: string; tags: string[] }
  | { kind: "idea"; title: string; detail: string; tags: string[]; links: string[] }
  | { kind: "reference"; title: string; detail: string; tags: string[]; links: string[] }
  | { kind: "question" }
  | { kind: "conversation" }
  | { kind: "action" }
  | { kind: "followup"; resolvedText: string };

const TRIAGE_SYSTEM = `You are the triage engine of a personal capture system.
Each user message is ONE capture. Classify it and extract structure. Output ONLY JSON.

Kinds:
- "task": something for the user to do later. Extract a crisp imperative title
  (<=10 words), detail, optional due (ISO date; "by Friday" -> next Friday;
  today is {{TODAY}}), tags.
- "idea": a thought/concept to keep. title, detail, tags, links (existing-topic
  names worth wikilinking, lowercase-hyphenated).
- "reference": a fact, decision, or info to store. Same fields as idea.
- "question": the user asks to RECALL something from THEIR stored notes /
  second brain (what they captured earlier). Not Smartsheet, not live PMO.
- "conversation": nothing should be saved or executed. Use for greetings,
  thanks, casual conversation, general knowledge/advice, and questions that
  do not ask to recall the user's stored notes or org meeting/PMO data.
- "action": the user asks the SYSTEM to do something now or on a schedule —
  operate on Smartsheet/PMO (status, risks, rows, workspaces), look up live
  sheet data, update or add sheet rows, create or manage scheduled jobs,
  org meeting/commitment questions, correct the agent's behavior
  ("stop doing X", "X means Y"), or any multi-step request. No extraction needed.
- "followup": only makes sense relative to the recent turns provided. Rewrite
  as resolvedText — a complete standalone instruction. If no recent turns
  match, return followup with resolvedText equal to the raw message.

Rules: do not treat greetings or casual chat as ideas/references. If there is
no clear reason to persist or act, choose conversation. Questions about org
meetings, decisions, commitments, Smartsheet, risk registers, project trackers,
or PMO status are actions (live tools), not question. "What did I capture
about X" is question. Never invent deadlines. Voice transcripts ramble —
extract, don't copy.
Tags: 1-4, lowercase, no spaces. JSON only, no markdown fences.`;

const TRIAGE_KINDS = new Set([
  "task",
  "idea",
  "reference",
  "question",
  "conversation",
  "action",
  "followup",
]);

export function normalizeTriageResult(raw: string): TriageResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!TRIAGE_KINDS.has(String(parsed.kind))) return { kind: "conversation" };
    if (
      ["task", "idea", "reference"].includes(String(parsed.kind)) &&
      (typeof parsed.title !== "string" || !parsed.title.trim())
    ) {
      return { kind: "conversation" };
    }
    if (
      parsed.kind === "followup" &&
      (typeof parsed.resolvedText !== "string" || !parsed.resolvedText.trim())
    ) {
      return { kind: "conversation" };
    }
    parsed.tags ??= [];
    parsed.links ??= [];
    parsed.detail ??= "";
    return parsed as unknown as TriageResult;
  } catch {
    // An uncertain classifier must never create a durable artifact by default.
    return { kind: "conversation" };
  }
}

export async function triage(
  text: string,
  recent: SessionTurn[],
  attribution: Partial<ActivityAttribution> = {}
): Promise<TriageResult> {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: TRIAGE_SYSTEM.replace("{{TODAY}}", new Date().toISOString().slice(0, 10)),
    },
  ];
  if (recent.length) {
    messages.push({
      role: "user",
      content:
        "Recent turns (follow-up window):\n" +
        recent.map((t) => `${t.role}: ${t.text}`).join("\n"),
    });
  }
  messages.push({ role: "user", content: `Capture:\n${text}` });

  const res = await routeWithEscalation("triage", messages, {
    json: true,
    attribution: { ...attribution, trigger: "triage" },
  }, (content) => {
    if (!content) return true;
    try { JSON.parse(content); return false; } catch { return true; }
  });

  const raw = res.choices[0]?.message?.content ?? "{}";
  const result = normalizeTriageResult(raw);
  void logActivity({
    type: "triage",
    ...attribution,
    trigger: "triage",
    detail: { kind: result.kind },
  });
  return result;
}

export async function respondConversationally(
  userMessage: string,
  recent: SessionTurn[],
  attribution: Partial<ActivityAttribution> = {}
): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are TaskBrain. Respond naturally and helpfully. This message was " +
        "classified as conversation, so do not claim that anything was saved, " +
        "logged, scheduled, or changed. Keep greetings and acknowledgements brief.",
    },
    ...recent.map((t) => ({ role: t.role, content: t.text }) as ChatCompletionMessageParam),
    { role: "user", content: userMessage },
  ];
  const res = await route("agent", messages, {
    attribution: { ...attribution, trigger: "conversation" },
  });
  return res.choices[0]?.message?.content ?? "Hey — what can I help with?";
}

interface AgentProfile {
  description: string;
  route: TaskClass;
  tools: "*" | string[];
  persona: string;
}

function getProfile(name?: string): { name: string; profile: AgentProfile } {
  const profiles = agentsConfig.profiles as Record<string, AgentProfile>;
  const key = name && profiles[name] ? name : (agentsConfig.default as string);
  return { name: key, profile: profiles[key] };
}

function filterTools(all: ChatCompletionTool[], allow: "*" | string[]): ChatCompletionTool[] {
  if (allow === "*") return all;
  return all.filter((t) =>
    allow.some((pattern) =>
      pattern.endsWith("*")
        ? t.function.name.startsWith(pattern.slice(0, -1))
        : t.function.name === pattern
    )
  );
}

const MAX_TOOL_ROUNDS = 8;

export async function runAgent(
  ctx: ToolContext,
  userMessage: string,
  profileName?: string
): Promise<string> {
  const { name, profile } = getProfile(profileName);
  const tools = filterTools(await allToolDefinitions(), profile.tools);
  const lessons = await lessonsPromptBlock(ctx.userId);
  const catalog = name === "pmo" || profile.tools === "*" || (Array.isArray(profile.tools) && profile.tools.some((t) => t.startsWith("smartsheet")))
    ? catalogPromptBlock()
    : "";
  const orgBlock = await orgPromptBlock(ctx.userId);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: profile.persona + lessons + catalog + orgBlock },
    { role: "user", content: userMessage },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await route(profile.route, messages, {
      tools,
      attribution: {
        origin: ctx.origin,
        channel: ctx.channel,
        inputMode: ctx.inputMode,
        trigger: ctx.trigger ?? `agent:${name}`,
      },
    });
    const msg = res.choices[0]?.message;
    if (!msg) return "The agent produced no response.";

    const calls = msg.tool_calls ?? [];
    if (!calls.length) return msg.content ?? "Done.";

    messages.push(msg as ChatCompletionMessageParam);
    for (const call of calls) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* empty */ }
      const result = await dispatch(ctx, call.function.name, args);
      void logActivity({
        type: "tool_call",
        userId: ctx.userId,
        agent: name,
        origin: ctx.origin,
        channel: ctx.channel,
        inputMode: ctx.inputMode,
        trigger: ctx.trigger ?? `agent:${name}`,
        detail: { tool: call.function.name, ok: !result.startsWith(`Tool ${call.function.name} failed`) },
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 12_000) });
    }
  }
  return "I hit my tool-call limit before finishing — the partial work is saved. Try narrowing the request.";
}

export async function answerQuestion(
  question: string,
  hits: RecallHit[],
  attribution: Partial<ActivityAttribution> = {}
): Promise<string> {
  if (!hits.length) return "Nothing in the brain matches that yet.";
  const res = await route("synthesis", [
    {
      role: "system",
      content:
        "Answer the user's question strictly from the provided notes. Cite note " +
        "titles in **bold**. If the notes don't answer it, say so. Be concise.",
    },
    {
      role: "user",
      content:
        hits
          .map((h) => `[${h.kind}] ${h.title} (${h.createdAt.slice(0, 10)}):\n${h.body}`)
          .join("\n---\n") + `\n\nQuestion: ${question}`,
    },
  ], { attribution: { ...attribution, trigger: "answer_notes" } });
  return res.choices[0]?.message?.content ?? "No answer generated.";
}
