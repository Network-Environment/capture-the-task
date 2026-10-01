/**
 * Files the requester can already open with their delegated Graph token.
 * That token is the grant: search does not walk the tenant. Edits are text only.
 */
const GRAPH = "https://graph.microsoft.com/v1.0";
const READ_MAX = 8_000;

export interface FileHit {
  id: string;
  driveId: string;
  name: string;
  webUrl?: string;
}

function bounded(limit: number | undefined): number {
  return Math.max(1, Math.min(10, Math.floor(Number(limit) || 8)));
}

async function graphResponse(
  token: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Graph files ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

export function fileHitsFromSearch(data: unknown): FileHit[] {
  const containers =
    (data as { value?: Array<{ hitsContainers?: Array<{ hits?: unknown[] }> }> }).value ?? [];
  const hits = containers.flatMap((row) => row.hitsContainers ?? []).flatMap((box) => box.hits ?? []);
  const out: FileHit[] = [];
  for (const hit of hits) {
    const resource = (hit as { resource?: Record<string, unknown> }).resource ?? {};
    const id = String(resource.id ?? "");
    const parent = resource.parentReference as { driveId?: string } | undefined;
    const driveId = String(parent?.driveId ?? "");
    const name = String(resource.name ?? "");
    if (!id || !driveId || !name) continue;
    out.push({
      id,
      driveId,
      name,
      webUrl: resource.webUrl ? String(resource.webUrl) : undefined,
    });
  }
  return out;
}

export function formatFileHits(hits: FileHit[]): string {
  if (!hits.length) return "No files the requester can access matched that search.";
  return hits
    .map((hit) =>
      [`File: ${hit.name}`, `Id: ${hit.id}`, `Drive: ${hit.driveId}`, hit.webUrl ? `Link: ${hit.webUrl}` : ""]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n---\n");
}

export async function searchMyFiles(
  token: string,
  query: string,
  limit?: number,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const q = query.trim();
  if (!q) return "File search query was empty.";
  const response = await graphResponse(
    token,
    `${GRAPH}/search/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            entityTypes: ["driveItem"],
            query: { queryString: q },
            from: 0,
            size: bounded(limit),
          },
        ],
      }),
    },
    fetchImpl
  );
  return formatFileHits(fileHitsFromSearch(await response.json()));
}

export async function readMyFile(
  token: string,
  driveId: string,
  itemId: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const drive = driveId.trim();
  const item = itemId.trim();
  if (!drive || !item) return "Reading a file needs the drive id and item id from search.";
  const response = await graphResponse(
    token,
    `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}/content`,
    { headers: { Accept: "text/plain, application/json, text/markdown" } },
    fetchImpl
  );
  const type = response.headers.get("content-type") ?? "";
  if (type && !/text|json|xml|csv|markdown|javascript/.test(type)) {
    return `That file is ${type || "binary"} and is not returned as text.`;
  }
  const text = await response.text();
  if (text.length <= READ_MAX) return text || "(empty file)";
  return `${text.slice(0, READ_MAX)}\n…[truncated ${text.length - READ_MAX} chars]`;
}

export async function updateMyFile(
  token: string,
  driveId: string,
  itemId: string,
  content: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const drive = driveId.trim();
  const item = itemId.trim();
  if (!drive || !item) return "Updating a file needs the drive id and item id from search.";
  if (!content) return "File content was empty.";
  if (content.length > 100_000) return "File content is too large to write from chat.";
  await graphResponse(
    token,
    `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: content,
    },
    fetchImpl
  );
  return `Updated file ${item} on drive ${drive}.`;
}
