import { DefaultAzureCredential } from "@azure/identity";

const GRAPH = "https://graph.microsoft.com/v1.0";
let token: { value: string; exp: number } | undefined;
let cred: DefaultAzureCredential | undefined;

async function graphToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  cred ??= new DefaultAzureCredential();
  const t = await cred.getToken("https://graph.microsoft.com/.default");
  if (!t) throw new Error("Graph token failed");
  token = { value: t.token, exp: t.expiresOnTimestamp };
  return t.token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function transcriptsDeltaPath(organizerId: string): string {
  return `/users/${organizerId}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${organizerId}')`;
}

export async function graphGet<T>(path: string, accept?: string): Promise<T> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await graphToken()}`,
    };
    if (accept) headers.Accept = accept;
    const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, { headers });
    if (res.ok) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/") || accept?.includes("vtt") || accept?.includes("transcript")) {
        return (await res.text()) as T;
      }
      return (await res.json()) as T;
    }
    const body = await res.text();
    last = new Error(`Graph ${res.status}: ${body.slice(0, 400)}`);
    (last as Error & { status: number }).status = res.status;
    if (res.status !== 429 && res.status < 500) throw last;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 400 * 2 ** attempt);
  }
  throw last ?? new Error("Graph request failed");
}

export interface GraphUser {
  id: string;
  displayName?: string;
  userPrincipalName?: string;
}

export async function listEnabledUsers(): Promise<GraphUser[]> {
  const out: GraphUser[] = [];
  let url: string | undefined =
    "/users?$select=id,displayName,userPrincipalName,accountEnabled,userType&$filter=accountEnabled eq true&$top=100";
  while (url) {
    const page: { value: (GraphUser & { userType?: string })[]; "@odata.nextLink"?: string } =
      await graphGet(url);
    for (const u of page.value) {
      if (u.userType && u.userType !== "Member") continue;
      out.push({ id: u.id, displayName: u.displayName, userPrincipalName: u.userPrincipalName });
    }
    url = page["@odata.nextLink"];
  }
  return out;
}

export interface GraphTranscript {
  id: string;
  createdDateTime?: string;
  meetingId?: string;
  callId?: string;
  transcriptContentUrl?: string;
  meetingOrganizer?: { user?: { id?: string; displayName?: string } };
}

/**
 * Graph omits `meetingId` on some transcripts (channel meetings and ad-hoc
 * calls) but still returns a content URL that embeds it. Recover it so those
 * meetings are not dropped from discovery.
 */
export function meetingIdFromTranscript(t: GraphTranscript): string | undefined {
  if (t.meetingId) return t.meetingId;
  const match = /\/onlineMeetings\/([^/]+)\/transcripts\//.exec(t.transcriptContentUrl ?? "");
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function getTranscriptDelta(
  organizerId: string,
  deltaLink?: string
): Promise<{ items: GraphTranscript[]; deltaLink?: string }> {
  const start = deltaLink ?? transcriptsDeltaPath(organizerId);
  const items: GraphTranscript[] = [];
  let url: string | undefined = start;
  let nextDelta: string | undefined;
  while (url) {
    const page: {
      value?: GraphTranscript[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    } = await graphGet(url);
    items.push(...(page.value ?? []));
    nextDelta = page["@odata.deltaLink"] ?? nextDelta;
    url = page["@odata.nextLink"];
  }
  return { items, deltaLink: nextDelta };
}

export async function downloadVtt(organizerId: string, meetingId: string, transcriptId: string): Promise<string> {
  return graphGet<string>(
    `/users/${organizerId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content`,
    "text/vtt"
  );
}

export async function getMeetingMeta(
  organizerId: string,
  meetingId: string
): Promise<{ subject?: string; startDateTime?: string } | undefined> {
  try {
    return await graphGet<{ subject?: string; startDateTime?: string }>(
      `/users/${organizerId}/onlineMeetings/${meetingId}?$select=subject,startDateTime`
    );
  } catch {
    return undefined;
  }
}
