/**
 * Channel primitives shared by adapters.
 *
 * Identity is the crux of multi-channel: the second brain is partitioned by
 * a canonical userId (Entra object id). Teams gives it to us directly; other
 * channels (a phone number on iMessage) must be resolved through
 * config/channels.json. Unknown senders are rejected — never auto-provision a
 * brain for an unrecognized phone number.
 */
import { loadConfig } from "../config";
const channelsConfig = loadConfig("channels");

export type Channel = "teams" | "imessage";

interface ChannelsConfig {
  imessage: {
    enabled: boolean;
    allowActions: boolean;
    identities: Record<string, string>; // E.164 phone → canonical userId
  };
}

const cfg = channelsConfig as ChannelsConfig;

export function imessageEnabled(): boolean {
  return cfg.imessage.enabled && !!process.env.SPECTRUM_PROJECT_ID;
}

export function imessageAllowsActions(): boolean {
  return cfg.imessage.allowActions;
}

/** Resolve an iMessage sender (E.164) to the canonical userId, or undefined. */
export function resolveIMessageUser(phone: string): string | undefined {
  return cfg.imessage.identities[phone];
}

/** Reverse lookup: canonical userId → phone, for proactive delivery. */
export function phoneForUser(userId: string): string | undefined {
  return Object.entries(cfg.imessage.identities).find(([, u]) => u === userId)?.[0];
}

/** Strip markdown-ish formatting for channels that render plain text. */
export function toPlainText(title: string, body: string, tags: string[]): string {
  const clean = body
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[(.+?)\]\]/g, "$1");
  const tagLine = tags.length ? `\n${tags.map((t) => `#${t}`).join(" ")}` : "";
  return `${title}\n${clean}${tagLine}`.trim();
}
