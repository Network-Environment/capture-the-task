/**
 * One-off operational tool: quarantine a poison request in `agent-requests`.
 *
 * A request that wedges the worker is re-claimed on every container start,
 * so the app never stays up long enough to drain it. This marks the document
 * terminal (status `failed`) without deleting the audit trail.
 *
 * Usage: node scripts/quarantine-request.js <requestId>
 */
const { CosmosClient } = require("@azure/cosmos");

const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const id = process.argv[2];

if (!endpoint || !key || !id) {
  console.error("COSMOS_ENDPOINT, COSMOS_KEY env vars and a request id are required");
  process.exit(1);
}

(async () => {
  const container = new CosmosClient({ endpoint, key })
    .database("taskbrain")
    .container("agent-requests");

  const { resource } = await container.item(id, "agent").read();
  if (!resource) {
    console.error(`request ${id} not found`);
    process.exit(1);
  }

  console.log(
    `before: status=${resource.status} attempts=${resource.attempts} leaseUntil=${resource.leaseUntil}`
  );

  await container.item(id, "agent").replace({
    ...resource,
    status: "failed",
    leaseUntil: undefined,
    finishedAt: new Date().toISOString(),
    lastError: "Quarantined: request wedged the worker and was replayed on every restart.",
  });

  const { resource: after } = await container.item(id, "agent").read();
  console.log(`after:  status=${after.status} finishedAt=${after.finishedAt}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
