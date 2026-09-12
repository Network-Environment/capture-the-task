import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { interpretIntent } from "../src/services/agent";
import { planNeedsClarification } from "../src/services/intent";

interface Fixture {
  name: string;
  input: string;
  expectedKinds: string[];
  expectedDisposition: "proceed" | "clarify" | "help" | "refuse";
  mustClarify: boolean;
}

async function main(): Promise<void> {
  let fixtures = JSON.parse(
    readFileSync(resolve(process.cwd(), "config/intent.evals.json"), "utf8")
  ) as Fixture[];
  if (process.argv[2]) {
    fixtures = fixtures.filter((fixture) =>
      fixture.name.toLowerCase().includes(process.argv[2].toLowerCase())
    );
  }
  let passed = 0;
  for (const fixture of fixtures) {
    const plan = await interpretIntent(fixture.input, [], {
      origin: "system",
      channel: "internal",
      trigger: "intent_eval",
    });
    const kinds = plan.intents.map((intent) => intent.kind);
    const clarify = planNeedsClarification(plan);
    const ok =
      JSON.stringify(kinds) === JSON.stringify(fixture.expectedKinds) &&
      plan.disposition === fixture.expectedDisposition &&
      clarify === fixture.mustClarify;
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${fixture.name}`);
    if (!ok) {
      console.log(`  expected disposition=${fixture.expectedDisposition} kinds=${fixture.expectedKinds.join(",")} clarify=${fixture.mustClarify}`);
      console.log(`  actual   disposition=${plan.disposition} kinds=${kinds.join(",")} clarify=${clarify}`);
      console.log(`  plan=${JSON.stringify(plan)}`);
    }
  }
  console.log(`${passed}/${fixtures.length} intent evaluations passed`);
  process.exit(passed === fixtures.length ? 0 : 1);
}

void main();
