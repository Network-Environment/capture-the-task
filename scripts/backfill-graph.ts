/**
 * Shared execution-graph backfill.
 *
 * Dry-run is the default:
 *   npm run graph:backfill
 * Apply after reviewing counts:
 *   npm run graph:backfill -- --apply
 *
 * Personal notes are intentionally excluded. They can only enter the shared
 * graph through an explicit promotion flow.
 */
import { listOrgDirectory } from "../src/org/store";
import { listAllCommitments, listAllMeetings } from "../src/meetings/store";
import { projectSharedGraph } from "../src/graph/project";
import { graphContainers, graphEnabled, graphWorkspaceId } from "../src/graph/store";
import { deterministicGraphId, findDependencyCycles } from "../src/graph/validation";
import type { GraphEdge, GraphNode } from "../src/graph/types";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const [org, meetings, commitments] = await Promise.all([
    listOrgDirectory(),
    listAllMeetings(),
    listAllCommitments(),
  ]);
  const personIds = new Set(org.people.map((person) => person.id));
  const meetingIds = new Set(meetings.map((meeting) => meeting.id));
  const unresolvedOwners = commitments.filter(
    (commitment) => commitment.personId && !personIds.has(commitment.personId)
  );
  const missingMeetings = commitments.filter(
    (commitment) => !meetingIds.has(commitment.sourceMeetingId)
  );
  const expected = new Map<string, GraphNode["type"]>();
  const sourceCollisions: string[] = [];
  const addExpected = (id: string, type: GraphNode["type"]) => {
    const prior = expected.get(id);
    if (prior && prior !== type) sourceCollisions.push(`${id}: ${prior} vs ${type}`);
    expected.set(id, type);
  };
  org.people.forEach((person) =>
    addExpected(deterministicGraphId("org-person", person.id), "person")
  );
  meetings.forEach((meeting) => {
    addExpected(deterministicGraphId("meeting", meeting.id), "meeting");
    [
      ...meeting.decisions.map((text) => ({ kind: "decision", text })),
      ...meeting.risks.map((text) => ({ kind: "risk", text })),
    ]
      .slice(0, 12)
      .forEach((item, index) =>
        addExpected(
          deterministicGraphId("meeting-evidence", `${meeting.id}:${item.kind}:${index}`),
          "evidence"
        )
      );
  });
  commitments.forEach((commitment) =>
    addExpected(deterministicGraphId("commitment", commitment.id), "task")
  );
  const existing = await inspectExistingGraph(expected);

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        enabled: graphEnabled(),
        workspaceId: graphWorkspaceId(),
        people: org.people.filter((person) => person.status === "active").length,
        meetings: meetings.length,
        commitments: commitments.length,
        unresolvedOwners: unresolvedOwners.map((commitment) => ({
          id: commitment.id,
          personId: commitment.personId,
          ownerName: commitment.ownerName,
        })),
        missingMeetings: missingMeetings.map((commitment) => ({
          id: commitment.id,
          sourceMeetingId: commitment.sourceMeetingId,
        })),
        sourceCollisions,
        existingCollisions: existing.collisions,
        dependencyCycles: existing.dependencyCycles,
        personalNotesIncluded: false,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write deterministic graph records.");
    return;
  }
  if (!graphEnabled()) throw new Error("Set EXECUTION_GRAPH_ENABLED=true before applying.");
  if (
    sourceCollisions.length ||
    existing.collisions.length ||
    existing.dependencyCycles.length
  ) {
    throw new Error("Resolve reported graph collisions/cycles before applying the backfill.");
  }
  const result = await projectSharedGraph({ org, meetings, commitments });
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}

async function inspectExistingGraph(
  expected: Map<string, GraphNode["type"]>
): Promise<{ collisions: string[]; dependencyCycles: string[][] }> {
  if (!graphEnabled()) return { collisions: [], dependencyCycles: [] };
  try {
    const containers = graphContainers();
    const [{ resources: nodes }, { resources: edges }] = await Promise.all([
      containers.nodes.items
        .query<Pick<GraphNode, "id" | "type">>({
          query: "SELECT c.id, c.type FROM c WHERE c.workspaceId = @workspaceId",
          parameters: [{ name: "@workspaceId", value: graphWorkspaceId() }],
        })
        .fetchAll(),
      containers.edges.items
        .query<Pick<GraphEdge, "fromId" | "toId">>({
          query:
            "SELECT c.fromId, c.toId FROM c WHERE c.workspaceId = @workspaceId AND c.type = 'depends_on' AND c.reviewState = 'accepted'",
          parameters: [{ name: "@workspaceId", value: graphWorkspaceId() }],
        })
        .fetchAll(),
    ]);
    const collisions = nodes
      .filter((node) => expected.has(node.id) && expected.get(node.id) !== node.type)
      .map((node) => `${node.id}: existing ${node.type}, expected ${expected.get(node.id)}`);
    return { collisions, dependencyCycles: findDependencyCycles(edges) };
  } catch (err) {
    return {
      collisions: [`Could not inspect existing graph: ${(err as Error).message}`],
      dependencyCycles: [],
    };
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
