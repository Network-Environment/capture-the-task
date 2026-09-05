/**
 * The second brain.
 * - Canonical note: markdown file in Blob Storage (Obsidian-compatible:
 *   YAML frontmatter + [[wikilinks]]). Portable forever.
 * - Index: Cosmos DB NoSQL with a diskANN vector index on /embedding.
 * - Recall: cosine vector search scoped to the user.
 */
import { BlobServiceClient } from "@azure/storage-blob";
import { CosmosClient } from "@azure/cosmos";
import { embed } from "./router";

const blobSvc = BlobServiceClient.fromConnectionString(
  process.env.STORAGE_CONNECTION_STRING!
);
const notesBlob = blobSvc.getContainerClient(process.env.NOTES_CONTAINER ?? "notes");

const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
});
const notes = cosmos.database(process.env.COSMOS_DB ?? "taskbrain").container("notes");

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
  n: NoteInput
): Promise<{ id: string; path: string }> {
  const now = new Date();
  const id = `${now.getTime()}-${slug(n.title).slice(0, 40)}`;
  const path = `${userId}/${now.toISOString().slice(0, 7)}/${id}.md`;

  const md = renderMarkdown(n, now);
  await notesBlob
    .getBlockBlobClient(path)
    .upload(md, Buffer.byteLength(md), {
      blobHTTPHeaders: { blobContentType: "text/markdown" },
    });

  const vector = await embed(`${n.title}\n${n.body}\n${n.tags.join(" ")}`);
  await notes.items.create({
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

  return { id, path };
}

export async function recall(
  userId: string,
  query: string,
  k = 8
): Promise<RecallHit[]> {
  const qv = await embed(query);
  const { resources } = await notes.items
    .query({
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
