/**
 * Seed the org directory from a reviewed JSON source.
 *
 * Dry-run (default):
 *   npm run org:import -- --resolve-entra
 * Apply after reviewing the report:
 *   npm run org:import -- --resolve-entra --apply
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectPerson } from "../src/graph/project";
import { listEnabledUsers } from "../src/meetings/graph";
import { parseOrgSeed, planOrgImport } from "../src/org/import";
import {
  listOrgDirectory,
  refreshMeetingViewers,
  upsertOrgDoc,
} from "../src/org/store";
import type { OrgPerson } from "../src/org/types";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const resolveEntra = process.argv.includes("--resolve-entra");
  const file = resolve(
    process.cwd(),
    argValue("file") ?? "data/org/ryalto-org-lite.json"
  );
  const seed = parseOrgSeed(JSON.parse(readFileSync(file, "utf8")));
  const [existing, directory] = await Promise.all([
    listOrgDirectory(),
    resolveEntra ? listEnabledUsers() : Promise.resolve([]),
  ]);
  if (resolveEntra && directory.length === 0) {
    throw new Error("Microsoft 365 directory resolution returned no enabled member users.");
  }
  const plan = planOrgImport(seed, existing, directory);
  const report = {
    mode: apply ? "apply" : "dry-run",
    file,
    source: seed.source,
    current: {
      units: existing.units.length,
      people: existing.people.length,
      roles: existing.roles.length,
    },
    directoryCandidates: resolveEntra ? directory.length : undefined,
    creates: plan.creates,
    updates: plan.updates,
    unchanged: plan.unchanged,
    conflicts: plan.conflicts,
    unresolvedIdentities: plan.unresolvedIdentities,
  };
  console.log(JSON.stringify(report, null, 2));

  if (plan.conflicts.length) {
    throw new Error("Org import has conflicts; nothing was written.");
  }
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after reviewing this report.");
    return;
  }

  const projectionErrors: string[] = [];
  for (const doc of plan.writes) {
    await upsertOrgDoc(doc);
    if (doc.kind === "person") {
      const projected = await projectPerson(doc as OrgPerson);
      projectionErrors.push(...projected.errors);
    }
  }
  await refreshMeetingViewers();
  console.log(
    JSON.stringify(
      {
        applied: plan.writes.length,
        units: plan.writes.filter((doc) => doc.kind === "unit").length,
        people: plan.writes.filter((doc) => doc.kind === "person").length,
        roles: plan.writes.filter((doc) => doc.kind === "role").length,
        projectionErrors,
      },
      null,
      2
    )
  );
  if (projectionErrors.length) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
