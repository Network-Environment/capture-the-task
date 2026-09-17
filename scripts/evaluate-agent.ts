import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { channelPolicy } from "../src/channels/types";
import { runAgent } from "../src/services/agent";
import { scheduledReadToolEnvelope } from "../src/tools/registry";

interface Fixture {
  name: string;
  input: string;
  requiredAnyTools: string[];
  forbiddenTools?: string[];
}

async function main(): Promise<void> {
  let fixtures = JSON.parse(
    readFileSync(resolve(process.cwd(), "config/agent.evals.json"), "utf8")
  ) as Fixture[];
  if (process.argv[2]) {
    fixtures = fixtures.filter((fixture) =>
      fixture.name.toLowerCase().includes(process.argv[2].toLowerCase())
    );
  }

  const allowedTools = await scheduledReadToolEnvelope();
  let passed = 0;
  for (const fixture of fixtures) {
    const called: string[] = [];
    await runAgent(
      {
        userId: "agent-evaluation",
        origin: "system",
        channel: "internal",
        trigger: "agent_tool_eval",
        authorization: {
          explicit: true,
          confidence: 1,
          channel: channelPolicy("teams", { allowActions: false }),
        },
        allowedTools,
        dryRunTools: true,
        observeToolCall: (name) => called.push(name),
      },
      fixture.input
    );
    const required = fixture.requiredAnyTools.some((name) => called.includes(name));
    const forbidden = (fixture.forbiddenTools ?? []).filter((name) => called.includes(name));
    const ok = required && forbidden.length === 0;
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${fixture.name}`);
    if (!ok) {
      console.log(`  expected any=${fixture.requiredAnyTools.join(",")}`);
      console.log(`  forbidden=${(fixture.forbiddenTools ?? []).join(",")}`);
      console.log(`  called=${called.join(",") || "(none)"}`);
    }
  }
  console.log(`${passed}/${fixtures.length} agent tool evaluations passed`);
  process.exit(passed === fixtures.length ? 0 : 1);
}

void main();
