/**
 * Alerts — push, not just dashboard. Delivery is channel-agnostic and
 * LATE-BOUND: channels/deliver.ts registers itself at startup. This avoids
 * an import cycle (router → alerts → deliver → photon → pipeline → agent →
 * router) and keeps the core services free of channel dependencies.
 */
import { logActivity } from "./activityLog";

type Deliverer = (userId: string, text: string) => Promise<boolean>;
let deliverer: Deliverer | null = null;

export function registerDeliverer(fn: Deliverer): void {
  deliverer = fn;
}

export async function alertUser(userId: string, text: string): Promise<boolean> {
  if (!deliverer) {
    console.warn(`[alerts] no deliverer registered yet: ${text}`);
    return false;
  }
  const ok = await deliverer(userId, `🔔 ${text}`);
  if (!ok) console.warn(`[alerts] undeliverable to ${userId}: ${text}`);
  return ok;
}

export async function alertAdmin(text: string): Promise<void> {
  void logActivity({ type: "error", detail: { alert: text } });
  const admin = process.env.ADMIN_AAD_OBJECT_ID;
  if (admin) await alertUser(admin, `[admin] ${text}`);
}
