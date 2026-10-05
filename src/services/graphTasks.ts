/**
 * Microsoft 365 access via the Bot Service OAuth connection. A missing token
 * sends one sign-in card in a personal Teams chat, then retries the delegated
 * token. The capture still lands in the brain if the user has not finished
 * signing in.
 */
import { CloudAdapter, type ConversationReference, TurnContext } from "botbuilder";
import { UserTokenClient } from "botframework-connector";
import type { SignInUrlResponse, TokenExchangeRequest, TokenResponse } from "botframework-schema";
import { isPersonalTeamsConversation } from "../channels/teamsText";
import { getConversationRef } from "./conversations";

export const GRAPH_NOT_SIGNED_IN = "user not signed in to Graph";
export const GRAPH_SIGN_IN_TEXT =
  "Sign in once so I can use your calendar, mail, files, and To Do. After that, Teams and iMessage both work.";

const SIGN_IN_SENT = "taskbrain.graphSignInCardSent";

export function graphConnectionName(): string {
  return process.env.GRAPH_CONNECTION_NAME ?? "graph-connection";
}

export class GraphSignInRequired extends Error {
  constructor() {
    super(GRAPH_NOT_SIGNED_IN);
    this.name = "GraphSignInRequired";
  }
}

type TokenClient = Pick<UserTokenClient, "getUserToken" | "getSignInResource" | "exchangeToken">;

function tokenClient(context: TurnContext): TokenClient | undefined {
  return context.turnState.get<TokenClient>((context.adapter as { UserTokenClientKey?: string }).UserTokenClientKey);
}

export function graphOAuthAttachment(
  connectionName: string,
  resource: SignInUrlResponse
): { contentType: string; content: Record<string, unknown> } | undefined {
  if (!resource.signInLink) return undefined;
  return {
    contentType: "application/vnd.microsoft.card.oauth",
    content: {
      text: GRAPH_SIGN_IN_TEXT,
      connectionName,
      tokenExchangeResource: resource.tokenExchangeResource,
      tokenPostResource: resource.tokenPostResource,
      buttons: [{ type: "signin", title: "Sign in", value: resource.signInLink }],
    },
  };
}

/** Exchange a Teams SSO token when present, then read the stored delegated token. */
export async function exchangeGraphSignIn(
  client: Pick<UserTokenClient, "getUserToken" | "exchangeToken">,
  input: {
    userId: string;
    channelId: string;
    connectionName: string;
    activityName?: string;
    magicCode?: string;
    exchangeToken?: string;
  }
): Promise<string | undefined> {
  let exchanged: TokenResponse | undefined;
  if (input.activityName === "signin/tokenExchange" && input.exchangeToken) {
    const request: TokenExchangeRequest = { token: input.exchangeToken };
    exchanged = await client.exchangeToken(
      input.userId,
      input.connectionName,
      input.channelId,
      request
    );
    if (!exchanged?.token) return undefined;
  }
  const stored = await client.getUserToken(
    input.userId,
    input.connectionName,
    input.channelId,
    input.magicCode ?? ""
  );
  return stored?.token || exchanged?.token || undefined;
}

export async function sendGraphSignInCard(context: TurnContext): Promise<boolean> {
  if (context.turnState.get(SIGN_IN_SENT)) return false;
  if (!isPersonalTeamsConversation(context.activity.conversation?.conversationType)) return false;
  const client = tokenClient(context);
  const userId = context.activity.from?.id;
  if (!client || !userId) return false;
  try {
    const resource = await client.getSignInResource(graphConnectionName(), context.activity, "");
    const attachment = graphOAuthAttachment(graphConnectionName(), resource);
    if (!attachment) return false;
    context.turnState.set(SIGN_IN_SENT, true);
    await context.sendActivity({ attachments: [attachment] });
    return true;
  } catch (err) {
    console.error("[graph] sign-in card failed:", err);
    return false;
  }
}

async function readStoredToken(context: TurnContext, magicCode = ""): Promise<string | undefined> {
  const client = tokenClient(context);
  const userId = context.activity.from?.id;
  if (!client || !userId) return undefined;
  const tokenResponse = await client.getUserToken(
    userId,
    graphConnectionName(),
    context.activity.channelId,
    magicCode
  );
  return tokenResponse?.token || undefined;
}

/** Prompt once, then retry. Throws when the user still has no delegated token. */
export async function ensureGraphUserToken(context: TurnContext): Promise<string> {
  const existing = await readStoredToken(context);
  if (existing) return existing;
  await sendGraphSignInCard(context);
  const retried = await readStoredToken(context);
  if (retried) return retried;
  throw new GraphSignInRequired();
}

export async function completeGraphSignIn(context: TurnContext): Promise<string | undefined> {
  const client = tokenClient(context);
  const userId = context.activity.from?.id;
  if (!client || !userId) return undefined;
  const value = (context.activity.value ?? {}) as { state?: string; token?: string };
  return exchangeGraphSignIn(client, {
    userId,
    channelId: context.activity.channelId,
    connectionName: graphConnectionName(),
    activityName: context.activity.name,
    magicCode: value.state,
    exchangeToken: value.token,
  });
}

export async function getGraphUserToken(context: TurnContext): Promise<string> {
  return ensureGraphUserToken(context);
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
