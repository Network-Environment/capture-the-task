/**
 * Who can reach TaskBrain, on which channels, and which Microsoft 365
 * surfaces that sign-in opens. A stored Teams chat is the sign-in path;
 * this view does not probe Exchange mailbox ACLs.
 */
import type { OrgPerson } from "../org/types";
import { esc, pill, table } from "./markup";

export interface ChannelAccessInput {
  identities: Record<string, string>;
  people: Pick<OrgPerson, "displayName" | "entraId" | "status">[];
  conversations: { userId: string; channel: "teams" | "imessage"; phone?: string }[];
  sharedMailbox: string;
}

export interface ChannelAccessRow {
  userId: string;
  name: string;
  orgStatus?: string;
  phones: string[];
  teams: boolean;
  imessage: boolean;
  signedIn: boolean;
}

export interface ChannelAccessView {
  sharedMailbox: string;
  rows: ChannelAccessRow[];
}

export function buildChannelAccess(input: ChannelAccessInput): ChannelAccessView {
  const byId = new Map<string, ChannelAccessRow>();
  const ensure = (userId: string): ChannelAccessRow => {
    const id = userId.trim();
    const key = id.toLowerCase();
    const existing = byId.get(key);
    if (existing) return existing;
    const row: ChannelAccessRow = {
      userId: id,
      name: id,
      phones: [],
      teams: false,
      imessage: false,
      signedIn: false,
    };
    byId.set(key, row);
    return row;
  };

  for (const person of input.people) {
    const id = person.entraId?.trim();
    if (!id) continue;
    const row = ensure(id);
    row.name = person.displayName || row.name;
    row.orgStatus = person.status;
  }
  for (const [phone, userId] of Object.entries(input.identities)) {
    if (!userId?.trim() || !phone.trim()) continue;
    const row = ensure(userId);
    row.imessage = true;
    if (!row.phones.includes(phone)) row.phones.push(phone);
  }
  for (const convo of input.conversations) {
    if (!convo.userId?.trim()) continue;
    const row = ensure(convo.userId);
    if (convo.channel === "teams") {
      row.teams = true;
      row.signedIn = true;
    }
    if (convo.channel === "imessage") {
      row.imessage = true;
      if (convo.phone && !row.phones.includes(convo.phone)) row.phones.push(convo.phone);
    }
  }

  const rows = [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  return { sharedMailbox: input.sharedMailbox.trim().toLowerCase(), rows };
}

function mailCell(row: ChannelAccessRow, sharedMailbox: string): string {
  if (!row.signedIn) {
    return `${pill("needs sign-in", "warn")}<div class="muted">Sign in once in Teams. After that, own mail and the shared mailbox work on every channel.</div>`;
  }
  const shared = sharedMailbox
    ? `Shared mailbox ${sharedMailbox}: search on every channel.`
    : "No shared mailbox is configured.";
  return `${pill("every channel", "ok")}<div class="muted">Own mailbox: search, draft, and send. ${esc(shared)} Calendar, files, and To Do use the same sign-in.</div>`;
}

export function renderChannelAccess(view: ChannelAccessView): string {
  const shared = view.sharedMailbox
    ? pill(view.sharedMailbox, "info")
    : pill("not configured", "warn");
  const rows = view.rows
    .map((row) => {
      const channels = [
        row.teams ? pill("Teams", "ok") : pill("Teams", "idle"),
        row.imessage ? pill("iMessage", "ok") : pill("iMessage", "idle"),
      ].join(" ");
      const phones = row.phones.length
        ? `<div class="mono">${row.phones.map((phone) => esc(phone)).join("<br>")}</div>`
        : `<div class="muted">no number</div>`;
      const who = `<div class="strong">${esc(row.name)}</div><div class="mono muted">${esc(row.userId)}</div>`;
      const status = row.orgStatus ? pill(row.orgStatus, row.orgStatus === "active" ? "ok" : "idle") : pill("unlisted", "idle");
      return `<tr><td>${who}</td><td>${status}</td><td>${channels}${phones}</td><td>${mailCell(row, view.sharedMailbox)}</td></tr>`;
    })
    .join("");
  return `<p class="lede">Same Microsoft 365 sign-in on Teams and iMessage. A Teams chat on file means that person can use it from either channel. This does not read Exchange permissions.</p>
    <section class="panel"><h2>Shared mailbox</h2><p class="pad">${shared} <span class="muted">Search only. Drafts and sends stay on the person's own mailbox.</span></p></section>
    <section class="panel"><h2>People</h2>${table(
      ["Person", "Org", "Channels", "What they can use"],
      rows,
      "No mapped people yet."
    )}</section>`;
}
