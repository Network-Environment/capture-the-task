import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureFromActivity, replayFixture, type ActivitySlice } from "../src/services/runReplay";

interface ReplayCase {
  name: string;
  runId: string;
  events: ActivitySlice[];
}

async function main(): Promise<void> {
  const file = resolve(process.cwd(), process.argv[2] ?? "config/activity.replay.json");
  const cases = JSON.parse(readFileSync(file, "utf8")) as ReplayCase[];
  let passed = 0;
  for (const item of cases) {
    const failures = replayFixture(fixtureFromActivity(item.events, item.runId));
    if (failures.length === 0) {
      passed += 1;
      console.log(`PASS ${item.name}`);
      continue;
    }
    console.log(`FAIL ${item.name}`);
    for (const failure of failures) console.log(`  ${failure.check}: ${failure.detail}`);
  }
  console.log(`${passed}/${cases.length} activity replays passed`);
  process.exit(passed === cases.length ? 0 : 1);
}

void main();
