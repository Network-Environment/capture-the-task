/**
 * Proactive delivery router. Job results and alerts call deliver(); it sends
 * to the channel the user most recently used, falling back to whatever
 * reference is available. Alerts/orchestrator don't need to know channels.
 */
import { CloudAdapter, ConversationReference, TurnContext } from "botbuilder";
import { getConversationRef, StoredRef } from "../services/conversations";
import { sendIMessage } from "./photon";
import { registerDeliverer } from "../services/alerts";

let adapter: CloudAdapter | null = null;
let botAppId = "";

export function initDelivery(a: CloudAdapter, appId: string): void {
  adapter = a;
  botAppId = appId;
  registerDeliverer((userId, text) => deliver(userId, text));
}

export async function deliver(userId: string, text: string, prefer?: StoredRef): Promise<boolean> {
  const ref = prefer ?? (await getConversationRef(userId));
  if (!ref) return false;

  if (ref.channel === "imessage") {
    if (await sendIMessage(userId, stripMd(text))) return true;
    // fall through to Teams if iMessage is down and a Teams ref exists
    const teams = await getConversationRef(userId, "teams");
    return teams ? sendTeams(teams, text) : false;
  }
  return sendTeams(ref, text);
}

async function sendTeams(ref: StoredRef, text: string): Promise<boolean> {
  if (!adapter || !ref.teamsRef) return false;
  try {
    await adapter.continueConversationAsync(
      botAppId,
      ref.teamsRef as Partial<ConversationReference>,
      async (ctx: TurnContext) => {
        await ctx.sendActivity(text);
      }
    );
    return true;
  } catch (err) {
    console.error("[deliver] teams send failed:", err);
    return false;
  }
}

function stripMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}
