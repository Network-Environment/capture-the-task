/**
 * Microsoft To Do task creation via Graph, using the Bot Service OAuth
 * connection (delegated Tasks.ReadWrite). If the user hasn't consented yet,
 * this throws and the bot falls back to filing the task in the brain — the
 * capture is never lost to an auth prompt.
 *
 * To enable: add an OAuth connection named GRAPH_CONNECTION_NAME on the Azure
 * Bot resource pointing at the same Entra app, scope Tasks.ReadWrite.
 */
import { CloudAdapter, type ConversationReference, TurnContext } from "botbuilder";
import { UserTokenClient } from "botframework-connector";
import { getConversationRef } from "./conversations";

const CONNECTION = process.env.GRAPH_CONNECTION_NAME ?? "graph-connection";

export async function getGraphUserToken(context: TurnContext): Promise<string> {
  const tokenClient = context.turnState.get<UserTokenClient>(
    (context.adapter as any).UserTokenClientKey
  );
  if (!tokenClient) throw new Error("no token client");

  const tokenResponse = await tokenClient.getUserToken(
    context.activity.from.id,
    CONNECTION,
    context.activity.channelId,
    ""
  );
  if (!tokenResponse?.token) throw new Error("user not signed in to Graph");
  return tokenResponse.token;
}

/** The requester's Teams sign-in, usable from any channel that maps to the same user. */
export async function graphAccessForUser(
  adapter: CloudAdapter,
  botAppId: string,
  userId: string
): Promise<
  | {
      getGraphToken: () => Promise<string>;
      createTask: (title: string, detail?: string, due?: string) => Promise<void>;
    }
  | undefined
> {
  const stored = await getConversationRef(userId, "teams");
  const ref = stored?.teamsRef;
  if (!botAppId || !ref?.user?.id) return undefined;
  try {
    let token = "";
    await adapter.continueConversationAsync(
      botAppId,
      ref as Partial<ConversationReference>,
      async (ctx) => {
        token = await getGraphUserToken(ctx);
      }
    );
    if (!token) return undefined;
    return {
      getGraphToken: async () => token,
      createTask: (title, detail, due) => createTodoTaskWithToken(token, title, detail, due),
    };
  } catch (err) {
    console.error("[graph] delegated token lookup failed:", err);
    return undefined;
  }
}

export async function createTodoTaskWithToken(
  token: string,
  title: string,
  detail?: string,
  dueIso?: string
): Promise<void> {

  // Default task list
  const listsRes = await fetch(
    "https://graph.microsoft.com/v1.0/me/todo/lists?$top=1&$filter=wellknownListName eq 'defaultList'",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listsRes.ok) throw new Error(`graph lists: ${listsRes.status}`);
  const lists = (await listsRes.json()) as { value: { id: string }[] };
  const listId = lists.value[0]?.id;
  if (!listId) throw new Error("no default To Do list");

  const body: Record<string, unknown> = {
    title,
    ...(detail ? { body: { content: detail, contentType: "text" } } : {}),
    ...(dueIso
      ? {
          dueDateTime: {
            dateTime: `${dueIso}T17:00:00`,
            timeZone: "Central Standard Time",
          },
        }
      : {}),
  };

  const createRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!createRes.ok) throw new Error(`graph create task: ${createRes.status}`);
}

export async function createTodoTask(
  context: TurnContext,
  title: string,
  detail?: string,
  dueIso?: string
): Promise<void> {
  await createTodoTaskWithToken(await getGraphUserToken(context), title, detail, dueIso);
}
