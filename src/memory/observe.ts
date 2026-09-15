import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { route } from "../services/router";
import { cosmosContainer } from "../services/cosmos";
import { ORG_MEMORY_BANK } from "./banks";
import {
  listMemoryFacts,
  memoryFactsEnabled,
  observationForEntity,
  putMemoryFact,
  recentBankFacts,
} from "./store";

const MIN_FACTS = 4;

export async function consolidateObservations(): Promise<number> {
  if (!memoryFactsEnabled()) return 0;
  let wrote = 0;
  for (const bankId of await observationBanks()) {
    const recent = await recentBankFacts(bankId, 80);
    const counts = new Map<string, number>();
    for (const fact of recent) {
      for (const entityId of fact.entityIds) {
        counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
      }
    }
    for (const [entityId, count] of counts) {
      if (count < MIN_FACTS) continue;
      const existing = await observationForEntity(bankId, entityId);
      const latest = recent.find((fact) => fact.entityIds.includes(entityId));
      if (existing && latest && existing.updatedAt >= latest.createdAt) continue;
      const bundle = recent
        .filter((fact) => fact.entityIds.includes(entityId))
        .slice(0, 12)
        .map((fact) => `- ${fact.text}`)
        .join("\n");
      const text = await rewriteObservation(entityId, bundle);
      if (!text) continue;
      await putMemoryFact({
        id: existing?.id ?? `obs-${entityId}`.replace(/[^a-z0-9:_-]/gi, "-").slice(0, 80),
        bankId,
        network: "observation",
        text,
        entityIds: [entityId],
        source: existing?.source ?? "graph",
        sourceId: existing?.sourceId ?? entityId,
        mentionedAt: new Date().toISOString(),
        confidence: 0.7,
      });
      wrote++;
    }
  }
  return wrote;
}

async function observationBanks(): Promise<string[]> {
  const facts = await listMemoryFacts({ limit: 100 });
  const banks = new Set(facts.map((fact) => fact.bankId));
  banks.add(ORG_MEMORY_BANK);
  return [...banks];
}

async function rewriteObservation(entityId: string, bundle: string): Promise<string | undefined> {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Rewrite these facts into one preference-neutral observation about the entity. " +
        "No judgment, no private opinion. One or two sentences. Output ONLY JSON: {\"text\":\"...\"}",
    },
    { role: "user", content: `Entity ${entityId}\n${bundle}` },
  ];
  try {
    const res = await route("triage", messages, { json: true });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as { text?: string };
    return parsed.text?.trim().slice(0, 600);
  } catch (err) {
    console.error("[memory] observation rewrite failed:", err);
    return undefined;
  }
}

export async function maybeConsolidateObservations(): Promise<void> {
  const checkpointId = "_observe_checkpoint";
  try {
    const { resource } = await cosmosContainer("memory-facts")
      .item(checkpointId, "_system")
      .read<{ lastAt?: string }>();
    if (resource?.lastAt && Date.now() - Date.parse(resource.lastAt) < 6 * 3_600_000) return;
  } catch {
    // first run
  }
  try {
    const n = await consolidateObservations();
    await cosmosContainer("memory-facts").items.upsert({
      id: checkpointId,
      bankId: "_system",
      docType: "checkpoint",
      lastAt: new Date().toISOString(),
      lastCount: n,
    });
  } catch (err) {
    console.error("[memory] observation consolidate failed (non-fatal):", err);
  }
}
