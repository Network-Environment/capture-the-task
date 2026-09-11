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
import type { ChannelPolicy } from "../services/intent";
const channelsConfig = loadConfig("channels");

export type Channel = "teams" | "imessage";
export const THINKING_RESPONSE = "thinking about response";

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

export function channelPolicy(
  channel: Channel,
  options: {
    scope?: "private" | "group";
    identity?: "canonical" | "mapped" | "weak";
    allowActions?: boolean;
  } = {}
): ChannelPolicy {
  const allow = options.allowActions ?? (channel === "teams" || imessageAllowsActions());
  return {
    channel,
    scope: options.scope ?? "private",
    identity: options.identity ?? (channel === "teams" ? "canonical" : "mapped"),
    allowReads: true,
    allowPersonalWrites: allow && options.scope !== "group" && options.identity !== "weak",
    allowSharedWrites: allow && options.scope !== "group" && options.identity !== "weak",
    approvalUx: channel === "teams" ? "adaptive_card" : "text",
  };
}

/** Required registration envelope for every interactive channel adapter. */
export function channelEnvelope(
  channel: Channel,
  options: {
    eventId: string | undefined;
    conversationId: string | undefined;
    scope: "private" | "group";
    identity: "canonical" | "mapped" | "weak";
    allowActions: boolean;
  }
): { eventId: string; conversationId: string; policy: ChannelPolicy } {
  if (!options.eventId) throw new Error(`${channel} inbound message is missing a stable event id`);
  if (!options.conversationId) throw new Error(`${channel} inbound message is missing conversation scope`);
  return {
    eventId: options.eventId,
    conversationId: options.conversationId,
    policy: channelPolicy(channel, options),
  };
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
