import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_MS = 5 * 60_000;

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhook(input: {
  secret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  now?: number;
}): string | undefined {
  if (!input.secret) return "webhook secret is not configured";
  if (!input.timestamp || !input.signature) return "missing signature";
  const sent = Date.parse(input.timestamp);
  if (!Number.isFinite(sent)) return "invalid timestamp";
  if (Math.abs((input.now ?? Date.now()) - sent) > MAX_SKEW_MS) return "timestamp is outside the allowed window";
  const expected = signWebhook(input.secret, input.timestamp, input.body);
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "signature does not match";
  return undefined;
}

export interface GraphNotification {
  clientState?: string;
  changeType?: string;
  resource?: string;
}

/** Graph echoes validationToken and sends clientState on each notification. */
export function acceptGraphNotification(
  clientState: string | undefined,
  notifications: GraphNotification[]
): string | undefined {
  if (!clientState) return "graph webhook client state is not configured";
  if (!notifications.length) return "empty notification";
  if (notifications.some((item) => item.clientState !== clientState)) return "client state does not match";
  return undefined;
}
