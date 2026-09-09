import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient } from "@azure/storage-blob";
import type {
  CheckpointDoc,
  CommitmentDoc,
  IngestHealthDoc,
  MeetingDoc,
  TranscriptAvailabilityDoc,
  TranscriptAvailabilityStatus,
} from "./types";

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const db = cosmos.database(process.env.COSMOS_DB ?? "taskbrain");
const meetings = db.container("meetings");
const commitments = db.container("commitments");
const checkpoints = db.container("meeting-checkpoints");
const availability = db.container("transcript-availability");

function meetingBlobs() {
  return BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING!).getContainerClient(
    process.env.MEETINGS_CONTAINER ?? "meetings"
  );
}

export function meetingTtlSeconds(): number {
  return Number(process.env.MEETING_TTL_DAYS ?? 90) * 86400;
}

export function commitmentTtlSeconds(): number {
  return Number(process.env.COMMITMENT_TTL_DAYS ?? 180) * 86400;
}

export async function meetingExists(transcriptId: string): Promise<boolean> {
  const { resources } = await meetings.items
    .query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.transcriptId = @id",
      parameters: [{ name: "@id", value: transcriptId }],
    })
    .fetchAll();
  return Number(resources[0] ?? 0) > 0;
}

export async function upsertMeeting(doc: MeetingDoc): Promise<void> {
  await meetings.items.upsert(doc);
}

export function transcriptAvailabilityId(transcriptId: string): string {
  return transcriptId.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 120) || `tx-${Date.now()}`;
}

export function transcriptSelectionKey(organizerId: string, transcriptId: string): string {
  return `${organizerId}::${transcriptAvailabilityId(transcriptId)}`;
}

export function parseTranscriptSelectionKey(
  key: string
): { organizerId: string; id: string } | undefined {
  const split = key.indexOf("::");
  if (split < 1) return undefined;
  const organizerId = key.slice(0, split);
  const id = key.slice(split + 2);
  return organizerId && id ? { organizerId, id } : undefined;
}

export async function getTranscriptAvailability(
  organizerId: string,
  id: string
): Promise<TranscriptAvailabilityDoc | undefined> {
  try {
    const { resource } = await availability
      .item(id, organizerId)
      .read<TranscriptAvailabilityDoc>();
    return resource;
  } catch {
    return undefined;
  }
}

/** Discovery is idempotent and never overwrites queue/processing state. */
export async function recordTranscriptAvailability(
  input: Omit<TranscriptAvailabilityDoc, "id" | "discoveredAt" | "updatedAt" | "status">,
  alreadySummarized = false
): Promise<"created" | "existing"> {
  const id = transcriptAvailabilityId(input.transcriptId);
  const existing = await getTranscriptAvailability(input.organizerId, id);
  if (existing) {
    await availability.items.upsert({
      ...existing,
      organizerName: input.organizerName ?? existing.organizerName,
      meetingId: input.meetingId || existing.meetingId,
      createdDateTime: input.createdDateTime ?? existing.createdDateTime,
      titleHint: input.titleHint ?? existing.titleHint,
      status: alreadySummarized ? "summarized" : existing.status,
      updatedAt: new Date().toISOString(),
    });
    return "existing";
  }
  const now = new Date().toISOString();
  await availability.items.create({
    ...input,
    id,
    discoveredAt: now,
    updatedAt: now,
    status: alreadySummarized ? "summarized" : "available",
  } satisfies TranscriptAvailabilityDoc);
  return "created";
}

export async function listTranscriptAvailability(limit = 100): Promise<TranscriptAvailabilityDoc[]> {
  const { resources } = await availability.items
    .query<TranscriptAvailabilityDoc>({
      query:
        "SELECT TOP @n * FROM c ORDER BY c.createdDateTime DESC",
      parameters: [{ name: "@n", value: limit }],
    })
    .fetchAll();
  return resources;
}

export async function queueTranscriptSelections(
  keys: string[],
  requestedBy: string
): Promise<{ queued: number; unchanged: number }> {
  let queued = 0;
  let unchanged = 0;
  for (const raw of [...new Set(keys)].slice(0, 25)) {
    const key = parseTranscriptSelectionKey(raw);
    if (!key) {
      unchanged++;
      continue;
    }
    const doc = await getTranscriptAvailability(key.organizerId, key.id);
    if (!doc || (doc.status !== "available" && doc.status !== "failed")) {
      unchanged++;
      continue;
    }
    const now = new Date().toISOString();
    try {
      await availability.item(doc.id, doc.organizerId).replace(
        {
          ...doc,
          status: "queued",
          requestedBy,
          requestedAt: now,
          updatedAt: now,
          error: undefined,
        },
        { accessCondition: { type: "IfMatch", condition: doc._etag ?? "" } }
      );
      queued++;
    } catch {
      unchanged++;
    }
  }
  return { queued, unchanged };
}

export async function claimQueuedTranscripts(limit = 2): Promise<TranscriptAvailabilityDoc[]> {
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  const { resources } = await availability.items
    .query<TranscriptAvailabilityDoc>({
      query:
        "SELECT TOP @n * FROM c WHERE c.status = 'queued' OR (c.status = 'processing' AND c.processingAt < @stale) ORDER BY c.requestedAt",
      parameters: [
        { name: "@n", value: limit },
        { name: "@stale", value: staleBefore },
      ],
    })
    .fetchAll();
  const claimed: TranscriptAvailabilityDoc[] = [];
  for (const doc of resources) {
    const next: TranscriptAvailabilityDoc = {
      ...doc,
      status: "processing",
      processingAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await availability.item(doc.id, doc.organizerId).replace(next, {
        accessCondition: { type: "IfMatch", condition: doc._etag ?? "" },
      });
      claimed.push(next);
    } catch {
      // Another Function instance claimed it.
    }
  }
  return claimed;
}

export async function setTranscriptAvailabilityStatus(
  doc: TranscriptAvailabilityDoc,
  status: TranscriptAvailabilityStatus,
  patch: Partial<TranscriptAvailabilityDoc> = {}
): Promise<void> {
  await availability.items.upsert({
    ...doc,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
  });
}

export async function writeMeetingMarkdown(path: string, md: string): Promise<void> {
  await meetingBlobs().getBlockBlobClient(path).upload(md, Buffer.byteLength(md), {
    blobHTTPHeaders: { blobContentType: "text/markdown" },
  });
}

export async function getCheckpoint(organizerId: string): Promise<CheckpointDoc | undefined> {
  try {
    const { resource } = await checkpoints.item(organizerId, organizerId).read<CheckpointDoc>();
    return resource;
  } catch {
    return undefined;
  }
}

export async function saveCheckpoint(doc: CheckpointDoc): Promise<void> {
  await checkpoints.items.upsert(doc);
}

export async function saveHealth(doc: IngestHealthDoc): Promise<void> {
  await checkpoints.items.upsert(doc);
}

export async function readHealth(): Promise<IngestHealthDoc | undefined> {
  try {
    const { resource } = await checkpoints.item("latest", "_system").read<IngestHealthDoc>();
    return resource;
  } catch {
    return undefined;
  }
}

export async function listOpenCommitments(ownerKey?: string): Promise<CommitmentDoc[]> {
  const query = ownerKey
    ? {
        query: "SELECT * FROM c WHERE c.ownerKey = @o AND c.status = 'open'",
        parameters: [{ name: "@o", value: ownerKey }],
      }
    : { query: "SELECT * FROM c WHERE c.status = 'open'" };
  const { resources } = await commitments.items.query<CommitmentDoc>(query).fetchAll();
  return resources;
}

export async function upsertCommitment(doc: CommitmentDoc): Promise<void> {
  await commitments.items.upsert(doc);
}

export async function getCommitment(id: string, ownerKey: string): Promise<CommitmentDoc | undefined> {
  try {
    const { resource } = await commitments.item(id, ownerKey).read<CommitmentDoc>();
    return resource;
  } catch {
    return undefined;
  }
}

export async function searchMeetings(queryEmbedding: number[], k = 8): Promise<MeetingDoc[]> {
  const { resources } = await meetings.items
    .query({
      query: `
        SELECT TOP @k c.id, c.organizerId, c.organizerName, c.title, c.summary,
               c.decisions, c.actions, c.risks, c.openQuestions, c.attendees,
               c.categories, c.startAt, c.createdAt, c.path,
               VectorDistance(c.embedding, @qv) AS score
        FROM c
        ORDER BY VectorDistance(c.embedding, @qv)`,
      parameters: [
        { name: "@k", value: k },
        { name: "@qv", value: queryEmbedding },
      ],
    })
    .fetchAll();
  return resources as MeetingDoc[];
}

export async function recentMeetings(limit = 25): Promise<MeetingDoc[]> {
  const { resources } = await meetings.items
    .query({
      query: "SELECT TOP @n c.id, c.title, c.organizerName, c.organizerId, c.startAt, c.createdAt, c.categories, c.summary FROM c ORDER BY c.createdAt DESC",
      parameters: [{ name: "@n", value: limit }],
    })
    .fetchAll();
  return resources as MeetingDoc[];
}

export async function listCommitmentsForDash(limit = 40): Promise<CommitmentDoc[]> {
  const { resources } = await commitments.items
    .query({
      query: "SELECT TOP @n * FROM c ORDER BY c.status, c.due",
      parameters: [{ name: "@n", value: limit }],
    })
    .fetchAll();
  return resources as CommitmentDoc[];
}

export async function listAllMeetings(): Promise<MeetingDoc[]> {
  const { resources } = await meetings.items
    .query<MeetingDoc>({ query: "SELECT * FROM c" })
    .fetchAll();
  return resources;
}

export async function listAllCommitments(): Promise<CommitmentDoc[]> {
  const { resources } = await commitments.items
    .query<CommitmentDoc>({ query: "SELECT * FROM c" })
    .fetchAll();
  return resources;
}

export function renderMeetingMarkdown(m: MeetingDoc): string {
  const fm = [
    "---",
    `title: "${m.title.replace(/"/g, '\\"')}"`,
    `kind: meeting`,
    `organizer: ${m.organizerName ?? m.organizerId}`,
    `created: ${m.createdAt}`,
    `tags: [${m.categories.join(", ")}]`,
    "---",
  ].join("\n");
  const decisions = m.decisions.map((d) => `- ${d}`).join("\n");
  const actions = m.actions.map((a) => `- ${a.ownerName}: ${a.text}${a.due ? ` (due ${a.due})` : ""}`).join("\n");
  return `${fm}\n\n# ${m.title}\n\n${m.summary}\n\n## Decisions\n${decisions || "- none"}\n\n## Actions\n${actions || "- none"}\n`;
}
