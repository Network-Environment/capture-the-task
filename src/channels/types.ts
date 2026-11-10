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
/** Nameless last-resort receipt when a personalized acknowledgement cannot be composed. */
export const WORKING_RESPONSE = "Received — I’ll follow up with the result.";

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

/** Stable iMessage thread key. The allowlist phone, not Photon's space id. */
export function imessageConversationId(phone: string): string {
  return `imessage:${phone}`;
}

/** Resolve an iMessage sender (E.164) to the canonical userId, or undefined. */
export function resolveIMessageUser(phone: string): string | undefined {
  return cfg.imessage.identities[phone];
}

/** Every canonical userId reachable over iMessage. */
export function imessageUserIds(): string[] {
  return [...new Set(Object.values(cfg.imessage.identities))];
}

/** Reverse lookup: canonical userId → phone, for proactive delivery. */
export function phoneForUser(userId: string): string | undefined {
  return Object.entries(cfg.imessage.identities).find(([, u]) => u === userId)?.[0];
}

/**
 * Plain text for SMS/iMessage: no emphasis, code, or link syntax.
 * Tables become one line per row, headers become plain lines, and bullets
 * become "•" so the structure survives without markdown.
 */
export function toPlainText(title: string, body: string, tags: string[]): string {
  return renderChatText(title, body, tags, { keepEmphasis: false });
}

/**
 * Teams text messages render basic markdown (bold, links), so keep those.
 * Tables and headers still do not render, so flatten them the same way.
 */
export function toTeamsText(title: string, body: string, tags: string[]): string {
  return renderChatText(title, body, tags, { keepEmphasis: true });
}

function renderChatText(
  title: string,
  body: string,
  tags: string[],
  options: { keepEmphasis: boolean }
): string {
  let clean = body
    .replace(/^\s*\|?\s*:?-{3,}[-:|\s]*$/gm, "") // table separator rows and rules
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) =>
      row
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" — ")
    )
    .replace(/^\s*#{1,6}\s+(.+)$/gm, "$1") // markdown headers
    .replace(/^(\s*)[-*]\s+/gm, "$1• ") // bullets
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)") // links keep their URL
    .replace(/\[\[(.+?)\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
  if (!options.keepEmphasis) clean = clean.replace(/\*\*(.+?)\*\*/g, "$1");
  const tagLine = tags.length ? `\n${tags.map((t) => `#${t}`).join(" ")}` : "";
  return `${title}\n${clean}${tagLine}`.trim();
}
