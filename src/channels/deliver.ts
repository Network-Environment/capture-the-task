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
import { imessageConversationId } from "./types";
import { recordConversationTurn } from "../services/sessionFold";

export { getDeliveryAdapter, getDeliveryAppId };

export function initDelivery(a: CloudAdapter, appId: string): void {
  initDeliveryContext(a, appId);
  registerDeliverer((userId, text) => deliver(userId, text));
}

export async function deliver(
  userId: string,
  text: string,
  prefer?: StoredRef,
  options?: { recordTurn?: boolean }
): Promise<boolean> {
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
        body: JSON.stringify({ userId, text, prefer, recordTurn: options?.recordTurn === true }),
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

  let sent: StoredRef | undefined;
  if (ref.channel === "imessage") {
    if (await sendIMessage(userId, stripMd(text))) sent = ref;
    else {
      const teams = await getConversationRef(userId, "teams");
      if (teams && (await sendTeams(teams, text))) sent = teams;
    }
  } else if (await sendTeams(ref, text)) {
    sent = ref;
  }
  if (sent && options?.recordTurn) await rememberDelivery(userId, text, sent);
  return Boolean(sent);
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

async function rememberDelivery(userId: string, text: string, ref: StoredRef): Promise<void> {
  const conversationId =
    ref.channel === "imessage" && ref.phone
      ? imessageConversationId(ref.phone)
      : ref.teamsRef?.conversation?.id;
  await recordConversationTurn({
    userId,
    role: "assistant",
    text,
    body: text,
    conversationId,
    scope: "private",
    channel: ref.channel,
    intent: "proactive",
  });
}
