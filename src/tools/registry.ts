/**
 * Native tools + unified registry.
 * The agent sees one flat tool list: native tools (brain, To Do, scheduler)
 * and every allowed tool from every configured MCP server, identically shaped.
 * dispatch() routes a tool call to the right implementation.
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { saveNote, recall } from "../services/brain";
import { scheduleJob, listJobs, cancelJob } from "../services/scheduler";
import { rememberLesson, LessonKind } from "../services/agentMemory";
import { mcpToolDefinitions, isMcpTool, callMcpTool } from "./mcpClient";
import { requiresApproval, parkAction } from "../services/approvals";

export interface ToolContext {
  userId: string;
  conversationRef?: unknown; // serialized ConversationReference for proactive delivery
}

const nativeDefs: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "save_note",
      description: "File an idea, reference, or task into the second brain as a markdown note.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["task", "idea", "reference"] },
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          links: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_notes",
      description: "Vector-search the user's second brain. Use before answering questions about past captures.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          k: { type: "number", description: "How many notes to retrieve (default 8)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_job",
      description:
        "Create a recurring or one-off scheduled job from a natural-language request " +
        "('every Friday at 4pm summarize open Smartsheet risks'). The prompt you store " +
        "will be executed by this same agent, with the same tools, at each due time, " +
        "and the result is messaged to the user.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short human-readable job name" },
          cron: {
            type: "string",
            description:
              "Standard 5-field cron in the user's local time, e.g. '0 16 * * 5' for Fridays 4pm. " +
              "For one-off jobs use runOnce instead.",
          },
          runOnce: { type: "string", description: "ISO datetime for a one-time job (omit cron)" },
          prompt: { type: "string", description: "The instruction to execute at each run" },
        },
        required: ["name", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_jobs",
      description: "List the user's scheduled jobs with next run times.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_lesson",
      description:
        "Store an operational lesson in the agent's OWN memory (not the user's notes): a user " +
        "preference about how you work, a correction/alias ('the register' = sheet X), a tool " +
        "quirk you discovered, or a self-observation about a mistake pattern. Use when the user " +
        "corrects you or teaches you shorthand. Keep it one sentence.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["preference", "correction", "tool_lesson", "self"] },
          text: { type: "string" },
        },
        required: ["kind", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_job",
      description: "Cancel a scheduled job by its id or exact name.",
      parameters: {
        type: "object",
        properties: { idOrName: { type: "string" } },
        required: ["idOrName"],
      },
    },
  },
];

export async function allToolDefinitions(): Promise<ChatCompletionTool[]> {
  return [...nativeDefs, ...(await mcpToolDefinitions())];
}

export async function dispatch(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    if (isMcpTool(name)) {
      if (requiresApproval(name)) {
        const id = await parkAction(ctx.userId, name, args);
        return (
          `HELD FOR APPROVAL (id ${id}): ${name} is a write action and was not executed. ` +
          `Tell the user it is queued and they must reply 'approve ${id}' or 'deny ${id}'.`
        );
      }
      return await callMcpTool(name, args);
    }

    switch (name) {
      case "save_note": {
        const { path } = await saveNote(ctx.userId, {
          kind: (args.kind as "task" | "idea" | "reference") ?? "idea",
          title: String(args.title),
          body: String(args.body ?? ""),
          tags: (args.tags as string[]) ?? [],
          links: (args.links as string[]) ?? [],
          source: "text",
        });
        return `Saved: ${path}`;
      }
      case "recall_notes": {
        const hits = await recall(ctx.userId, String(args.query), Number(args.k ?? 8));
        if (!hits.length) return "No matching notes.";
        return hits
          .map((h) => `[${h.kind}] ${h.title} (${h.createdAt.slice(0, 10)}): ${h.body.slice(0, 400)}`)
          .join("\n---\n");
      }
      case "schedule_job": {
        const job = await scheduleJob(ctx.userId, {
          name: String(args.name),
          cron: args.cron ? String(args.cron) : undefined,
          runOnce: args.runOnce ? String(args.runOnce) : undefined,
          prompt: String(args.prompt),
          conversationRef: ctx.conversationRef,
        });
        return `Scheduled "${job.name}" — next run ${job.nextRun}.`;
      }
      case "list_jobs": {
        const jobs = await listJobs(ctx.userId);
        if (!jobs.length) return "No scheduled jobs.";
        return jobs
          .map((j) => `${j.id} | ${j.name} | ${j.cron ?? "one-off"} | next: ${j.nextRun} | ${j.enabled ? "on" : "paused"}`)
          .join("\n");
      }
      case "cancel_job":
        return await cancelJob(ctx.userId, String(args.idOrName));
      case "remember_lesson":
        return await rememberLesson(
          ctx.userId,
          (args.kind as LessonKind) ?? "preference",
          String(args.text)
        );
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    // Tool errors go back to the model as text so it can recover or report.
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}
