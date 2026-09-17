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
  acceptableOutcomes?: Array<{
    disposition: "proceed" | "clarify" | "help" | "refuse";
    kinds: string[];
    clarify: boolean;
  }>;
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
    const outcomes = fixture.acceptableOutcomes ?? [{
      disposition: fixture.expectedDisposition,
      kinds: fixture.expectedKinds,
      clarify: fixture.mustClarify,
    }];
    const ok = outcomes.some(
      (expected) =>
        JSON.stringify(kinds) === JSON.stringify(expected.kinds) &&
        plan.disposition === expected.disposition &&
        clarify === expected.clarify
    );
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${fixture.name}`);
    if (!ok) {
      console.log(`  expected=${JSON.stringify(outcomes)}`);
      console.log(`  actual   disposition=${plan.disposition} kinds=${kinds.join(",")} clarify=${clarify}`);
      console.log(`  plan=${JSON.stringify(plan)}`);
    }
  }
  console.log(`${passed}/${fixtures.length} intent evaluations passed`);
  process.exit(passed === fixtures.length ? 0 : 1);
}

void main();
