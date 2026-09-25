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
import {
  assessAssignment,
  findAtRiskWork,
  listOrgWorkload,
  listWorkload,
  lookupOrg,
  rememberOrgPreference,
  rememberOrgResponsibility,
  suggestAssignee,
} from "../org/store";
import { retainFromText } from "../memory/retain";
import { recallMemory, recallPromptBlock } from "../memory/recall";
import { reflectMemory } from "../memory/reflect";
import { upsertMemoryProfile, memoryFactsEnabled } from "../memory/store";
import { canWriteOrgBank, userBankId } from "../memory/banks";
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
import {
  createProposedTimeline,
  explainGraphTimeline,
  type TimelineTaskInput,
} from "../graph/timeline";
import { canViewMeetings, denyMeetings } from "../meetings/access";
import { assignWorkForUser, completeWork, nudgeWork } from "../work/assign";
import {
  addPmoColumn,
  addPmoItem,
  closePmoBoard,
  listPmoBoardForUser,
  listPmoBoardsForUser,
  openPmoBoard,
  updatePmoItem,
} from "../pmo/boards";
import { searchMyCalendar } from "../services/graphCalendar";
import {
  evaluateOperation,
  type AuthorizationContext,
  type OperationMetadata,
} from "../services/intent";
import { channelPolicy } from "../channels/types";
import {
  applyCheckInUpdates,
  proposeCheckInUpdates,
  sendFollowthroughBriefings,
  type CheckInUpdate,
} from "../org/checkins";
import { formatUserGuide, USER_GUIDE_TOPICS } from "../services/userGuide";
import { envFlag } from "../config";

export interface ToolContext {
  userId: string;
  conversationRef?: unknown; // serialized ConversationReference for proactive delivery
  origin?: ActivityOrigin;
  channel?: ActivityChannel;
  inputMode?: ActivityInputMode;
  trigger?: string;
  traceId?: string;
  research?: ResearchBudget;
  authorization?: AuthorizationContext;
  /** Delegated token for tools that read the requester's own Microsoft 365 data. */
  getGraphToken?: () => Promise<string>;
  /** Evaluation-only hook; production callers leave these unset. */
  observeToolCall?: (name: string) => void;
  dryRunTools?: boolean;
  /** Immutable tool envelope, primarily for approved scheduled jobs. */
  allowedTools?: string[];
  /** Scheduled actions explicitly approved when the job was created. */
  preapprovedTools?: string[];
}

const nativeEffects: Record<string, Pick<OperationMetadata, "effect" | "reversible">> = {
  save_note: { effect: "personal_write", reversible: true },
  recall_notes: { effect: "read", reversible: true },
  explain_taskbrain: { effect: "read", reversible: true },
  schedule_job: { effect: "scheduled", reversible: true },
  list_jobs: { effect: "read", reversible: true },
  remember_lesson: { effect: "personal_write", reversible: true },
  cancel_job: { effect: "destructive", reversible: false },
  search_my_calendar: { effect: "read", reversible: true },
  recall_meetings: { effect: "read", reversible: true },
  list_commitments: { effect: "read", reversible: true },
  complete_commitment: { effect: "shared_write", reversible: true },
  lookup_org: { effect: "read", reversible: true },
  list_workload: { effect: "read", reversible: true },
  list_org_workload: { effect: "read", reversible: true },
  find_at_risk_work: { effect: "read", reversible: true },
  send_followthrough_briefings: { effect: "shared_write", reversible: true },
  propose_checkin_updates: { effect: "personal_write", reversible: true },
  apply_checkin_updates: { effect: "shared_write", reversible: true },
  assess_assignment: { effect: "read", reversible: true },
  suggest_assignee: { effect: "read", reversible: true },
  assign_work: { effect: "personal_write", reversible: true },
  nudge_work: { effect: "personal_write", reversible: true },
  complete_work: { effect: "personal_write", reversible: true },
  remember_org_preference: { effect: "shared_write", reversible: true },
  remember_org_responsibility: { effect: "shared_write", reversible: true },
  web_search: { effect: "read", reversible: true },
  retain_memory: { effect: "personal_write", reversible: true },
  recall_memory: { effect: "read", reversible: true },
  reflect_memory: { effect: "personal_write", reversible: true },
  search_execution_graph: { effect: "read", reversible: true },
  explain_timeline: { effect: "read", reversible: true },
  create_graph_project: { effect: "shared_write", reversible: true },
  create_graph_task: { effect: "shared_write", reversible: true },
  update_graph_item: { effect: "shared_write", reversible: true },
  propose_graph_relationship: { effect: "shared_write", reversible: true },
  propose_timeline: { effect: "shared_write", reversible: true },
  open_pmo_board: { effect: "shared_write", reversible: true },
  list_pmo_boards: { effect: "read", reversible: true },
  list_pmo_board: { effect: "read", reversible: true },
  add_pmo_item: { effect: "shared_write", reversible: true },
  update_pmo_item: { effect: "shared_write", reversible: true },
  add_pmo_column: { effect: "shared_write", reversible: true },
  close_pmo_board: { effect: "shared_write", reversible: true },
};
const scheduledNativeReads = new Set([
  "explain_taskbrain",
  "recall_notes",
  "search_execution_graph",
  "explain_timeline",
  "recall_memory",
  "search_my_calendar",
  "recall_meetings",
  "list_commitments",
  "lookup_org",
  "list_workload",
  "list_org_workload",
  "find_at_risk_work",
  "assess_assignment",
  "suggest_assignee",
  "list_jobs",
  "list_pmo_boards",
  "list_pmo_board",
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

const scheduledActionTools = new Set(["send_followthrough_briefings"]);

export function scheduledActionToolEnvelope(requested: unknown): string[] {
  if (!Array.isArray(requested)) return [];
  return [...new Set(requested.map(String).filter((tool) => scheduledActionTools.has(tool)))];
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
      name: "explain_taskbrain",
      description:
        "Return the user-facing TaskBrain capability guide for a topic. Call this before answering what TaskBrain can do, how it works, or whether a kind of request is in scope. Do not invent capabilities the guide omitted.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: [...USER_GUIDE_TOPICS],
            description: "Guide chapter. Default overview for new users and general help.",
          },
        },
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
          actionTools: {
            type: "array",
            items: { type: "string", enum: ["send_followthrough_briefings"] },
            description:
              "Narrow actions to approve with the schedule. Use send_followthrough_briefings only for requested recurring org check-ins.",
          },
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
        "preference about how YOU reply, a correction/alias ('the register' = sheet X), a tool " +
        "quirk, or a self-observation. Do NOT store how a named colleague works (queues, Planner vs To Do, " +
        "nudge channel) — use remember_org_preference. Do NOT store mandates, hats, or capacity — use " +
        "remember_org_responsibility. Keep it one sentence.",
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
      name: "search_my_calendar",
      description:
        "Search the requesting user's own live Outlook calendar for events in a date range. " +
        "Use this source for whether or when the requester met someone, event subjects, and attendees. " +
        "It does not read another person's mailbox or meeting transcript content.",
      parameters: {
        type: "object",
        properties: {
          attendee: {
            type: "string",
            description: "Tenant colleague name, alias, or email address when the request names one",
          },
          keywords: {
            type: "string",
            description: "Optional words that must appear in the calendar event subject",
          },
          start: { type: "string", description: "Optional ISO date/time range start" },
          end: { type: "string", description: "Optional ISO date/time range end" },
          limit: { type: "number", description: "Number of newest matching events, 1-10" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_meetings",
      description:
        "Search stored Teams/Plaud transcript summaries (last 90 days) for meeting content: " +
        "what was discussed, decided, or assigned. This is not a complete calendar and should not " +
        "be the only source for whether or when a meeting occurred.",
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
      name: "assign_work",
      description:
        "Create a durable work assignment for a named org person and fan it out to their stored " +
        "queues (Teams card, To Do, Planner, Smartsheet). Call assess_assignment first (or lookup_org plus " +
        "list_workload). If fit or capacity is poor, tell the speaker and assign only if they still want that owner. " +
        "Do not pick destinations — the org record does.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Name, alias, or Entra id from the org directory" },
          title: { type: "string" },
          detail: { type: "string" },
          due: { type: "string", description: "ISO date" },
          effort: { type: "number", enum: [1, 2, 3, 5, 8] },
        },
        required: ["owner", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nudge_work",
      description: "Re-send the Teams card (and Planner comment) for an open work assignment.",
      parameters: {
        type: "object",
        properties: { idOrTitle: { type: "string" } },
        required: ["idOrTitle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_work",
      description: "Mark a work assignment and its To Do / Planner copies done. Prefer the owner's card action.",
      parameters: {
        type: "object",
        properties: { idOrTitle: { type: "string" } },
        required: ["idOrTitle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_org_preference",
      description:
        "Store how a named org person executes work (To Do vs Planner vs Teams, nudge channel, one-line notes) " +
        "on the org directory — not in personal lessons. Use when someone says how a colleague works.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          executionQueues: {
            type: "array",
            items: { type: "string", enum: ["teams", "todo", "planner", "smartsheet"] },
          },
          nudgeChannel: {
            type: "string",
            enum: ["teams_card", "teams_chat", "imessage", "email", "silent"],
          },
          workingNotes: { type: "string" },
          dropQueue: { type: "string", description: "Queue to remove after delivery feedback (todo, planner, …)" },
        },
        required: ["person"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_org_responsibility",
      description:
        "Store what a named org person should be doing (mandate), a named hat/role, or their capacity " +
        "(available / stretched / overloaded / unavailable) on the org directory. Use when someone states " +
        "responsibilities or load. Do not invent reporting lines. Admin-curated fields win.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          mandate: { type: "string" },
          roleTitle: { type: "string" },
          roleMandate: { type: "string" },
          roleUnit: { type: "string", description: "Team name for the hat" },
          capacityStatus: {
            type: "string",
            enum: ["available", "stretched", "overloaded", "unavailable"],
          },
          capacityNote: { type: "string" },
        },
        required: ["person"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_org",
      description:
        "Look up people, teams, and named roles in the org directory: reporting, mandates " +
        "(what they should be doing), capacity, how they execute work, and TaskBrain plate counts. " +
        "Use list_workload for the item list and assess_assignment before assign_work.",
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
      name: "list_workload",
      description:
        "List what a named org person currently has on their TaskBrain plate: open work assignments, " +
        "meeting commitments, execution-graph tasks, and non-done PMO items. Does not read Microsoft To Do or calendar.",
      parameters: {
        type: "object",
        properties: { person: { type: "string" } },
        required: ["person"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_org_workload",
      description:
        "Summarize current TaskBrain workload for all active people, one team, or a manager and direct reports.",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string" },
          manager: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_at_risk_work",
      description:
        "Find overdue, due-soon, blocked, or inactive TaskBrain work across the org, one team, or a manager and direct reports.",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string" },
          manager: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_followthrough_briefings",
      description:
        "Send risk-based daily asks to scoped org people and manager rollups. Use only from an explicitly approved scheduled job.",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string" },
          manager: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_checkin_updates",
      description:
        "For the current user's pending daily check-in, prepare exact status, due-date, blocker, completion, or progress-note changes and return one approval command. Does not apply changes.",
      parameters: {
        type: "object",
        properties: {
          checkInId: { type: "string" },
          response: { type: "string" },
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string", enum: ["work", "commitment", "graph", "pmo"] },
                id: { type: "string" },
                status: {
                  type: "string",
                  enum: ["open", "accepted", "blocked", "done"],
                },
                due: { type: "string", description: "ISO date; empty string clears it" },
                progressNote: { type: "string" },
              },
              required: ["source", "id"],
            },
          },
        },
        required: ["updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_checkin_updates",
      description:
        "Apply a previously proposed daily check-in update. This tool is invoked only through approve pa-x.",
      parameters: {
        type: "object",
        properties: {
          personId: { type: "string" },
          checkInId: { type: "string" },
          response: { type: "string" },
          updates: { type: "array", items: { type: "object" } },
        },
        required: ["personId", "checkInId", "updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assess_assignment",
      description:
        "Before assign_work, check whether a named org person is a mandate fit and whether their plate/capacity " +
        "can take the work. Advisory only — still assign if the speaker insists.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["owner", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_assignee",
      description:
        "For work without a named owner, rank up to three active org people by mandate fit, capacity, risk-weighted load, effort, and recent assignment share. Advisory only.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          effort: { type: "number", enum: [1, 2, 3, 5, 8] },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "retain_memory",
      description:
        "Extract and store self-contained memory facts in the speaker's personal bank (or org bank if you are a meeting viewer and the facts are shared world events). Do not use this to create execution-graph tasks.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Source text to retain from" },
          bank: { type: "string", enum: ["user", "org"], description: "Default user" },
          sourceId: { type: "string" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description:
        "Retrieve dated world/experience/opinion/observation facts with citations. Use together with search_execution_graph for status questions — memory does not replace the PMO graph.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reflect_memory",
      description:
        "Answer from recalled memory facts with citations. Optionally update a private opinion (never an org-wide judgment about a person).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          updateOpinion: { type: "boolean" },
          skepticism: { type: "number", description: "1-5 private disposition knob" },
          literalism: { type: "number" },
          empathy: { type: "number" },
        },
        required: ["question"],
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
      name: "explain_timeline",
      description:
        "Explain dependency order, capacity/effort-based likely finish, due conflicts, and target-date feasibility for a graph project. Missing effort is clearly labeled as an estimate.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          startDate: { type: "string" },
          targetDate: { type: "string" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_timeline",
      description:
        "Propose and, after shared-write approval, create graph tasks and accepted dependencies under an existing project with calculated business-day dates.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          startDate: { type: "string" },
          targetDate: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                ownerPersonId: { type: "string" },
                effort: { type: "number", enum: [1, 2, 3, 5, 8] },
                dependsOn: {
                  type: "array",
                  items: { type: "number" },
                  description: "Zero-based indexes of prerequisite tasks in this tasks array",
                },
              },
              required: ["title"],
            },
          },
        },
        required: ["projectId", "tasks"],
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
  {
    type: "function",
    function: {
      name: "open_pmo_board",
      description:
        "Create a short-lived shared PMO board. Columns are required. If the user asked to create a board " +
        "without naming columns, ask one question for the board name, columns, and any extra fields instead of calling this. " +
        "Pass kanban=true only when they asked for a normal kanban (To do / Doing / Blocked / Done). " +
        "Returns an existing open board with the same title. Do not invent schema.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          purpose: { type: "string" },
          columns: { type: "array", items: { type: "string" }, description: "Ordered column labels" },
          fields: { type: "array", items: { type: "string" }, description: "Optional extra text fields" },
          kanban: { type: "boolean", description: "Use the default kanban columns" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pmo_boards",
      description: "List TaskBrain PMO boards. Default is active/open boards; pass status=closed for archived.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "closed", "all"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pmo_board",
      description: "Show one PMO board grouped by its own columns, with owners, dues, and extra fields.",
      parameters: {
        type: "object",
        properties: { board: { type: "string", description: "Board id or title" } },
        required: ["board"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_pmo_item",
      description:
        "Add an item to an open PMO board. Column must match that board. Owner must be an org directory person.",
      parameters: {
        type: "object",
        properties: {
          board: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
          column: { type: "string" },
          owner: { type: "string" },
          due: { type: "string" },
          fields: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["board", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_pmo_item",
      description: "Move, retitle, reassign, or update fields on a PMO board item. Column must exist on that board.",
      parameters: {
        type: "object",
        properties: {
          board: { type: "string" },
          item: { type: "string", description: "Item id or title" },
          title: { type: "string" },
          detail: { type: "string" },
          column: { type: "string" },
          owner: { type: "string" },
          due: { type: "string" },
          fields: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["board", "item"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_pmo_column",
      description: "Append a column or extra text field to an open PMO board. Does not remove existing columns.",
      parameters: {
        type: "object",
        properties: {
          board: { type: "string" },
          label: { type: "string" },
          kind: { type: "string", enum: ["column", "field"] },
        },
        required: ["board", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_pmo_board",
      description:
        "Archive a PMO board. It stays listed for 90 days. Does not complete To Do / Planner copies unless items were already moved to Done.",
      parameters: {
        type: "object",
        properties: { board: { type: "string" } },
        required: ["board"],
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

const graphReadTools = new Set(["search_execution_graph", "explain_timeline"]);
const memoryTools = new Set(["retain_memory", "recall_memory", "reflect_memory"]);
const graphWriteTools = new Set([
  "create_graph_project",
  "create_graph_task",
  "update_graph_item",
  "propose_graph_relationship",
  "propose_timeline",
]);

function enabledNativeDefs(): ChatCompletionTool[] {
  return nativeDefs.filter((tool) => {
    const name = tool.function.name;
    if (graphReadTools.has(name)) return graphEnabled();
    if (graphWriteTools.has(name)) return graphEnabled() && graphWritesEnabled();
    if (memoryTools.has(name)) return memoryFactsEnabled();
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
    if (name === "retain_memory" && String(args.bank ?? "user") === "org") {
      operation.effect = "shared_write";
    }
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
    if (!options.approved && envFlag("UNIFIED_ACTION_POLICY_ENABLED", false)) {
      const policy = evaluateOperation(operation, authorization);
      void logActivity({
        type: "policy",
        userId: ctx.userId,
        origin: ctx.origin,
        channel: ctx.channel,
        inputMode: ctx.inputMode,
        trigger: ctx.trigger ?? "operation_policy",
        traceId: ctx.traceId,
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
      !envFlag("UNIFIED_ACTION_POLICY_ENABLED", false) &&
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
      case "explain_taskbrain":
        return formatUserGuide(args.topic ? String(args.topic) : "overview", {
          channel: ctx.channel,
          scope: ctx.authorization?.channel.scope,
          canViewMeetings: canViewMeetings(ctx.userId),
          graphEnabled: graphEnabled(),
          graphWritesEnabled: graphWritesEnabled(),
        });
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
        const actionTools = scheduledActionToolEnvelope(args.actionTools);
        const readTools = Array.isArray(args.allowedTools)
          ? (args.allowedTools as string[]).filter(
              (tool) => operationMetadata(tool).effect === "read"
            )
          : await scheduledReadToolEnvelope();
        const job = await scheduleJob(ctx.userId, {
          name: String(args.name),
          cron: args.cron ? String(args.cron) : undefined,
          runOnce: args.runOnce ? String(args.runOnce) : undefined,
          prompt: String(args.prompt),
          conversationRef: ctx.conversationRef,
          allowedTools: [...new Set([...readTools, ...actionTools])],
          actionTools,
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
      case "search_my_calendar": {
        if (!ctx.getGraphToken) {
          return "The requester's live Outlook calendar is unavailable on this channel.";
        }
        try {
          return await searchMyCalendar(await ctx.getGraphToken(), {
            attendee: args.attendee ? String(args.attendee) : undefined,
            keywords: args.keywords ? String(args.keywords) : undefined,
            start: args.start ? String(args.start) : undefined,
            end: args.end ? String(args.end) : undefined,
            limit: args.limit == null ? undefined : Number(args.limit),
          });
        } catch (err) {
          return `Outlook calendar lookup failed: ${(err as Error).message}`;
        }
      }
      case "list_commitments":
        return await listFollowThrough(ctx.userId, args.owner ? String(args.owner) : undefined);
      case "complete_commitment":
        return await markCommitmentDone(ctx.userId, String(args.idOrText));
      case "assign_work":
        return await assignWorkForUser(ctx.userId, {
          owner: String(args.owner ?? ""),
          title: String(args.title ?? ""),
          detail: args.detail ? String(args.detail) : undefined,
          due: args.due ? String(args.due) : undefined,
          effort: parseEffort(args.effort),
          source: "chat",
          requesterUserId: ctx.userId,
        });
      case "nudge_work":
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        return await nudgeWork(String(args.idOrTitle ?? ""));
      case "complete_work":
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        return await completeWork(String(args.idOrTitle ?? ""), ctx.userId);
      case "remember_org_preference":
        return await rememberOrgPreference(ctx.userId, {
          person: String(args.person ?? ""),
          executionQueues: args.executionQueues,
          nudgeChannel: args.nudgeChannel ? String(args.nudgeChannel) : undefined,
          workingNotes: args.workingNotes ? String(args.workingNotes) : undefined,
          dropQueue: args.dropQueue ? String(args.dropQueue) : undefined,
          source: "explicit",
        });
      case "remember_org_responsibility":
        return await rememberOrgResponsibility(ctx.userId, {
          person: String(args.person ?? ""),
          mandate: args.mandate ? String(args.mandate) : undefined,
          roleTitle: args.roleTitle ? String(args.roleTitle) : undefined,
          roleMandate: args.roleMandate ? String(args.roleMandate) : undefined,
          roleUnit: args.roleUnit ? String(args.roleUnit) : undefined,
          capacityStatus: args.capacityStatus ? String(args.capacityStatus) : undefined,
          capacityNote: args.capacityNote ? String(args.capacityNote) : undefined,
          source: "explicit",
        });
      case "lookup_org":
        return await lookupOrg(ctx.userId, String(args.query ?? ""));
      case "list_workload":
        return await listWorkload(ctx.userId, String(args.person ?? ""));
      case "list_org_workload":
        return await listOrgWorkload(ctx.userId, {
          team: args.team ? String(args.team) : undefined,
          manager: args.manager ? String(args.manager) : undefined,
        });
      case "find_at_risk_work":
        return await findAtRiskWork(ctx.userId, {
          team: args.team ? String(args.team) : undefined,
          manager: args.manager ? String(args.manager) : undefined,
        });
      case "send_followthrough_briefings":
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        return await sendFollowthroughBriefings(ctx.userId, {
          team: args.team ? String(args.team) : undefined,
          manager: args.manager ? String(args.manager) : undefined,
        });
      case "propose_checkin_updates":
        return await proposeCheckInUpdates(ctx.userId, {
          checkInId: args.checkInId ? String(args.checkInId) : undefined,
          response: args.response ? String(args.response) : undefined,
          updates: parseCheckInUpdates(args.updates),
        }, ctx.authorization);
      case "apply_checkin_updates":
        return await applyCheckInUpdates(ctx.userId, {
          personId: String(args.personId ?? ""),
          checkInId: String(args.checkInId ?? ""),
          response: args.response ? String(args.response) : undefined,
          updates: parseCheckInUpdates(args.updates),
        });
      case "assess_assignment":
        return await assessAssignment(ctx.userId, {
          owner: String(args.owner ?? ""),
          title: String(args.title ?? ""),
          detail: args.detail ? String(args.detail) : undefined,
        });
      case "suggest_assignee":
        return await suggestAssignee(ctx.userId, {
          title: String(args.title ?? ""),
          detail: args.detail ? String(args.detail) : undefined,
          effort: parseEffort(args.effort),
        });
      case "retain_memory": {
        const bank = String(args.bank ?? "user") === "org" ? "org" : "user";
        if (bank === "org" && !canWriteOrgBank(ctx.userId)) return denyMeetings();
        const saved = await retainFromText({
          userId: ctx.userId,
          text: String(args.text ?? ""),
          source: "chat",
          sourceId: String(args.sourceId ?? "retain_memory"),
          bank,
          attribution: ctx,
        });
        if (!saved.length) return "Nothing retainable in that text.";
        return `Retained ${saved.length} fact(s) in ${bank === "org" ? "org" : userBankId(ctx.userId)}: ` +
          saved.map((fact) => `[${fact.network}] ${fact.text}`).join(" | ");
      }
      case "recall_memory": {
        const recalled = await recallMemory(ctx.userId, String(args.query ?? ""), ctx);
        const block = recallPromptBlock(recalled);
        return block || "No matching memory facts.";
      }
      case "reflect_memory": {
        if (
          args.skepticism !== undefined ||
          args.literalism !== undefined ||
          args.empathy !== undefined
        ) {
          await upsertMemoryProfile(userBankId(ctx.userId), {
            skepticism: args.skepticism as number | undefined,
            literalism: args.literalism as number | undefined,
            empathy: args.empathy as number | undefined,
          });
        }
        return await reflectMemory({
          userId: ctx.userId,
          question: String(args.question ?? ""),
          updateOpinion: args.updateOpinion === true,
        });
      }
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
      case "explain_timeline":
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        if (!graphEnabled()) return "Execution graph is disabled.";
        return await explainGraphTimeline(ctx.userId, {
          projectId: String(args.projectId ?? ""),
          startDate: args.startDate ? String(args.startDate) : undefined,
          targetDate: args.targetDate ? String(args.targetDate) : undefined,
        });
      case "propose_timeline":
        if (!canViewMeetings(ctx.userId)) return denyMeetings();
        if (!graphWritesEnabled()) {
          return "Execution graph writes are disabled during read-only rollout.";
        }
        return await createProposedTimeline(ctx.userId, {
          projectId: String(args.projectId ?? ""),
          startDate: args.startDate ? String(args.startDate) : undefined,
          targetDate: args.targetDate ? String(args.targetDate) : undefined,
          tasks: parseTimelineTasks(args.tasks),
        });
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
      case "open_pmo_board":
        return await openPmoBoard(ctx.userId, {
          title: args.title ? String(args.title) : undefined,
          purpose: args.purpose ? String(args.purpose) : undefined,
          columns: args.columns,
          fields: args.fields,
          kanban: args.kanban,
        });
      case "list_pmo_boards":
        return await listPmoBoardsForUser(
          ctx.userId,
          args.status === "closed" || args.status === "all" || args.status === "open"
            ? args.status
            : "open"
        );
      case "list_pmo_board":
        return await listPmoBoardForUser(ctx.userId, String(args.board ?? ""));
      case "add_pmo_item":
        return await addPmoItem(ctx.userId, {
          board: args.board ? String(args.board) : undefined,
          title: args.title ? String(args.title) : undefined,
          detail: args.detail ? String(args.detail) : undefined,
          column: args.column ? String(args.column) : undefined,
          owner: args.owner ? String(args.owner) : undefined,
          due: args.due ? String(args.due) : undefined,
          fields: args.fields,
        });
      case "update_pmo_item":
        return await updatePmoItem(ctx.userId, {
          board: args.board ? String(args.board) : undefined,
          item: args.item ? String(args.item) : undefined,
          title: args.title ? String(args.title) : undefined,
          detail: args.detail ? String(args.detail) : undefined,
          column: args.column ? String(args.column) : undefined,
          owner: args.owner ? String(args.owner) : undefined,
          due: args.due ? String(args.due) : undefined,
          fields: args.fields,
        });
      case "add_pmo_column":
        return await addPmoColumn(ctx.userId, {
          board: args.board ? String(args.board) : undefined,
          label: args.label ? String(args.label) : undefined,
          kind: args.kind ? String(args.kind) : undefined,
        });
      case "close_pmo_board":
        return await closePmoBoard(ctx.userId, String(args.board ?? ""));
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

function parseCheckInUpdates(value: unknown): CheckInUpdate[] {
  if (!Array.isArray(value)) return [];
  const allowedSources = new Set(["work", "commitment", "graph", "pmo"]);
  const allowedStatuses = new Set(["open", "accepted", "blocked", "done"]);
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const source = String(row.source ?? "");
    const id = String(row.id ?? "").trim();
    if (!allowedSources.has(source) || !id) return [];
    const status = row.status ? String(row.status) : undefined;
    return [{
      source: source as CheckInUpdate["source"],
      id,
      status: status && allowedStatuses.has(status)
        ? status as CheckInUpdate["status"]
        : undefined,
      due: "due" in row ? String(row.due ?? "").trim() || null : undefined,
      progressNote: row.progressNote ? String(row.progressNote) : undefined,
    }];
  });
}

function parseEffort(value: unknown): 1 | 2 | 3 | 5 | 8 | undefined {
  const effort = Number(value);
  return [1, 2, 3, 5, 8].includes(effort)
    ? effort as 1 | 2 | 3 | 5 | 8
    : undefined;
}

function parseTimelineTasks(value: unknown): TimelineTaskInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const title = String(row.title ?? "").trim();
    if (!title) return [];
    return [{
      title,
      description: row.description ? String(row.description) : undefined,
      ownerPersonId: row.ownerPersonId ? String(row.ownerPersonId) : undefined,
      effort: parseEffort(row.effort),
      dependsOn: Array.isArray(row.dependsOn)
        ? row.dependsOn.map(Number).filter(Number.isInteger)
        : undefined,
    }];
  });
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
