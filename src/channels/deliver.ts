/**
 * Proactive delivery router. Job results and alerts call deliver(); it sends
 * to the channel the user most recently used, falling back to whatever
 * reference is available. Alerts/orchestrator don't need to know channels.
 */
import { CloudAdapter, ConversationReference, TurnContext } from "botbuilder";
import { getConversationRef, StoredRef } from "../services/conversations";
import { sendIMessage } from "./photon";
import { registerDeliverer } from "../services/alerts";
import { getDeliveryAdapter, getDeliveryAppId, initDeliveryContext } from "./deliveryContext";

export { getDeliveryAdapter, getDeliveryAppId };

export function initDelivery(a: CloudAdapter, appId: string): void {
  initDeliveryContext(a, appId);
  registerDeliverer((userId, text) => deliver(userId, text));
}

export async function deliver(userId: string, text: string, prefer?: StoredRef): Promise<boolean> {
  const gatewayUrl = process.env.DELIVERY_GATEWAY_URL?.replace(/\/+$/, "");
  const gatewayToken = process.env.DELIVERY_GATEWAY_TOKEN;
  if (gatewayUrl && gatewayToken) {
    try {
      const response = await fetch(`${gatewayUrl}/internal/deliver`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId, text, prefer }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return false;
      return Boolean(
        ((await response.json()) as { delivered?: boolean }).delivered
      );
    } catch (err) {
      console.error("[deliver] gateway send failed:", err);
      return false;
    }
  }

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
  const adapter = getDeliveryAdapter();
  const botAppId = getDeliveryAppId();
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
