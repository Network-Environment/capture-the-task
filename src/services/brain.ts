/**
 * The second brain.
 * - Canonical note: markdown file in Blob Storage (Obsidian-compatible:
 *   YAML frontmatter + [[wikilinks]]). Portable forever.
 * - Index: Cosmos DB NoSQL with a diskANN vector index on /embedding.
 * - Recall: cosine vector search scoped to the user.
 *
 * Writes embed first (no durable side effects), then Blob, then Cosmos.
 * A Cosmos failure deletes the blob so recall and files do not diverge.
 */
import { BlobServiceClient } from "@azure/storage-blob";
import { embed } from "./router";
import { cosmosContainer } from "./cosmos";
import type { ActivityAttribution } from "./activityLog";

function notesBlob() {
  return BlobServiceClient.fromConnectionString(
    process.env.STORAGE_CONNECTION_STRING!
  ).getContainerClient(process.env.NOTES_CONTAINER ?? "notes");
}

function notes() {
  return cosmosContainer("notes");
}

export interface NoteInput {
  kind: "task" | "idea" | "reference";
  title: string;
  body: string;
  tags: string[];
  links?: string[];
  source: "text" | "voice";
}

export interface RecallHit {
  title: string;
  body: string;
  kind: string;
  createdAt: string;
  path: string;
  score: number;
}

export async function saveNote(
  userId: string,
  n: NoteInput,
  attribution: Partial<ActivityAttribution> = {}
): Promise<{ id: string; path: string }> {
  const now = new Date();
  const id = `${now.getTime()}-${slug(n.title).slice(0, 40)}`;
  const path = `${userId}/${now.toISOString().slice(0, 7)}/${id}.md`;
  const md = renderMarkdown(n, now);
  const vector = await embed(`${n.title}\n${n.body}\n${n.tags.join(" ")}`, {
    ...attribution,
    trigger: "note_index",
  });

  const blob = notesBlob().getBlockBlobClient(path);
  await blob.upload(md, Buffer.byteLength(md), {
    blobHTTPHeaders: { blobContentType: "text/markdown" },
  });

  try {
    await notes().items.create({
      id,
      userId,
      kind: n.kind,
      title: n.title,
      body: n.body,
      tags: n.tags,
      links: n.links ?? [],
      source: n.source,
      path,
      createdAt: now.toISOString(),
      embedding: vector,
    });
  } catch (err) {
    await blob.deleteIfExists().catch((cleanupErr) => {
      console.error("[brain] failed to compensate blob after index error:", cleanupErr);
    });
    throw err;
  }

  return { id, path };
}

export async function deleteNote(userId: string, id: string, path: string): Promise<boolean> {
  let removed = false;
  try {
    await notes().item(id, userId).delete();
    removed = true;
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
  }
  try {
    const deleted = await notesBlob().getBlockBlobClient(path).deleteIfExists();
    if (deleted) removed = true;
  } catch (err) {
    console.error("[brain] blob delete failed (index already removed):", err);
  }
  return removed;
}

export async function recall(
  userId: string,
  query: string,
  k = 8,
  attribution: Partial<ActivityAttribution> = {}
): Promise<RecallHit[]> {
  const qv = await embed(query, { ...attribution, trigger: "note_recall" });
  const { resources } = await notes()
    .items.query({
      query: `
        SELECT TOP @k c.title, c.body, c.kind, c.createdAt, c.path,
               VectorDistance(c.embedding, @qv) AS score
        FROM c
        WHERE c.userId = @userId
        ORDER BY VectorDistance(c.embedding, @qv)`,
      parameters: [
        { name: "@k", value: k },
        { name: "@qv", value: qv },
        { name: "@userId", value: userId },
      ],
    })
    .fetchAll();
  return resources as RecallHit[];
}

function renderMarkdown(n: NoteInput, ts: Date): string {
  const fm = [
    "---",
    `title: "${n.title.replace(/"/g, '\\"')}"`,
    `kind: ${n.kind}`,
    `created: ${ts.toISOString()}`,
    `source: ${n.source}`,
    `tags: [${n.tags.join(", ")}]`,
    "---",
  ].join("\n");
  const links = (n.links ?? []).map((l) => `[[${l}]]`).join(" ");
  return `${fm}\n\n# ${n.title}\n\n${n.body}\n${links ? `\n${links}\n` : ""}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
