/**
 * Personalized one-line acknowledgements. The cheap model writes the line;
 * a timeout, empty reply, or completion claim falls back to a template.
 * Greetings and probes are a full reply and are not queued.
 */
import type { Channel } from "./types";
import { WORKING_RESPONSE } from "./types";
import { route } from "../services/router";
import { listOrgByKind } from "../org/store";
import { resolvePerson } from "../org/resolve";
import type { OrgPerson } from "../org/types";
import { socialOnlyKind, type SocialKind } from "../services/inboundQuality";
import { graphAppJson } from "../work/graphApp";

export const ACK_TIMEOUT_MS = 1_000;
export const PENDING_ACK_GRACE_MS = 20_000;
export const PENDING_ACK_LEASE_MS = 30_000;
export const PENDING_ACK_MAX_ATTEMPTS = 3;
const ACK_MAX_CHARS = 140;
const NAME_CACHE_MS = 5 * 60_000;

export type AckKind = "reply" | "receipt";

export interface AckDraft {
  kind: AckKind;
  text: string;
  firstName?: string;
  social?: SocialKind;
}

export interface AckContext {
  userId: string;
  channel: Channel;
  text: string;
  displayNameHint?: string;
}

export interface AckPrompt {
  kind: AckKind;
  social?: SocialKind;
  name?: string;
  text: string;
  channel: Channel;
}

export type AckGenerator = (input: AckPrompt) => Promise<string | null>;

export interface ComposeDeps {
  generate?: AckGenerator;
  resolveName?: (userId: string, hint?: string) => Promise<string | undefined>;
  timeoutMs?: number;
}

/** First token, or the given name in a "Last, First" display name. */
export function firstNameFrom(displayName: string | undefined): string | undefined {
  const raw = displayName?.trim().replace(/\s+/g, " ");
  if (!raw) return undefined;
  const comma = raw.match(/^[^,]+,\s*(\p{L}[\p{L}\p{N}'’-]*)$/u)
    ?? raw.match(/^[^,]+,\s*(\p{L}[\p{L}\p{N}'’-]*)/u);
  if (comma?.[1]) return comma[1];
  const token = raw.split(" ")[0]?.replace(/[,.]+$/g, "");
  if (!token || token.includes("@") || !/\p{L}/u.test(token)) return undefined;
  return token;
}

const QUEUE_JARGON = /\bqueue\b|\brequest id\b/i;
const COMPLETION_CLAIM =
  /\b(?:i['’]ve|i have|i)\s+(?:saved|filed|scheduled|created|approved|done)\b/i;
const DONE_DASH = /(?:^|\s)done\s*[—–-]/i;

/** One visible sentence. Completion claims and queue jargon are rejected. */
export function sanitizeAck(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (QUEUE_JARGON.test(text) || COMPLETION_CLAIM.test(text) || DONE_DASH.test(text)) {
    return undefined;
  }
  if (text.length > 180) return undefined;
  if (text.length > ACK_MAX_CHARS) {
    const cut = text.slice(0, ACK_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return text || undefined;
}

export function fallbackAck(
  kind: AckKind,
  social: SocialKind | undefined,
  name?: string
): string {
  if (kind === "reply" && social === "probe") {
    return name
      ? `Test received, ${name} — nothing was saved. Ask what I can do, or send a complete thought.`
      : "Test received — nothing was saved. Ask what I can do, or send a complete thought.";
  }
  if (kind === "reply") {
    return name ? `Hey ${name} — what can I do for you?` : "Hey — what can I do for you?";
  }
  return name ? `Got it, ${name} — on it.` : WORKING_RESPONSE;
}

export function attachedAck(name?: string): string {
  return name
    ? `Adding that to what I’m already doing, ${name}.`
    : "Adding that to what I’m already doing.";
}

export function missedAckMessage(name: string | undefined, replyText: string): string {
  const lead = name
    ? `Sorry ${name} — I got that and the reply didn’t go out.`
    : "Sorry — I got that and the reply didn’t go out.";
  const reply = replyText.trim();
  return reply ? `${lead} ${reply}` : lead;
}

export interface PendingAckClock {
  status?: string;
  receivedAt?: string;
  sendLeaseUntil?: string;
  nextAttemptAt?: string;
}

/** A live send lease, or a row younger than the grace period, is left to the immediate send. */
export function pendingAckEligible(row: PendingAckClock, now = Date.now()): boolean {
  if (row.status !== "pending-ack") return false;
  if (row.nextAttemptAt && Date.parse(row.nextAttemptAt) > now) return false;
  if (row.sendLeaseUntil && Date.parse(row.sendLeaseUntil) > now) return false;
  if (row.sendLeaseUntil && Date.parse(row.sendLeaseUntil) <= now) return true;
  const received = Date.parse(row.receivedAt ?? "");
  if (!Number.isFinite(received)) return false;
  return now - received >= PENDING_ACK_GRACE_MS;
}

export function pendingAckRetryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function pendingAckGaveUp(attemptsAfterFailure: number): boolean {
  return attemptsAfterFailure >= PENDING_ACK_MAX_ATTEMPTS;
}

let peopleCache: { at: number; people: OrgPerson[] } | undefined;

async function cachedPeople(): Promise<OrgPerson[]> {
  if (peopleCache && Date.now() - peopleCache.at < NAME_CACHE_MS) return peopleCache.people;
  const people = await listOrgByKind<OrgPerson>("person");
  peopleCache = { at: Date.now(), people };
  return people;
}

const GRAPH_NAME_WAIT_MS = 1_500;
const GRAPH_NAME_FETCH_MS = 8_000;
const GRAPH_MISS_CACHE_MS = 30_000;
const ENTRA_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const graphNameCache = new Map<string, { at: number; name: string | undefined; ttl: number }>();
const graphInFlight = new Map<string, Promise<string | undefined>>();

export interface GraphNameProfile {
  givenName?: string | null;
  displayName?: string | null;
}

/** Prefer the profile's given name; fall back to the first token of the display name. */
export function firstNameFromGraphProfile(profile: GraphNameProfile | undefined): string | undefined {
  const given = profile?.givenName?.trim();
  if (given) return firstNameFrom(given);
  return firstNameFrom(profile?.displayName ?? undefined);
}

/**
 * Microsoft 365 profile lookup by Entra object id. The id already came from
 * the channel allowlist (phone → Entra id), so this only turns a known person
 * into a first name; it never decides who is texting.
 */
async function fetchGraphFirstName(userId: string): Promise<string | undefined> {
  const started = Date.now();
  try {
    const profile = await graphAppJson<GraphNameProfile>(
      `/users/${userId}?$select=givenName,displayName`,
      { signal: AbortSignal.timeout(GRAPH_NAME_FETCH_MS) }
    );
    const name = firstNameFromGraphProfile(profile);
    graphNameCache.set(userId, { at: Date.now(), name, ttl: NAME_CACHE_MS });
    console.log(`[ack] graph name for ${userId}: ${name ?? "none"} (${Date.now() - started}ms)`);
    return name;
  } catch (err) {
    graphNameCache.set(userId, { at: Date.now(), name: undefined, ttl: GRAPH_MISS_CACHE_MS });
    console.error(`[ack] graph name lookup failed for ${userId} after ${Date.now() - started}ms:`, err);
    return undefined;
  } finally {
    graphInFlight.delete(userId);
  }
}

/**
 * Waits a bounded time for the profile. A slow first call (token acquisition
 * on a cold process) keeps running in the background and fills the cache, so
 * only the first message after a restart goes out without a name.
 */
async function graphFirstName(userId: string): Promise<string | undefined> {
  if (!ENTRA_OBJECT_ID.test(userId)) return undefined;
  const hit = graphNameCache.get(userId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.name;
  let pending = graphInFlight.get(userId);
  if (!pending) {
    pending = fetchGraphFirstName(userId);
    graphInFlight.set(userId, pending);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    pending.then((name) => ({ done: true as const, name })),
    new Promise<{ done: false }>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), GRAPH_NAME_WAIT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (waited.done) return waited.name;
  console.log(`[ack] graph name for ${userId} still loading; sending without a name`);
  return undefined;
}

async function defaultResolveName(userId: string, hint?: string): Promise<string | undefined> {
  try {
    const person = resolvePerson(await cachedPeople(), { ownerId: userId });
    const fromOrg = firstNameFrom(person?.displayName);
    if (fromOrg) {
      console.log(`[ack] name for ${userId} from org directory`);
      return fromOrg;
    }
  } catch (err) {
    console.error("[ack] org name lookup failed:", err);
  }
  const fromHint = firstNameFrom(hint);
  if (fromHint) {
    console.log(`[ack] name for ${userId} from channel display name`);
    return fromHint;
  }
  return graphFirstName(userId);
}

function ackSystemPrompt(input: AckPrompt): string {
  const who = input.name
    ? `The person's first name is ${input.name}. Use it.`
    : "You do not know their name. Do not invent one.";
  if (input.kind === "reply" && input.social === "probe") {
    return (
      `You are TaskBrain. ${who} They sent a test or ping, not a request. ` +
      "Reply with one short sentence under 140 characters. Say nothing was saved. " +
      "Do not mention queues or request ids."
    );
  }
  if (input.kind === "reply") {
    return (
      `You are TaskBrain. ${who} They only said hello. ` +
      "Reply with one short greeting under 140 characters and invite them to ask for something. " +
      "Do not claim any work was done. Do not mention queues or request ids."
    );
  }
  return (
    `You are TaskBrain. ${who} They just sent a message. ` +
    "Reply with one short acknowledgement under 140 characters that shows you received it and reflects their words. " +
    "Do not promise an outcome. Never say the work is saved, filed, scheduled, approved, or done. " +
    "Never mention queues or request ids. Never ask a clarifying question. " +
    "If the message is vague, acknowledge it without saying you have started the task."
  );
}

async function defaultGenerate(input: AckPrompt): Promise<string | null> {
  const res = await route(
    "ack",
    [
      { role: "system", content: ackSystemPrompt(input) },
      { role: "user", content: input.text },
    ],
    {
      attribution: {
        origin: "user_message",
        channel: input.channel,
        trigger: "acknowledgement",
      },
    }
  );
  return res.choices[0]?.message?.content ?? null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ack timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function composeAcknowledgement(
  ctx: AckContext,
  deps: ComposeDeps = {}
): Promise<AckDraft> {
  const social = socialOnlyKind(ctx.text);
  const kind: AckKind = social ? "reply" : "receipt";
  let firstName: string | undefined;
  try {
    firstName = await (deps.resolveName ?? defaultResolveName)(ctx.userId, ctx.displayNameHint);
  } catch (err) {
    console.error("[ack] name lookup failed:", err);
    firstName = firstNameFrom(ctx.displayNameHint);
  }
  const generate = deps.generate ?? defaultGenerate;
  try {
    const raw = await withTimeout(
      generate({ kind, social, name: firstName, text: ctx.text, channel: ctx.channel }),
      deps.timeoutMs ?? ACK_TIMEOUT_MS
    );
    const clean = sanitizeAck(raw);
    if (clean) return { kind, text: clean, firstName, social };
  } catch (err) {
    console.error("[ack] generation failed:", err);
  }
  return { kind, text: fallbackAck(kind, social, firstName), firstName, social };
}
