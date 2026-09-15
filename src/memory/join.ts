import {
  graphEnabled,
  graphWritesEnabled,
  listExecutionGraph,
  putGraphEdge,
} from "../graph/store";
import { deterministicGraphId } from "../graph/validation";
import type { MemoryFact } from "./types";
import { ORG_MEMORY_BANK } from "./banks";

const JOIN_ACTOR = "memory-join";

export function factKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP.has(word))
    .slice(0, 6);
}

const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "will",
  "they",
  "their",
  "about",
  "decision",
  "action",
  "meeting",
]);

export async function proposeMemoryGraphJoins(facts: MemoryFact[]): Promise<number> {
  if (!graphEnabled() || !graphWritesEnabled()) return 0;
  const world = facts.filter(
    (fact) => fact.network === "world" && fact.bankId === ORG_MEMORY_BANK
  );
  let proposed = 0;
  for (const fact of world) {
    const query = factKeywords(fact.text).join(" ");
    if (!query) continue;
    const graph = await listExecutionGraph(JOIN_ACTOR, {
      query,
      types: ["task", "project"],
      includeProposed: true,
      limit: 12,
    }).catch(() => undefined);
    const open = (graph?.nodes ?? []).filter(
      (node) =>
        (node.type === "task" || node.type === "project") &&
        node.status !== "done" &&
        node.status !== "cancelled"
    );
    const fromId =
      fact.source === "meeting"
        ? deterministicGraphId("meeting", fact.sourceId)
        : undefined;
    if (!fromId) continue;
    for (const node of open.slice(0, 3)) {
      try {
        await putGraphEdge(
          {
            fromId,
            toId: node.id,
            type: "supports",
            reviewState: "proposed",
            provenance: "agent",
            evidence: fact.text.slice(0, 400),
            confidence: fact.confidence ?? 0.55,
          },
          JOIN_ACTOR
        );
        proposed++;
      } catch (err) {
        console.error("[memory] proposed join skipped:", err);
      }
    }
  }
  return proposed;
}
