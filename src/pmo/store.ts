import { cosmosContainer } from "../services/cosmos";
import type { PmoBoard, PmoBoardStatus, PmoDoc, PmoItem } from "./types";

function boards() {
  return cosmosContainer("pmo-boards");
}

export async function upsertPmoDoc<T extends PmoDoc>(doc: T): Promise<T> {
  const { resource } = await boards().items.upsert(doc);
  return resource as unknown as T;
}

export async function getPmoBoard(boardId: string): Promise<PmoBoard | undefined> {
  try {
    const { resource } = await boards().item(boardId, boardId).read<PmoBoard>();
    return resource?.kind === "board" ? resource : undefined;
  } catch {
    return undefined;
  }
}

export async function getPmoItem(id: string, boardId: string): Promise<PmoItem | undefined> {
  try {
    const { resource } = await boards().item(id, boardId).read<PmoItem>();
    return resource?.kind === "item" ? resource : undefined;
  } catch {
    return undefined;
  }
}

export async function listPmoBoards(status?: PmoBoardStatus): Promise<PmoBoard[]> {
  const query = status
    ? {
        query: "SELECT * FROM c WHERE c.kind = 'board' AND c.status = @s",
        parameters: [{ name: "@s", value: status }],
      }
    : { query: "SELECT * FROM c WHERE c.kind = 'board'" };
  const { resources } = await boards().items.query<PmoBoard>(query).fetchAll();
  return resources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function findOpenBoardByTitle(title: string): Promise<PmoBoard | undefined> {
  const { resources } = await boards()
    .items.query<PmoBoard>({
      query: "SELECT * FROM c WHERE c.kind = 'board' AND c.status = 'open'",
    })
    .fetchAll();
  const n = title.trim().toLowerCase().replace(/\s+/g, " ");
  return resources.find((board) => board.title.trim().toLowerCase().replace(/\s+/g, " ") === n);
}

export async function listPmoItems(boardId: string): Promise<PmoItem[]> {
  const { resources } = await boards()
    .items.query<PmoItem>({
      query: "SELECT * FROM c WHERE c.kind = 'item' AND c.boardId = @b",
      parameters: [{ name: "@b", value: boardId }],
    })
    .fetchAll();
  return resources.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function findPmoItem(boardId: string, idOrTitle: string): Promise<PmoItem | undefined> {
  const items = await listPmoItems(boardId);
  const n = idOrTitle.trim().toLowerCase();
  return (
    items.find((item) => item.id === idOrTitle) ??
    items.find((item) => item.title.trim().toLowerCase() === n)
  );
}
