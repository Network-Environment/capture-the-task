/**
 * Approval gate for write-capable external tools.
 *
 * Reads/searches run freely; tools listed in a server's confirmTools (e.g.
 * smartsheet add_rows / update_rows) are NOT executed inline. The call is
 * parked as a pending-action document (1h TTL, set on the container), the
 * agent reports it as queued, and the bot surfaces an approval card. The user
 * replies "approve <id>" or "deny <id>". This keeps an LLM from writing to
 * the PMO system on a misheard voice memo.
 */
import { logActivity } from "./activityLog";
import { loadConfig } from "../config";
import { randomUUID } from "node:crypto";
import { cosmosContainer } from "./cosmos";
import {
  evaluateOperation,
  type AuthorizationContext,
  type ChannelPolicy,
  type OperationEffect,
} from "./intent";
const serversConfig = loadConfig<{ servers: { name: string; confirmTools?: string[] }[] }>("mcp.servers");

function pending() {
  return cosmosContainer("pending");
}

export interface PendingAction {
  id: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  effect: OperationEffect;
  reason: string;
  status: "pending" | "executing" | "approved" | "denied" | "expired" | "failed";
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string;
  authorization?: AuthorizationContext;
  ttl?: number;
  _etag?: string;
}

const confirmSet: Set<string> = new Set(
  (serversConfig.servers as { name: string; confirmTools?: string[] }[]).flatMap(
    (s) => (s.confirmTools ?? []).map((t) => `${s.name}__${t}`)
  )
);

export function requiresApproval(qualifiedTool: string): boolean {
  return confirmSet.has(qualifiedTool);
}

export function newPendingActionId(): string {
  return `pa-${randomUUID().replaceAll("-", "")}`;
}

export function parseApprovalCommand(
  text: string
): { verb: "approve" | "deny"; id: string } | undefined {
  const match = text.trim().match(/^(approve|deny)\s+(pa-[a-z0-9]+)$/i);
  return match
    ? { verb: match[1].toLowerCase() as "approve" | "deny", id: match[2] }
    : undefined;
}

export async function parkAction(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  options: {
    effect?: OperationEffect;
    reason?: string;
    summary?: string;
    idempotencyKey?: string;
    authorization?: AuthorizationContext;
  } = {}
): Promise<string> {
  const id = newPendingActionId();
  const now = new Date();
  const action: PendingAction = {
    id,
    userId,
    tool,
    args,
    summary: options.summary ?? `${tool}(${JSON.stringify(args).slice(0, 300)})`,
    effect: options.effect ?? "shared_write",
    reason: options.reason ?? "This operation changes an external or shared system.",
    status: "pending",
    idempotencyKey: options.idempotencyKey ?? `${userId}:${tool}:${JSON.stringify(args)}`,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    authorization: options.authorization,
    ttl: 3600,
  };
  await pending().items.create(action);
  return id;
}

/** Returns a user-facing result, or undefined if the text isn't an approval command. */
export async function handleApprovalCommand(
  userId: string,
  text: string,
  currentChannel: ChannelPolicy,
  execute: (action: PendingAction, currentAuthorization: AuthorizationContext) => Promise<string>
): Promise<string | undefined> {
  const command = parseApprovalCommand(text);
  if (!command) return undefined;
  const { verb, id } = command;

  let action: PendingAction | undefined;
  try {
    const { resource } = await pending().item(id, userId).read<PendingAction>();
    action = resource ?? undefined;
  } catch {
    /* not found */
  }
  if (!action || (action.status != null && action.status !== "pending")) {
    return `No pending action ${id} (it may have expired — approvals last 1 hour).`;
  }
  if (Date.parse(action.expiresAt) <= Date.now()) {
    await pending().item(id, userId).replace({ ...action, status: "expired", ttl: 604800 });
    return `Pending action ${id} expired. Ask me to prepare it again.`;
  }
  const currentAuthorization: AuthorizationContext = {
    explicit: true,
    confidence: 1,
    channel: currentChannel,
  };
  const currentDecision = evaluateOperation(
    {
      name: action.tool,
      effect: action.effect,
      reversible: false,
      description: action.summary,
    },
    currentAuthorization
  );
  if (currentDecision.decision === "deny" || currentDecision.decision === "clarify") {
    return `That approval cannot be used from this channel: ${currentDecision.reason}`;
  }

  if (verb === "deny") {
    await pending().item(id, userId).replace(
      { ...action, status: "denied", ttl: 604800 },
      { accessCondition: { type: "IfMatch", condition: action._etag ?? "" } }
    );
    void logActivity({
      type: "tool_call",
      userId,
      origin: "approval",
      channel: "internal",
      trigger: "deny_write",
      detail: { tool: action.tool, approved: false },
    });
    return `Denied — ${action.tool} was not executed.`;
  }

  let result: string;
  try {
    const executing = { ...action, status: "executing" as const, ttl: 3600 };
    const claimed = await pending().item(id, userId).replace(executing, {
      accessCondition: { type: "IfMatch", condition: action._etag ?? "" },
    });
    const claimedAction = claimed.resource as PendingAction | undefined;
    if (!claimedAction) throw new Error("Could not claim pending action.");
    result = await execute(claimedAction, currentAuthorization);
    await pending().item(id, userId).replace({
      ...claimedAction,
      status: "approved",
      ttl: 604800,
    });
  } catch (err) {
    try {
      const { resource: latest } = await pending().item(id, userId).read<PendingAction>();
      if (latest?.status === "executing") {
        await pending().item(id, userId).replace({ ...latest, status: "failed", ttl: 604800 });
      }
    } catch { /* retain the claimed state if final audit write fails */ }
    result = `Execution failed: ${(err as Error).message}`;
  }
  void logActivity({
    type: "tool_call",
    userId,
    origin: "approval",
    channel: "internal",
    trigger: "approve_write",
    detail: { tool: action.tool, approved: true },
  });
  return `Approved and executed ${action.tool}:\n${result.slice(0, 1500)}`;
}
