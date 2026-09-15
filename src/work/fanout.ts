import { CardFactory, ConversationReference, TurnContext } from "botbuilder";
import { getConversationRef } from "../services/conversations";
import { getDeliveryAdapter, getDeliveryAppId } from "../channels/deliveryContext";
import type { OrgPerson } from "../org/types";
import { defaultQueues } from "../org/prefs";
import { maybeProposeSheetUpdate } from "../services/smartsheet";
import { workAdaptiveCard } from "./cards";
import { graphAppFetch, graphAppJson } from "./graphApp";
import { upsertWork } from "./store";
import type { WorkAssignment, WorkDestination } from "./types";

async function notifyUserText(userId: string, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  const appId = getDeliveryAppId();
  const ref = await getConversationRef(userId, "teams");
  if (!adapter || !appId || !ref?.teamsRef) return;
  try {
    await adapter.continueConversationAsync(
      appId,
      ref.teamsRef as Partial<ConversationReference>,
      async (ctx: TurnContext) => {
        await ctx.sendActivity(text);
      }
    );
  } catch (err) {
    console.error("[work] requester notify failed:", err);
  }
}

export { notifyUserText };

function adaptiveAttachment(work: WorkAssignment, notice?: string) {
  return {
    id: "1",
    contentType: "application/vnd.microsoft.card.adaptive",
    content: JSON.stringify(workAdaptiveCard(work, notice)),
  };
}

async function sendTeamsCardViaRef(entraId: string, work: WorkAssignment, notice?: string): Promise<boolean> {
  const adapter = getDeliveryAdapter();
  const appId = getDeliveryAppId();
  const ref = await getConversationRef(entraId, "teams");
  if (!adapter || !appId || !ref?.teamsRef) return false;
  try {
    await adapter.continueConversationAsync(
      appId,
      ref.teamsRef as Partial<ConversationReference>,
      async (ctx: TurnContext) => {
        await ctx.sendActivity({
          attachments: [CardFactory.adaptiveCard(workAdaptiveCard(work, notice))],
        });
      }
    );
    return true;
  } catch (err) {
    console.error("[work] teams ref send failed:", err);
    return false;
  }
}

async function graphPostChatCard(entraId: string, work: WorkAssignment, notice?: string): Promise<string | undefined> {
  const created = await graphAppJson<{ id: string }>("/chats", {
    method: "POST",
    body: JSON.stringify({
      chatType: "oneOnOne",
      members: [
        {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "kevin.m@example.com": `https://graph.microsoft.com/v1.0/users('${entraId}')`,
        },
      ],
    }),
  });
  if (!created.id) return undefined;
  await graphAppJson(`/chats/${created.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      body: { contentType: "html", content: `<attachment id="1"></attachment>` },
      attachments: [adaptiveAttachment(work, notice)],
    }),
  });
  return created.id;
}

async function graphPostChannelCard(
  work: WorkAssignment,
  person: OrgPerson,
  notice?: string
): Promise<string | undefined> {
  const team = process.env.FOLLOWTHROUGH_TEAM_ID;
  const channel = process.env.FOLLOWTHROUGH_CHANNEL_ID;
  if (!team || !channel || !person.entraId) return undefined;
  const mention = person.displayName.replace(/[<>]/g, "");
  const sent = await graphAppJson<{ id: string }>(
    `/teams/${team}/channels/${channel}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        body: {
          contentType: "html",
          content: `<at id="0">${mention}</at> ${work.title.slice(0, 200)} <attachment id="1"></attachment>`,
        },
        mentions: [
          {
            id: 0,
            mentionText: mention,
            mentioned: { user: { id: person.entraId, displayName: mention } },
          },
        ],
        attachments: [adaptiveAttachment(work, notice)],
      }),
    }
  );
  return sent.id;
}

async function sendMailFallback(person: OrgPerson, work: WorkAssignment): Promise<boolean> {
  const from = process.env.FOLLOWTHROUGH_MAIL_FROM;
  if (!from || !person.entraId) return false;
  const profile = await graphAppJson<{ mail?: string; userPrincipalName?: string }>(
    `/users/${person.entraId}?$select=mail,userPrincipalName`
  );
  const to = profile.mail || profile.userPrincipalName;
  if (!to) return false;
  await graphAppFetch("/users/" + encodeURIComponent(from) + "/sendMail", {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: `TaskBrain: ${work.title.slice(0, 80)}`,
        body: {
          contentType: "Text",
          content: `${work.title}\n${work.detail ?? ""}\nDue: ${work.due ?? "none"}\nMark done in Teams or reply to TaskBrain.`,
        },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
  return true;
}

export async function notifyOwnerCard(
  person: OrgPerson,
  work: WorkAssignment,
  notice?: string
): Promise<WorkDestination> {
  const nudge = person.nudgeChannel ?? "teams_card";
  if (nudge === "silent") return { kind: "teams", error: "silent" };

  if (nudge === "imessage" && person.entraId) {
    const text = `Work: ${work.title}${work.due ? ` (due ${work.due.slice(0, 10)})` : ""}`;
    try {
      const { sendIMessage } = await import("../channels/photon.js");
      if (await sendIMessage(person.entraId, text)) return { kind: "imessage", id: person.entraId };
    } catch (err) {
      console.error("[work] imessage nudge failed:", err);
    }
  }

  if (person.entraId && nudge !== "email") {
    if (await sendTeamsCardViaRef(person.entraId, work, notice)) {
      return { kind: "teams", id: person.entraId };
    }
    try {
      const chatId = await graphPostChatCard(person.entraId, work, notice);
      if (chatId) return { kind: "teams", id: chatId };
    } catch (err) {
      console.error("[work] graph 1:1 failed:", err);
    }
    try {
      const msgId = await graphPostChannelCard(work, person, notice);
      if (msgId) return { kind: "teams", extra: "channel", id: msgId };
    } catch (err) {
      console.error("[work] graph channel failed:", err);
    }
  }

  if (nudge === "email" || person.nudgeChannel === "email") {
    try {
      if (await sendMailFallback(person, work)) return { kind: "email" };
    } catch (err) {
      console.error("[work] mail fallback failed:", err);
    }
  }

  // Last-resort mail if Teams delivery failed.
  try {
    if (await sendMailFallback(person, work)) return { kind: "email" };
  } catch (err) {
    console.error("[work] mail last-resort failed:", err);
  }

  const requester = work.requesterUserId;
  if (requester) {
    await notifyUserText(
      requester,
      `Could not reach ${person.displayName} on Teams for: ${work.title}. They have no stored chat yet.`
    );
  }
  return { kind: "teams", error: "undelivered" };
}

async function createTodoForOwner(entraId: string, work: WorkAssignment): Promise<WorkDestination> {
  const lists = await graphAppJson<{ value: { id: string }[] }>(
    `/users/${entraId}/todo/lists?$top=1&$filter=wellknownListName eq 'defaultList'`
  );
  const listId = lists.value?.[0]?.id;
  if (!listId) return { kind: "todo", error: "no default list" };
  const created = await graphAppJson<{ id: string }>(`/users/${entraId}/todo/lists/${listId}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      title: work.title,
      ...(work.detail ? { body: { content: work.detail, contentType: "text" } } : {}),
      ...(work.due
        ? {
            dueDateTime: {
              dateTime: `${work.due.slice(0, 10)}T17:00:00`,
              timeZone: "Central Standard Time",
            },
          }
        : {}),
    }),
  });
  return { kind: "todo", id: created.id, extra: listId };
}

async function completeTodo(dest: WorkDestination, entraId: string): Promise<void> {
  if (!dest.id || !dest.extra) return;
  await graphAppFetch(`/users/${entraId}/todo/lists/${dest.extra}/tasks/${dest.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed" }),
  });
}

async function createPlannerTask(entraId: string, work: WorkAssignment): Promise<WorkDestination> {
  const planId = process.env.PLANNER_PLAN_ID;
  if (!planId) return { kind: "planner", error: "PLANNER_PLAN_ID unset" };
  const body: Record<string, unknown> = {
    planId,
    title: work.title,
    assignments: {
      [entraId]: {
        "@odata.type": "#microsoft.graph.plannerAssignment",
        orderHint: " !",
      },
    },
  };
  if (process.env.PLANNER_BUCKET_ID) body.bucketId = process.env.PLANNER_BUCKET_ID;
  if (work.due) body.dueDateTime = `${work.due.slice(0, 10)}T17:00:00Z`;
  const created = await graphAppJson<{ id: string }>(`/planner/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { kind: "planner", id: created.id };
}

async function completePlanner(dest: WorkDestination): Promise<void> {
  if (!dest.id) return;
  const res = await graphAppFetch(`/planner/tasks/${dest.id}`, { method: "GET" });
  const etag = res.headers.get("ETag") ?? res.headers.get("etag");
  await graphAppFetch(`/planner/tasks/${dest.id}`, {
    method: "PATCH",
    extraHeaders: etag ? { "If-Match": etag } : {},
    body: JSON.stringify({ percentComplete: 100 }),
  });
}

async function smartsheetDestination(userId: string, work: WorkAssignment): Promise<WorkDestination> {
  const parked = await maybeProposeSheetUpdate(userId, {
    title: work.title,
    detail: work.detail,
    due: work.due,
  });
  if (!parked) return { kind: "smartsheet", error: "no high-confidence catalog match" };
  return { kind: "smartsheet", extra: parked.slice(0, 240) };
}

export async function fanOutWork(person: OrgPerson, work: WorkAssignment): Promise<WorkAssignment> {
  const destinations: WorkDestination[] = [];
  const nudge = await notifyOwnerCard(person, work);
  destinations.push(nudge);

  const queues = defaultQueues(person);
  if (person.entraId && queues.includes("todo")) {
    try {
      destinations.push(await createTodoForOwner(person.entraId, work));
    } catch (err) {
      destinations.push({ kind: "todo", error: (err as Error).message.slice(0, 200) });
    }
  }
  if (person.entraId && queues.includes("planner")) {
    try {
      destinations.push(await createPlannerTask(person.entraId, work));
    } catch (err) {
      destinations.push({ kind: "planner", error: (err as Error).message.slice(0, 200) });
    }
  }
  if (queues.includes("smartsheet")) {
    try {
      destinations.push(await smartsheetDestination(work.requesterUserId ?? person.entraId ?? person.id, work));
    } catch (err) {
      destinations.push({ kind: "smartsheet", error: (err as Error).message.slice(0, 200) });
    }
  }

  return upsertWork({ ...work, destinations, updatedAt: new Date().toISOString() });
}

export async function completeDestinations(work: WorkAssignment): Promise<void> {
  const entraId = work.entraId;
  for (const dest of work.destinations) {
    try {
      if (dest.kind === "todo" && entraId) await completeTodo(dest, entraId);
      if (dest.kind === "planner") await completePlanner(dest);
    } catch (err) {
      console.error(`[work] complete ${dest.kind} failed:`, err);
    }
  }
}

export async function commentPlannerNudge(work: WorkAssignment): Promise<void> {
  const dest = work.destinations.find((d) => d.kind === "planner" && d.id);
  if (!dest?.id) return;
  try {
    await graphAppJson(`/planner/tasks/${dest.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: `Nudge: still open — ${work.title}` }),
    });
  } catch {
    // Planner comments API is limited; ignore.
  }
}
