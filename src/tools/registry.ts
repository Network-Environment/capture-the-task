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
import { requiresApproval, parkAction, type PendingAction } from "../services/approvals";
import { approvalMessage } from "../services/smartsheet";
import { recallMeetings, listFollowThrough, markCommitmentDone } from "../meetings/recall";
import { lookupOrg } from "../org/store";
import type {
  ActivityChannel,
  ActivityInputMode,
  ActivityOrigin,
} from "../services/activityLog";
import { logActivity } from "../services/activityLog";
import {
  assertPublicHttpUrl,
  consumeBrowserBudget,
  consumeSearchBudget,
  isBrowserMcpTool,
  truncateSnapshot,
  webSearch,
  type ResearchBudget,
} from "./webResearch";
import {
  graphEnabled,
  graphWritesEnabled,
  getGraphNode,
  patchGraphNode,
  putGraphEdge,
  putGraphNode,
  searchExecutionGraph,
  setGraphSingleRelationship,
} from "../graph/store";
import { deterministicGraphId } from "../graph/validation";
import type { GraphEdgeType, GraphNodeStatus } from "../graph/types";
import { canViewMeetings, denyMeetings } from "../meetings/access";
import {
  evaluateOperation,
  type AuthorizationContext,
  type OperationMetadata,
} from "../services/intent";
import { channelPolicy } from "../channels/types";

export interface ToolContext {
  userId: string;
  conversationRef?: unknown; // serialized ConversationReference for proactive delivery
  origin?: ActivityOrigin;
  channel?: ActivityChannel;
  inputMode?: ActivityInputMode;
  trigger?: string;
  research?: ResearchBudget;
  authorization?: AuthorizationContext;
  /** Immutable tool envelope, primarily for approved scheduled jobs. */
  allowedTools?: string[];
}

const nativeEffects: Record<string, Pick<OperationMetadata, "effect" | "reversible">> = {
  save_note: { effect: "personal_write", reversible: true },
  recall_notes: { effect: "read", reversible: true },
  schedule_job: { effect: "scheduled", reversible: true },
  list_jobs: { effect: "read", reversible: true },
  remember_lesson: { effect: "personal_write", reversible: true },
  cancel_job: { effect: "destructive", reversible: false },
  recall_meetings: { effect: "read", reversible: true },
  list_commitments: { effect: "read", reversible: true },
  complete_commitment: { effect: "shared_write", reversible: true },
  lookup_org: { effect: "read", reversible: true },
  web_search: { effect: "read", reversible: true },
  search_execution_graph: { effect: "read", reversible: true },
  create_graph_project: { effect: "shared_write", reversible: true },
  create_graph_task: { effect: "shared_write", reversible: true },
  update_graph_item: { effect: "shared_write", reversible: true },
  propose_graph_relationship: { effect: "shared_write", reversible: true },
};
const scheduledNativeReads = new Set([
  "recall_notes",
  "search_execution_graph",
  "recall_meetings",
  "list_commitments",
  "lookup_org",
  "list_jobs",
]);

export function operationMetadata(name: string): OperationMetadata {
  const native = nativeEffects[name];
  if (native) return { name, description: name.replaceAll("_", " "), ...native };
  const readLike = /__(get|list|search|read|lookup|query|snapshot|navigate)(_|$)/i.test(name);
  return {
    name,
    description: name.replaceAll("__", " "),
    effect: !requiresApproval(name) && readLike ? "read" : "shared_write",
    reversible: !requiresApproval(name) && readLike,
  };
}

export async function scheduledReadToolEnvelope(): Promise<string[]> {
  return (await allToolDefinitions())
    .map((tool) => tool.function.name)
    .filter(
      (tool) =>
        operationMetadata(tool).effect === "read" &&
        (scheduledNativeReads.has(tool) || tool.startsWith("smartsheet__"))
    );
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
  {
    type: "function",
    function: {
      name: "recall_meetings",
      description:
        "Search org meeting summaries (last 90 days) for what was decided, discussed, or assigned. " +
        "Use for questions about meetings, decisions, and who said they would do what.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          k: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_commitments",
      description:
        "List open org commitments extracted from meetings. Overdue items first. Optional owner filter.",
      parameters: {
        type: "object",
        properties: { owner: { type: "string", description: "Name or id fragment" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_commitment",
      description: "Mark an open meeting commitment done after the user confirms follow-through.",
      parameters: {
        type: "object",
        properties: { idOrText: { type: "string" } },
        required: ["idOrText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_org",
      description:
        "Look up people, teams, and named roles in the org directory: reporting, mandates " +
        "(what they should be doing), and open commitment counts (what they are doing).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Name, team, role, or alias" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web for current information. Returns titles, URLs, and short snippets only. " +
        "Use this first for 'what's the latest on X'. Do not use for Smartsheet, org directory, or meetings — those have their own tools. " +
        "Open a URL with the browser tools only when the user named it or a search hit must be read as a rendered page.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "number", description: "How many hits to return (5–8, default 8)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_execution_graph",
      description:
        "Search TaskBrain's shared execution graph, then expand connected projects, tasks, people, meetings, and evidence. Use for status, ownership, blockers, dependencies, and why work exists.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Maximum nodes, 1-100 (default 40)" },
          depth: { type: "number", description: "Relationship hops, 0-2 (default 1)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_graph_project",
      description: "Create an authoritative project in TaskBrain's shared execution graph.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["planned", "active", "blocked", "done", "cancelled"] },
          ownerPersonId: { type: "string", description: "Org person id, if known" },
          due: { type: "string", description: "ISO-8601 due date" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_graph_task",
      description:
        "Create an authoritative task in TaskBrain's shared execution graph, optionally linked to a project, owner, and dependencies.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["open", "active", "blocked", "done", "cancelled"] },
          projectId: { type: "string" },
          ownerPersonId: { type: "string", description: "Org person id, if known" },
          due: { type: "string", description: "ISO-8601 due date" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_graph_item",
      description: "Update an execution graph project or task after identifying its exact graph id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          status: {
            type: "string",
            enum: ["planned", "open", "active", "blocked", "done", "cancelled", "stale"],
          },
          ownerPersonId: { type: "string" },
          due: { type: "string" },
          expectedVersion: { type: "number" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_graph_relationship",
      description:
        "Propose a non-destructive relationship between existing graph nodes. Agent-inferred links remain pending until a team member accepts them.",
      parameters: {
        type: "object",
        properties: {
          fromId: { type: "string" },
          toId: { type: "string" },
          type: {
            type: "string",
            enum: ["part_of", "assigned_to", "depends_on", "originated_from", "supports", "related_to"],
          },
          evidence: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["fromId", "toId", "type", "evidence"],
      },
    },
  },
];

export function nativeToolCatalog(): { name: string; description: string }[] {
  return enabledNativeDefs().map((d) => ({
    name: d.function.name,
    description: d.function.description ?? "",
  }));
}

export async function allToolDefinitions(): Promise<ChatCompletionTool[]> {
  return [...enabledNativeDefs(), ...(await mcpToolDefinitions())];
}

const graphReadTools = new Set(["search_execution_graph"]);
const graphWriteTools = new Set([
  "create_graph_project",
  "create_graph_task",
  "update_graph_item",
  "propose_graph_relationship",
]);

function enabledNativeDefs(): ChatCompletionTool[] {
  return nativeDefs.filter((tool) => {
    const name = tool.function.name;
    if (graphReadTools.has(name)) return graphEnabled();
    if (graphWriteTools.has(name)) return graphEnabled() && graphWritesEnabled();
    return true;
  });
}

export async function dispatch(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  options: { approved?: boolean } = {}
): Promise<string> {
  try {
    if (ctx.allowedTools && !ctx.allowedTools.includes(name)) {
      return `NOT_ALLOWED: ${name} is outside this job's approved tool envelope.`;
    }
    if (isMcpTool(name)) {
      const [server, ...rest] = name.split("__");
      if (server === "browser" && !isBrowserMcpTool(server, rest.join("__"))) {
        return "Browser tool not allowed in v1 (navigate and snapshot only).";
      }
    }
    if (name === "schedule_job" && !Array.isArray(args.allowedTools)) {
      args = {
        ...args,
        allowedTools: await scheduledReadToolEnvelope(),
      };
    }
    const operation = operationMetadata(name);
    const authorization =
      ctx.authorization ??
      ({
        explicit: false,
        confidence: 0,
        channel: channelPolicy(ctx.channel === "imessage" ? "imessage" : "teams", {
          identity: "weak",
          allowActions: false,
        }),
      } satisfies AuthorizationContext);
    if (!options.approved && process.env.UNIFIED_ACTION_POLICY_ENABLED === "true") {
      const policy = evaluateOperation(operation, authorization);
      void logActivity({
        type: "policy",
        userId: ctx.userId,
        origin: ctx.origin,
        channel: ctx.channel,
        inputMode: ctx.inputMode,
        trigger: ctx.trigger ?? "operation_policy",
        detail: {
          tool: name,
          effect: operation.effect,
          decision: policy.decision,
          explicit: authorization.explicit,
          confidenceBand:
            authorization.confidence >= 0.9 ? "high" : authorization.confidence >= 0.72 ? "medium" : "low",
        },
      });
      if (policy.decision === "clarify") return `CLARIFY: ${policy.reason}`;
      if (policy.decision === "deny") return `NOT_ALLOWED: ${policy.reason}`;
      if (policy.decision === "approve") {
        const id = await parkAction(ctx.userId, name, args, {
          effect: operation.effect,
          reason: policy.reason,
          summary: `${operation.description}: ${JSON.stringify(args).slice(0, 500)}`,
          authorization,
        });
        return approvalMessage(id, name, args) + ` Reason: ${policy.reason}`;
      }
    }
    if (
      !options.approved &&
      process.env.UNIFIED_ACTION_POLICY_ENABLED !== "true" &&
      isMcpTool(name) &&
      requiresApproval(name)
    ) {
      const id = await parkAction(ctx.userId, name, args, {
        effect: operation.effect,
        authorization,
      });
      return approvalMessage(id, name, args);
    }
    if (isMcpTool(name)) {
      const [server, ...rest] = name.split("__");
      const tool = rest.join("__");
      if (server === "browser") {
        if (!isBrowserMcpTool(server, tool)) {
          return "Browser tool not allowed in v1 (navigate and snapshot only).";
        }
        const capped = consumeBrowserBudget(ctx);
        if (capped) return capped;
        if (tool === "navigate") {
          const checked = await assertPublicHttpUrl(String(args.url ?? ""));
          if ("error" in checked) return checked.error;
          args = { ...args, url: checked.href };
        }
        return truncateSnapshot(await callMcpTool(name, args));
      }
      return await callMcpTool(name, args);
    }

    switch (name) {
      case "save_note": {
        const { path } = await saveNote(
          ctx.userId,
          {
            kind: (args.kind as "task" | "idea" | "reference") ?? "idea",
            title: String(args.title),
            body: String(args.body ?? ""),
            tags: (args.tags as string[]) ?? [],
            links: (args.links as string[]) ?? [],
            source: "text",
          },
          ctx
        );
        return `Saved: ${path}`;
      }
      case "recall_notes": {
        const hits = await recall(
          ctx.userId,
          String(args.query),
          Number(args.k ?? 8),
          ctx
        );
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
          allowedTools: (args.allowedTools as string[]).filter(
            (tool) => operationMetadata(tool).effect === "read"
          ),
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
      case "recall_meetings":
        return await recallMeetings(
          ctx.userId,
          String(args.query),
          Number(args.k ?? 6),
          ctx
        );
      case "list_commitments":
        return await listFollowThrough(ctx.userId, args.owner ? String(args.owner) : undefined);
      case "complete_commitment":
        return await markCommitmentDone(ctx.userId, String(args.idOrText));
      case "lookup_org":
        return await lookupOrg(ctx.userId, String(args.query ?? ""));
      case "web_search": {
        const capped = consumeSearchBudget(ctx);
        if (capped) return capped;
        return await webSearch(String(args.query ?? ""), args.count as number | undefined);
      }
      case "search_execution_graph": {
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        if (!graphEnabled()) return "Execution graph is disabled.";
        const graph = await searchExecutionGraph(
          String(args.query ?? ""),
          ctx.userId,
          { limit: Number(args.limit ?? 40), depth: Number(args.depth ?? 1) },
          ctx
        );
        if (!graph.nodes.length) return "No matching execution graph items.";
        const edgeLines = graph.edges.map(
          (edge) => `${edge.fromId} -[${edge.type}]-> ${edge.toId}`
        );
        return [
          ...graph.nodes.map(
            (node) =>
              `${node.id} v${node.version} | ${node.type} | ${node.status ?? "n/a"} | ${node.title}` +
              `${node.ownerPersonId ? ` | owner ${node.ownerPersonId}` : ""}` +
              `${node.due ? ` | due ${node.due}` : ""}` +
              `${node.description ? `\n${node.description.slice(0, 500)}` : ""}`
          ),
          ...(edgeLines.length ? ["Relationships:", ...edgeLines] : []),
          ...(graph.truncated ? ["Result truncated; narrow the query."] : []),
        ].join("\n");
      }
      case "create_graph_project": {
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        if (!graphWritesEnabled()) return "Execution graph writes are disabled during read-only rollout.";
        const ownerPersonId = args.ownerPersonId
          ? normalizePersonGraphId(String(args.ownerPersonId))
          : undefined;
        await assertGraphTargets([ownerPersonId], ctx.userId);
        const node = await putGraphNode(
          {
            type: "project",
            title: String(args.title ?? ""),
            description: args.description ? String(args.description) : undefined,
            status: (args.status as GraphNodeStatus) ?? "planned",
            ownerPersonId,
            due: args.due ? String(args.due) : undefined,
            provenance: "agent",
          },
          ctx.userId,
          ctx
        );
        if (ownerPersonId) {
          await setGraphSingleRelationship(
            node.id,
            "assigned_to",
            ownerPersonId,
            ctx.userId,
            "agent",
            "Explicit owner supplied when the project was created."
          );
        }
        return `Created project ${node.id} v${node.version}: ${node.title}`;
      }
      case "create_graph_task": {
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        if (!graphWritesEnabled()) return "Execution graph writes are disabled during read-only rollout.";
        const ownerPersonId = args.ownerPersonId
          ? normalizePersonGraphId(String(args.ownerPersonId))
          : undefined;
        const dependencies = ((args.dependsOn as string[] | undefined) ?? []).map(String);
        await assertGraphTargets(
          [ownerPersonId, args.projectId ? String(args.projectId) : undefined, ...dependencies],
          ctx.userId
        );
        const node = await putGraphNode(
          {
            type: "task",
            title: String(args.title ?? ""),
            description: args.description ? String(args.description) : undefined,
            status: (args.status as GraphNodeStatus) ?? "open",
            ownerPersonId,
            due: args.due ? String(args.due) : undefined,
            provenance: "agent",
          },
          ctx.userId,
          ctx
        );
        await setGraphSingleRelationship(
          node.id,
          "part_of",
          args.projectId ? String(args.projectId) : undefined,
          ctx.userId,
          "agent",
          "Explicit project supplied when the task was created."
        );
        await setGraphSingleRelationship(
          node.id,
          "assigned_to",
          ownerPersonId,
          ctx.userId,
          "agent",
          "Explicit owner supplied when the task was created."
        );
        const dependencyEdges: { toId: string; type: GraphEdgeType; evidence: string }[] =
          dependencies.map((toId) => ({
            toId,
            type: "depends_on" as const,
            evidence: "Explicit dependency supplied when the task was created.",
          }));
        for (const edge of dependencyEdges) {
          await putGraphEdge(
            {
              fromId: node.id,
              toId: edge.toId,
              type: edge.type,
              reviewState: "accepted",
              provenance: "agent",
              evidence: edge.evidence,
            },
            ctx.userId
          );
        }
        return `Created task ${node.id} v${node.version}: ${node.title}`;
      }
      case "update_graph_item": {
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        if (!graphWritesEnabled()) return "Execution graph writes are disabled during read-only rollout.";
        const current = await getGraphNode(String(args.id ?? ""), ctx.userId);
        if (!current) return "Graph item not found.";
        if (current.source && current.source.kind !== "graph") {
          return "Projected graph items are read-only; update the source commitment, meeting, or org record.";
        }
        const patch: Parameters<typeof patchGraphNode>[1] = {};
        if ("title" in args) patch.title = String(args.title ?? "");
        if ("description" in args) patch.description = args.description ? String(args.description) : null;
        if ("status" in args) patch.status = args.status as GraphNodeStatus;
        if ("ownerPersonId" in args) {
          patch.ownerPersonId = args.ownerPersonId
            ? normalizePersonGraphId(String(args.ownerPersonId))
            : null;
          await assertGraphTargets(
            [patch.ownerPersonId ?? undefined],
            ctx.userId
          );
        }
        if ("due" in args) patch.due = args.due ? String(args.due) : null;
        const node = await patchGraphNode(
          String(args.id ?? ""),
          patch,
          ctx.userId,
          args.expectedVersion === undefined ? undefined : Number(args.expectedVersion),
          ctx
        );
        if ("ownerPersonId" in args) {
          await setGraphSingleRelationship(
            node.id,
            "assigned_to",
            args.ownerPersonId ? normalizePersonGraphId(String(args.ownerPersonId)) : undefined,
            ctx.userId,
            "agent",
            "Explicit owner supplied when the item was updated."
          );
        }
        return `Updated ${node.id} v${node.version}: ${node.title} (${node.status ?? "no status"})`;
      }
      case "propose_graph_relationship": {
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        if (!graphWritesEnabled()) return "Execution graph writes are disabled during read-only rollout.";
        const edge = await putGraphEdge(
          {
            fromId: String(args.fromId ?? ""),
            toId: String(args.toId ?? ""),
            type: args.type as GraphEdgeType,
            reviewState: "proposed",
            provenance: "agent",
            evidence: String(args.evidence ?? ""),
            confidence: args.confidence === undefined ? undefined : Number(args.confidence),
          },
          ctx.userId
        );
        return `Proposed ${edge.type} relationship ${edge.id} for team review.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    // Tool errors go back to the model as text so it can recover or report.
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}

export async function executeApprovedAction(
  action: PendingAction,
  currentAuthorization: AuthorizationContext
): Promise<string> {
  if (!action.authorization) {
    throw new Error("This action was created before secure authorization snapshots; prepare it again.");
  }
  const authorization =
    currentAuthorization;
  const currentPolicy = evaluateOperation(operationMetadata(action.tool), authorization);
  if (currentPolicy.decision === "deny" || currentPolicy.decision === "clarify") {
    throw new Error(`Action is no longer authorized: ${currentPolicy.reason}`);
  }
  return dispatch(
    {
      userId: action.userId,
      origin: "approval",
      channel: "internal",
      trigger: "approved_action",
      authorization,
    },
    action.tool,
    action.args,
    { approved: true }
  );
}

function normalizePersonGraphId(id: string): string {
  return id.startsWith("org-person:") ? id : deterministicGraphId("org-person", id);
}

async function assertGraphTargets(
  ids: (string | undefined)[],
  userId: string
): Promise<void> {
  for (const id of ids.filter(Boolean) as string[]) {
    if (!(await getGraphNode(id, userId))) {
      throw new Error(`Relationship target does not exist: ${id}`);
    }
  }
}
