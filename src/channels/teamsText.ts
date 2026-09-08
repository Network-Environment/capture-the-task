/**
 * Teams mention / conversation helpers. Channel and group-chat messages
 * wrap the bot in <at>…</at>; that markup must not reach triage. Proactive
 * delivery stays on the 1:1 chat, so channel conversation types are treated
 * as ephemeral replies only.
 */
export type TeamsMention = {
  type?: string;
  text?: string;
  mentioned?: { id?: string; name?: string };
};

export function isPersonalTeamsConversation(conversationType?: string): boolean {
  return !conversationType || conversationType === "personal";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionIsBot(e: TeamsMention, botId?: string, botName?: string): boolean {
  if (e.type !== "mention") return false;
  const id = e.mentioned?.id;
  const name = e.mentioned?.name?.toLowerCase();
  if (botId && id && id === botId) return true;
  if (botName && name && name === botName.toLowerCase()) return true;
  return false;
}

/** True when this activity @mentioned the bot (channel/groupChat gate). */
export function botWasMentioned(
  entities: TeamsMention[] | undefined,
  botId?: string,
  botName?: string,
  text?: string
): boolean {
  if ((entities ?? []).some((e) => mentionIsBot(e, botId, botName))) return true;
  if (botName && text) {
    return new RegExp(`<at>[^<]*${escapeRe(botName)}[^<]*</at>`, "i").test(text);
  }
  return false;
}

/** Remove the bot's @mention markup; leave mentions of other people intact. */
export function stripBotMention(
  text: string | undefined,
  entities: TeamsMention[] | undefined,
  bot: { id?: string; name?: string }
): string {
  let out = text ?? "";
  for (const e of entities ?? []) {
    if (!mentionIsBot(e, bot.id, bot.name) || !e.text) continue;
    out = out.split(e.text).join("");
  }
  if (bot.name) {
    out = out.replace(new RegExp(`<at>\\s*${escapeRe(bot.name)}\\s*</at>`, "gi"), "");
  }
  return out.replace(/\s+/g, " ").trim();
}
