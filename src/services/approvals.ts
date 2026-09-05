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
import { CosmosClient } from "@azure/cosmos";
import { callMcpTool } from "../tools/mcpClient";
import { logActivity } from "./activityLog";
import { loadConfig } from "../config";
const serversConfig = loadConfig<{ servers: { name: string; confirmTools?: string[] }[] }>("mcp.servers");

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const pending = cosmos
  .database(process.env.COSMOS_DB ?? "taskbrain")
  .container("pending");

interface PendingAction {
  id: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: string;
}

const confirmSet: Set<string> = new Set(
  (serversConfig.servers as { name: string; confirmTools?: string[] }[]).flatMap(
    (s) => (s.confirmTools ?? []).map((t) => `${s.name}__${t}`)
  )
);

export function requiresApproval(qualifiedTool: string): boolean {
  return confirmSet.has(qualifiedTool);
}

export async function parkAction(
  userId: string,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  const id = `pa-${Date.now().toString(36)}`;
  const action: PendingAction = {
    id,
    userId,
    tool,
    args,
    summary: `${tool}(${JSON.stringify(args).slice(0, 300)})`,
    createdAt: new Date().toISOString(),
  };
  await pending.items.create(action);
  return id;
}

/** Returns a user-facing result, or undefined if the text isn't an approval command. */
export async function handleApprovalCommand(
  userId: string,
  text: string
): Promise<string | undefined> {
  const m = text.trim().match(/^(approve|deny)\s+(pa-[a-z0-9]+)$/i);
  if (!m) return undefined;
  const [, verb, id] = m;

  let action: PendingAction | undefined;
  try {
    const { resource } = await pending.item(id, userId).read<PendingAction>();
    action = resource ?? undefined;
  } catch {
    /* not found */
  }
  if (!action) return `No pending action ${id} (it may have expired — approvals last 1 hour).`;

  await pending.item(id, userId).delete();

  if (verb.toLowerCase() === "deny") {
    void logActivity({ type: "tool_call", userId, detail: { tool: action.tool, approved: false } });
    return `Denied — ${action.tool} was not executed.`;
  }

  const result = await callMcpTool(action.tool, action.args);
  void logActivity({ type: "tool_call", userId, detail: { tool: action.tool, approved: true } });
  return `Approved and executed ${action.tool}:\n${result.slice(0, 1500)}`;
}

export function approvalMessage(id: string, tool: string, args: Record<string, unknown>): string {
  return (
    `⚠️ Write action held for approval:\n**${tool}**\n` +
    "```\n" + JSON.stringify(args, null, 2).slice(0, 800) + "\n```\n" +
    `Reply **approve ${id}** or **deny ${id}** (expires in 1 hour).`
  );
}
