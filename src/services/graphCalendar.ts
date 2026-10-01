import { listOrgDirectory } from "../org/store";
import { normalizeOrgName, resolvePerson } from "../org/resolve";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_LOOKBACK_DAYS = 730;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

export interface CalendarSearchArgs {
  attendee?: string;
  keywords?: string;
  start?: string;
  end?: string;
  limit?: number;
}

interface GraphDateTime {
  dateTime?: string;
  timeZone?: string;
}

export interface GraphEvent {
  id: string;
  subject?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isCancelled?: boolean;
  attendees?: Array<{
    emailAddress?: { name?: string; address?: string };
  }>;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  webLink?: string;
}

interface GraphPage {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
}

export interface CalendarIdentity {
  names: string[];
  addresses: string[];
  ambiguity?: string;
}

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(10, Math.floor(Number(value) || 5)));
}

function parsedDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return parsed;
}

function eventTime(event: GraphEvent): number {
  return Date.parse(event.start?.dateTime ?? "") || 0;
}

function identityMatches(
  event: GraphEvent,
  names: string[],
  addresses: string[]
): boolean {
  if (!names.length && !addresses.length) return true;
  const participants = [
    ...(event.attendees ?? []).map((attendee) => attendee.emailAddress),
    event.organizer?.emailAddress,
  ];
  return participants.some((participant) => {
    const name = normalizeOrgName(participant?.name ?? "");
    const address = (participant?.address ?? "").trim().toLowerCase();
    return names.includes(name) || addresses.includes(address);
  });
}

function keywordMatches(event: GraphEvent, keywords: string | undefined): boolean {
  const query = normalizeOrgName(keywords ?? "");
  if (!query) return true;
  const subject = normalizeOrgName(event.subject ?? "");
  return query.split(" ").every((token) => subject.includes(token));
}

async function attendeeIdentity(attendee: string | undefined): Promise<{
  names: string[];
  addresses: string[];
  ambiguity?: string;
}> {
  const raw = attendee?.trim();
  if (!raw) return { names: [], addresses: [] };
  if (raw.includes("@")) {
    return { names: [], addresses: [raw.toLowerCase()] };
  }

  const dir = await listOrgDirectory();
  const resolved = resolvePerson(dir.people, { ownerName: raw });
  if (resolved) {
    return {
      names: [resolved.displayName, ...resolved.aliases].map(normalizeOrgName),
      addresses: [],
    };
  }

  const first = normalizeOrgName(raw).split(" ")[0];
  const candidates = dir.people.filter(
    (person) =>
      person.status === "active" &&
      [person.displayName, ...person.aliases].some(
        (name) => normalizeOrgName(name).split(" ")[0] === first
      )
  );
  if (candidates.length > 1) {
    return {
      names: [],
      addresses: [],
      ambiguity:
        `More than one active person matches "${raw}": ` +
        candidates.slice(0, 5).map((person) => person.displayName).join(", "),
    };
  }

  // The org directory can lag Entra. A unique free-text name is still safe
  // because this tool only searches the requester's own calendar.
  return { names: [normalizeOrgName(raw)], addresses: [] };
}

export async function searchMyCalendar(
  token: string,
  args: CalendarSearchArgs,
  fetchImpl: typeof fetch = fetch,
  resolveIdentity: (attendee: string | undefined) => Promise<CalendarIdentity> = attendeeIdentity
): Promise<string> {
  const identity = await resolveIdentity(args.attendee);
  if (identity.ambiguity) return `CALENDAR_CLARIFICATION_REQUIRED: ${identity.ambiguity}`;

  const now = new Date();
  const lookbackDays = Math.max(
    30,
    Math.min(3650, Number(process.env.CALENDAR_LOOKBACK_DAYS) || DEFAULT_LOOKBACK_DAYS)
  );
  const defaultStart = new Date(now.valueOf() - lookbackDays * 86_400_000);
  const start = parsedDate(args.start, defaultStart);
  const end = parsedDate(args.end, now);
  if (start >= end) throw new Error("Calendar start must be before end.");

  const query = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    "$select": "id,subject,start,end,attendees,organizer,isCancelled,webLink",
    "$orderby": "start/dateTime desc",
    "$top": String(PAGE_SIZE),
  });
  let url: string | undefined = `${GRAPH}/me/calendarView?${query}`;
  const events: GraphEvent[] = [];

  for (let pageNumber = 0; url && pageNumber < MAX_PAGES; pageNumber++) {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="Central Standard Time"',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Graph calendar ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const page = (await response.json()) as GraphPage;
    events.push(...(page.value ?? []));
    url = page["@odata.nextLink"];
  }

  const matches = events
    .filter((event) => !event.isCancelled)
    .filter((event) => eventTime(event) <= now.valueOf())
    .filter((event) => identityMatches(event, identity.names, identity.addresses))
    .filter((event) => keywordMatches(event, args.keywords))
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, boundedLimit(args.limit));

  if (!matches.length) {
    return "No matching events were found on the requester's calendar in the searched date range.";
  }
  return matches
    .map((event) => {
      const attendees = (event.attendees ?? [])
        .map((item) => item.emailAddress?.name || item.emailAddress?.address)
        .filter(Boolean)
        .slice(0, 12)
        .join(", ");
      return [
        `Calendar event: ${event.subject || "(no subject)"}`,
        `Id: ${event.id}`,
        `Start: ${event.start?.dateTime ?? "unknown"} (${event.start?.timeZone ?? "unknown timezone"})`,
        `End: ${event.end?.dateTime ?? "unknown"} (${event.end?.timeZone ?? "unknown timezone"})`,
        `Organizer: ${event.organizer?.emailAddress?.name || event.organizer?.emailAddress?.address || "unknown"}`,
        `Attendees: ${attendees || "none listed"}`,
      ].join("\n");
    })
    .join("\n---\n");
}

export interface CalendarWrite {
  subject?: string;
  start?: string;
  end?: string;
  attendees?: string;
}

function graphDate(value: string): { dateTime: string; timeZone: string } {
  return { dateTime: value.trim(), timeZone: "Central Standard Time" };
}

function attendeeList(value: string | undefined): Array<{ emailAddress: { address: string }; type: "required" }> {
  if (!value?.trim()) return [];
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item.includes("@"))
    .map((address) => ({ emailAddress: { address }, type: "required" as const }));
}

async function graphWrite(
  token: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: 'outlook.timezone="Central Standard Time"',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Graph calendar ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  if (response.status === 202 || response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function createCalendarEvent(
  token: string,
  args: CalendarWrite,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const subject = args.subject?.trim() ?? "";
  const start = args.start?.trim() ?? "";
  const end = args.end?.trim() ?? "";
  if (!subject || !start || !end) return "A new event needs a subject, start, and end.";
  const created = (await graphWrite(
    token,
    `${GRAPH}/me/events`,
    {
      method: "POST",
      body: JSON.stringify({
        subject,
        start: graphDate(start),
        end: graphDate(end),
        attendees: attendeeList(args.attendees),
      }),
    },
    fetchImpl
  )) as { id?: string };
  return `Created "${subject}" on the requester's calendar. Id: ${created.id ?? "unknown"}.`;
}

export async function updateCalendarEvent(
  token: string,
  id: string,
  args: CalendarWrite,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const eventId = id.trim();
  if (!eventId) return "Updating an event needs the id from calendar search.";
  const patch: Record<string, unknown> = {};
  if (args.subject?.trim()) patch.subject = args.subject.trim();
  if (args.start?.trim()) patch.start = graphDate(args.start);
  if (args.end?.trim()) patch.end = graphDate(args.end);
  if (args.attendees?.trim()) patch.attendees = attendeeList(args.attendees);
  if (!Object.keys(patch).length) return "Say what should change: subject, start, end, or attendees.";
  await graphWrite(
    token,
    `${GRAPH}/me/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    fetchImpl
  );
  return `Updated event ${eventId} on the requester's calendar.`;
}

export async function declineCalendarEvent(
  token: string,
  id: string,
  comment?: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const eventId = id.trim();
  if (!eventId) return "Declining an event needs the id from calendar search.";
  await graphWrite(
    token,
    `${GRAPH}/me/events/${encodeURIComponent(eventId)}/decline`,
    {
      method: "POST",
      body: JSON.stringify({
        comment: comment?.trim() || "Declined from TaskBrain.",
        sendResponse: true,
      }),
    },
    fetchImpl
  );
  return `Declined event ${eventId} on the requester's calendar.`;
}
