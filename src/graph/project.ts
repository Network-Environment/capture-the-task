import type { CommitmentDoc, MeetingDoc } from "../meetings/types";
import type { OrgDirectory, OrgPerson } from "../org/types";
import {
  graphEnabled,
  getGraphNode,
  putGraphEdge,
  putGraphNode,
  setGraphSingleRelationship,
} from "./store";
import { deterministicGraphId } from "./validation";

const SYSTEM_ACTOR = "graph-projector";

export interface ProjectionResult {
  nodes: number;
  edges: number;
  skipped: number;
  errors: string[];
}

export function emptyProjectionResult(): ProjectionResult {
  return { nodes: 0, edges: 0, skipped: 0, errors: [] };
}

export async function projectPerson(person: OrgPerson): Promise<ProjectionResult> {
  const result = emptyProjectionResult();
  if (!graphEnabled()) {
    result.skipped++;
    return result;
  }
  try {
    await putGraphNode(
      {
        id: deterministicGraphId("org-person", person.id),
        type: "person",
        title: person.displayName,
        description: [person.title, person.mandate].filter(Boolean).join(" — "),
        status: person.status === "active" ? "active" : "stale",
        source: { kind: "org", id: person.id },
        provenance: "system",
      },
      SYSTEM_ACTOR
    );
    result.nodes++;
  } catch (err) {
    result.errors.push(`${person.id}: ${(err as Error).message}`);
  }
  return result;
}

export async function projectMeeting(meeting: MeetingDoc): Promise<ProjectionResult> {
  const result = emptyProjectionResult();
  if (!graphEnabled()) {
    result.skipped++;
    return result;
  }
  try {
    await putGraphNode(
      {
        id: deterministicGraphId("meeting", meeting.id),
        type: "meeting",
        title: meeting.title,
        description: meeting.summary,
        source: { kind: "meeting", id: meeting.id },
        provenance: "system",
        ttl: meeting.ttl,
      },
      SYSTEM_ACTOR,
      {},
      { embedding: meeting.embedding }
    );
    result.nodes++;
    const evidence = [
      ...meeting.decisions.map((text) => ({ kind: "decision", text })),
      ...meeting.risks.map((text) => ({ kind: "risk", text })),
    ].slice(0, 12);
    for (const [index, item] of evidence.entries()) {
      const evidenceId = deterministicGraphId(
        "meeting-evidence",
        `${meeting.id}:${item.kind}:${index}`
      );
      await putGraphNode(
        {
          id: evidenceId,
          type: "evidence",
          title: `${item.kind === "decision" ? "Decision" : "Risk"}: ${item.text}`.slice(0, 240),
          description: `Extracted from ${meeting.title}.`,
          source: {
            kind: "meeting",
            id: `${meeting.id}#${item.kind}-${index}`,
          },
          provenance: "system",
          ttl: meeting.ttl,
        },
        SYSTEM_ACTOR,
        {},
        { skipEmbedding: true }
      );
      result.nodes++;
      await putGraphEdge(
        {
          fromId: evidenceId,
          toId: deterministicGraphId("meeting", meeting.id),
          type: "related_to",
          reviewState: "accepted",
          provenance: "system",
          evidence: `Structured ${item.kind} extracted from the meeting summary.`,
          ttl: meeting.ttl,
        },
        SYSTEM_ACTOR
      );
      result.edges++;
    }
  } catch (err) {
    result.errors.push(`${meeting.id}: ${(err as Error).message}`);
  }
  return result;
}

export async function projectCommitment(commitment: CommitmentDoc): Promise<ProjectionResult> {
  const result = emptyProjectionResult();
  if (!graphEnabled()) {
    result.skipped++;
    return result;
  }
  const taskId = deterministicGraphId("commitment", commitment.id);
  const meetingId = deterministicGraphId("meeting", commitment.sourceMeetingId);
  try {
    if (!(await getGraphNode(meetingId, SYSTEM_ACTOR))) {
      throw new Error(`source meeting is not projected: ${meetingId}`);
    }
    await putGraphNode(
      {
        id: taskId,
        type: "task",
        title: commitment.text,
        description: `Meeting commitment owned by ${commitment.ownerName}.`,
        status:
          commitment.status === "done"
            ? "done"
            : commitment.status === "stale"
              ? "stale"
              : commitment.status === "contradicted"
                ? "cancelled"
                : "open",
        due: commitment.due,
        ownerPersonId: commitment.personId
          ? deterministicGraphId("org-person", commitment.personId)
          : undefined,
        source: { kind: "commitment", id: commitment.id },
        provenance: "system",
        ttl: commitment.ttl,
      },
      SYSTEM_ACTOR
    );
    result.nodes++;
    await putGraphEdge(
      {
        fromId: taskId,
        toId: meetingId,
        type: "originated_from",
        reviewState: "accepted",
        provenance: "system",
        evidence: commitment.sourceTitle,
        ttl: commitment.ttl,
      },
      SYSTEM_ACTOR
    );
    result.edges++;
    if (commitment.personId) {
      const personGraphId = deterministicGraphId("org-person", commitment.personId);
      if (await getGraphNode(personGraphId, SYSTEM_ACTOR)) {
        await setGraphSingleRelationship(
          taskId,
          "assigned_to",
          personGraphId,
          SYSTEM_ACTOR,
          "system",
          "Resolved commitment owner from the org directory.",
          commitment.ttl
        );
        result.edges++;
      } else {
        result.errors.push(`${commitment.id}: unresolved owner ${commitment.personId}`);
      }
    } else {
      await setGraphSingleRelationship(
        taskId,
        "assigned_to",
        undefined,
        SYSTEM_ACTOR,
        "system",
        "Commitment has no resolved org owner."
      );
    }
  } catch (err) {
    result.errors.push(`${commitment.id}: ${(err as Error).message}`);
  }
  return result;
}

export async function projectSharedGraph(input: {
  org: OrgDirectory;
  meetings: MeetingDoc[];
  commitments: CommitmentDoc[];
}): Promise<ProjectionResult> {
  const total = emptyProjectionResult();
  const merge = (r: ProjectionResult) => {
    total.nodes += r.nodes;
    total.edges += r.edges;
    total.skipped += r.skipped;
    total.errors.push(...r.errors);
  };
  for (const person of input.org.people) merge(await projectPerson(person));
  for (const meeting of input.meetings) merge(await projectMeeting(meeting));
  for (const commitment of input.commitments) merge(await projectCommitment(commitment));
  return total;
}
