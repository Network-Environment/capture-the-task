import { listOrgDirectory } from "../org/store";
import { resolvePerson } from "../org/resolve";
import { canViewMeetings } from "../meetings/access";
import type { ActivityAttribution } from "../services/activityLog";
import { ORG_MEMORY_BANK, canWriteOrgBank, isOpinionAllowed, userBankId } from "./banks";
import { extractNarrativeFacts } from "./extract";
import { putMemoryEdge, putMemoryFact, memoryFactsEnabled } from "./store";
import type { ExtractedFact, MemoryFact, MemorySource } from "./types";
import { proposeMemoryGraphJoins } from "./join";

export async function resolveEntityIds(names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const people = (await listOrgDirectory().catch(() => ({ people: [] }))).people;
  const ids: string[] = [];
  for (const name of names) {
    const person = resolvePerson(people, { ownerName: name });
    if (person) ids.push(`org-person:${person.id}`);
  }
  return [...new Set(ids)];
}

export async function persistExtractedFacts(
  bankId: string,
  extracted: ExtractedFact[],
  source: MemorySource,
  sourceId: string,
  mentionedAt: string,
  attribution: Partial<ActivityAttribution> = {}
): Promise<MemoryFact[]> {
  const saved: MemoryFact[] = [];
  for (const item of extracted) {
    if (!isOpinionAllowed(item.network, bankId)) continue;
    const entityIds = await resolveEntityIds(item.entities);
    const fact = await putMemoryFact(
      {
        bankId,
        network: item.network,
        text: item.text,
        validFrom: item.validFrom,
        validTo: item.validTo,
        mentionedAt: item.mentionedAt ?? mentionedAt,
        confidence: item.confidence,
        entityIds,
        source,
        sourceId,
      },
      attribution
    );
    for (const entityId of entityIds) {
      try {
        await putMemoryEdge(bankId, fact.id, entityId, "entity");
      } catch (err) {
        console.error("[memory] entity edge failed (non-fatal):", err);
      }
    }
    saved.push(fact);
  }
  return saved;
}

export async function retainFromText(input: {
  userId: string;
  text: string;
  source: MemorySource;
  sourceId: string;
  mentionedAt?: string;
  bank?: "user" | "org";
  attribution?: Partial<ActivityAttribution>;
}): Promise<MemoryFact[]> {
  if (!memoryFactsEnabled()) return [];
  const extracted = await extractNarrativeFacts(input.text);
  if (!extracted.length) return [];
  const when = input.mentionedAt ?? new Date().toISOString();
  const userBank = userBankId(input.userId);
  const saved: MemoryFact[] = [];

  const personal = extracted.filter((item) => input.bank !== "org");
  if (personal.length && input.bank !== "org") {
    saved.push(
      ...(await persistExtractedFacts(
        userBank,
        personal,
        input.source,
        input.sourceId,
        when,
        input.attribution
      ))
    );
  }

  const orgFacts = extracted.filter(
    (item) =>
      item.network === "world" &&
      item.orgRelevant &&
      (input.bank === "org" || canWriteOrgBank(input.userId))
  );
  if (input.bank === "org") {
    if (!canWriteOrgBank(input.userId) && input.source !== "meeting") return saved;
    const world = extracted.filter((item) => item.network === "world" || item.network === "observation");
    saved.push(
      ...(await persistExtractedFacts(
        ORG_MEMORY_BANK,
        world,
        input.source,
        input.sourceId,
        when,
        input.attribution
      ))
    );
  } else if (orgFacts.length && canViewMeetings(input.userId)) {
    saved.push(
      ...(await persistExtractedFacts(
        ORG_MEMORY_BANK,
        orgFacts,
        input.source,
        input.sourceId,
        when,
        input.attribution
      ))
    );
  }

  await proposeMemoryGraphJoins(saved).catch((err) =>
    console.error("[memory] graph join failed (non-fatal):", err)
  );
  return saved;
}

export async function retainFromCapture(
  userId: string,
  text: string,
  sourceId: string,
  attribution: Partial<ActivityAttribution> = {}
): Promise<void> {
  try {
    await retainFromText({
      userId,
      text,
      source: "chat",
      sourceId,
      attribution,
    });
  } catch (err) {
    console.error("[memory] capture retain failed (non-fatal):", err);
  }
}

export async function retainFromMeeting(input: {
  meetingId: string;
  title: string;
  summary: string;
  decisions: string[];
  actions: { text: string; ownerName?: string; due?: string }[];
  risks: string[];
  startAt?: string;
}): Promise<void> {
  if (!memoryFactsEnabled()) return;
  const chunk = [
    input.title,
    input.summary,
    ...input.decisions.map((d) => `Decision: ${d}`),
    ...input.actions.map(
      (a) => `Action: ${a.text}${a.ownerName ? ` (owner ${a.ownerName})` : ""}${a.due ? ` due ${a.due}` : ""}`
    ),
    ...input.risks.map((r) => `Risk: ${r}`),
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const extracted = await extractNarrativeFacts(chunk);
    const world = extracted.map((item) => ({
      ...item,
      network: item.network === "opinion" ? "world" : item.network,
      orgRelevant: true,
    })) as ExtractedFact[];
    const saved = await persistExtractedFacts(
      ORG_MEMORY_BANK,
      world,
      "meeting",
      input.meetingId,
      input.startAt ?? new Date().toISOString()
    );
    await proposeMemoryGraphJoins(saved);
  } catch (err) {
    console.error("[memory] meeting retain failed (non-fatal):", err);
  }
}
