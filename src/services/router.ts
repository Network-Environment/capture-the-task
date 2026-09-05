/**
 * Model router. Every LLM call in the system goes through route(), which maps
 * a task class to a Foundry deployment via config/model.routes.json.
 * Deployment names live in env vars, so retiering (e.g. moving triage from a
 * mini model to Haiku-class) is an app-setting change with no redeploy.
 */
import { AzureOpenAI } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { loadConfig } from "../config";
const routesConfig = loadConfig<{ routes: Record<string, unknown>; escalation?: { from: string; to: string } }>("model.routes");
import { logActivity, dayStats } from "./activityLog";
import { alertAdmin } from "./alerts";

export type TaskClass = "triage" | "agent" | "synthesis" | "digest";

const client = new AzureOpenAI({
  endpoint: process.env.FOUNDRY_ENDPOINT!,
  apiKey: process.env.FOUNDRY_API_KEY!,
  apiVersion: "2024-10-21",
});

interface RouteSpec {
  deployment: string; // env var NAME holding the deployment
  maxTokens: number;
  temperature: number;
}

function spec(task: TaskClass): RouteSpec & { model: string } {
  const r = (routesConfig.routes as Record<string, RouteSpec>)[task];
  if (!r) throw new Error(`no route for task class ${task}`);
  const model = process.env[r.deployment];
  if (!model) throw new Error(`env var ${r.deployment} not set`);
  return { ...r, model };
}

/**
 * Daily token budget guard. When today's total tokens exceed
 * DAILY_TOKEN_BUDGET, non-triage calls are downgraded to the cheap tier for
 * the rest of the day (triage already runs cheap) and the admin is alerted
 * once. Counter refreshes from the activity log every 5 minutes so restarts
 * and scale-out don't reset it.
 */
const BUDGET = Number(process.env.DAILY_TOKEN_BUDGET ?? 5_000_000);
let todayTokens = 0;
let budgetDay = "";
let budgetAlerted = false;

async function refreshBudget(): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const stats = await dayStats(day);
    todayTokens = stats.inputTokens + stats.outputTokens;
    if (day !== budgetDay) {
      budgetDay = day;
      budgetAlerted = false;
    }
  } catch { /* keep last known value */ }
}
setInterval(refreshBudget, 5 * 60_000);
void refreshBudget();

function budgetGuard(task: TaskClass, s: RouteSpec & { model: string }): RouteSpec & { model: string } {
  if (task === "triage" || todayTokens < BUDGET) return s;
  if (!budgetAlerted) {
    budgetAlerted = true;
    void alertAdmin(
      `Daily token budget exceeded (${todayTokens.toLocaleString()} > ${BUDGET.toLocaleString()}). ` +
      `Routing all calls to the cheap tier until midnight UTC.`
    );
  }
  const cheap = process.env[( (routesConfig.routes as Record<string, RouteSpec>)["triage"]).deployment];
  return cheap ? { ...s, model: cheap } : s;
}

export interface RouteOptions {
  json?: boolean;
  tools?: ChatCompletionTool[];
}

export async function route(
  task: TaskClass,
  messages: ChatCompletionMessageParam[],
  opts: RouteOptions = {}
) {
  const s = budgetGuard(task, spec(task));
  const res = await client.chat.completions.create({
    model: s.model,
    messages,
    max_tokens: s.maxTokens,
    temperature: s.temperature,
    ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
  });
  todayTokens += (res.usage?.prompt_tokens ?? 0) + (res.usage?.completion_tokens ?? 0);
  void logActivity({
    type: "model_call",
    detail: {
      task,
      model: s.model,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    },
  });
  return res;
}

/** Escalate a failed cheap call to the configured stronger tier, once. */
export async function routeWithEscalation(
  task: TaskClass,
  messages: ChatCompletionMessageParam[],
  opts: RouteOptions,
  failed: (content: string | null) => boolean
) {
  const first = await route(task, messages, opts);
  const content = first.choices[0]?.message?.content ?? null;
  const esc = routesConfig.escalation;
  if (esc && esc.from === task && failed(content)) {
    return route(esc.to as TaskClass, messages, opts);
  }
  return first;
}

export async function embed(text: string): Promise<number[]> {
  const res = await client.embeddings.create({
    model: process.env.EMBED_DEPLOYMENT!,
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
}
