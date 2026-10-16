/**
 * Turns activity events TaskBrain already writes into a redacted fixture and
 * replays the deterministic contract. No model, Graph, or Smartsheet calls.
 */

export interface ActivitySlice {
  type: string;
  runId?: string;
  traceId?: string;
  trigger?: string;
  detail?: Record<string, unknown>;
}

export interface PolicyFixture {
  tool?: string;
  effect?: string;
  decision?: string;
  explicit?: boolean;
  approvalId?: string;
}

export interface ToolFixture {
  tool: string;
  effect?: string;
  store?: string;
}

export interface RunFixture {
  runId: string;
  intent?: { disposition?: string; explicit: boolean[]; ambiguous?: boolean };
  policies: PolicyFixture[];
  tools: ToolFixture[];
  approvalIds: string[];
  envelope?: string[];
  terminal: boolean;
  closedWithoutIntent: boolean;
}

export interface ReplayFailure {
  check: string;
  detail: string;
}

const CLOSED_DISPOSITIONS = new Set(["proceed", "clarify", "help", "refuse"]);
const SHARED_EFFECTS = new Set(["shared_write", "destructive", "scheduled", "external_cost"]);
const TOOL_STORES: Record<string, string> = {
  save_note: "notes",
  remember_lesson: "agent-memory",
  retain_memory: "memory-facts",
  reflect_memory: "memory-facts",
  create_graph_project: "graph",
  create_graph_task: "graph",
  update_graph_item: "graph",
  propose_graph_relationship: "graph",
  propose_timeline: "graph",
  lookup_org: "org",
  remember_org_preference: "org",
  remember_org_responsibility: "org",
};

export function toolStore(name: string): string | undefined {
  return TOOL_STORES[name];
}

export function runKey(event: ActivitySlice): string | undefined {
  if (event.runId) return event.runId;
  if (event.traceId) return event.traceId;
  const traced = event.detail?.traceId;
  return traced ? String(traced) : undefined;
}

function boolList(value: unknown): boolean[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is boolean => typeof item === "boolean");
}

function isTerminal(event: ActivitySlice): boolean {
  const detail = event.detail ?? {};
  if (event.type === "request_queue" && (event.trigger === "request_completed" || event.trigger === "request_failed")) {
    return true;
  }
  if (event.type === "clarification" || event.type === "error") return true;
  if (event.type === "agent_turn" && detail.phase === "complete") return true;
  if (event.type === "capture" && detail.noteId) return true;
  if (event.type === "job_run" && detail.status) return true;
  if (event.type === "inbound_quality" && ["clarify", "help", "refuse"].includes(String(detail.disposition))) {
    return true;
  }
  return false;
}

export function fixtureFromActivity(events: ActivitySlice[], runId: string): RunFixture {
  const rows = events.filter((event) => runKey(event) === runId);
  const fixture: RunFixture = {
    runId,
    policies: [],
    tools: [],
    approvalIds: [],
    terminal: false,
    closedWithoutIntent: false,
  };
  for (const event of rows) {
    const detail = event.detail ?? {};
    if (event.type === "intent") {
      fixture.intent = {
        disposition: detail.disposition ? String(detail.disposition) : undefined,
        explicit: boolList(detail.explicit),
        ambiguous: detail.ambiguous === true,
      };
    }
    if (event.type === "policy") {
      const approvalId = detail.approvalId ? String(detail.approvalId) : undefined;
      fixture.policies.push({
        tool: detail.tool ? String(detail.tool) : undefined,
        effect: detail.effect ? String(detail.effect) : undefined,
        decision: detail.decision ? String(detail.decision) : undefined,
        explicit: typeof detail.explicit === "boolean" ? detail.explicit : undefined,
        approvalId,
      });
      if (approvalId) fixture.approvalIds.push(approvalId);
    }
    if (event.type === "tool_call" && detail.tool) {
      fixture.tools.push({
        tool: String(detail.tool),
        effect: detail.effect ? String(detail.effect) : undefined,
        store: detail.store ? String(detail.store) : undefined,
      });
    }
    if (event.type === "job_run" && Array.isArray(detail.allowedTools)) {
      fixture.envelope = detail.allowedTools.map(String);
    }
    if (!fixture.intent && isTerminal(event) && event.type !== "request_queue") {
      fixture.closedWithoutIntent = true;
    }
    if (isTerminal(event)) fixture.terminal = true;
  }
  return fixture;
}

export function replayFixture(fixture: RunFixture): ReplayFailure[] {
  const failures: ReplayFailure[] = [];
  if (!fixture.intent && !fixture.closedWithoutIntent) {
    failures.push({ check: "fail_closed", detail: "intent did not fail closed" });
  } else if (fixture.intent && !CLOSED_DISPOSITIONS.has(String(fixture.intent.disposition))) {
    failures.push({ check: "fail_closed", detail: `disposition ${fixture.intent.disposition ?? "missing"} is not a closed outcome` });
  }
  for (const policy of fixture.policies) {
    const mutating = policy.effect !== undefined && policy.effect !== "read";
    if (policy.explicit === false && mutating && policy.decision === "execute") {
      failures.push({ check: "clarification", detail: `${policy.tool ?? policy.effect} executed an inferred mutation` });
    }
    if (policy.effect && SHARED_EFFECTS.has(policy.effect) && policy.decision === "execute") {
      failures.push({ check: "approval", detail: `${policy.tool ?? policy.effect} executed a shared write` });
    }
    if (policy.decision === "approve" && !policy.approvalId) {
      failures.push({ check: "approval", detail: `${policy.tool ?? policy.effect} approved without an id` });
    }
  }
  for (const tool of fixture.tools) {
    const expected = toolStore(tool.tool);
    if (tool.store && expected && tool.store !== expected) {
      failures.push({ check: "memory_bank", detail: `${tool.tool} wrote ${tool.store} instead of ${expected}` });
    }
    if (fixture.envelope && !fixture.envelope.includes(tool.tool)) {
      failures.push({ check: "envelope", detail: `${tool.tool} is outside the scheduled envelope` });
    }
  }
  if (!fixture.terminal) {
    failures.push({ check: "no_silent_loss", detail: "capture ended without a recorded outcome" });
  }
  return failures;
}
