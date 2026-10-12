import { initTelemetry } from "./runtime/telemetry";
import { bindShutdown } from "./runtime/lifecycle";

const role = (process.env.TASKBRAIN_ROLE ?? "gateway").toLowerCase();

const entrypoints: Record<string, () => Promise<unknown>> = {
  admin: () => import("./runtime/admin.js"),
  gateway: () => import("./runtime/gateway.js"),
  worker: () => import("./runtime/worker.js"),
};

const start = entrypoints[role];
if (!start) {
  console.error(JSON.stringify({ event: "startup_failed", role, message: "unknown role" }));
  process.exit(1);
}

void (async () => {
  await bindShutdown(role);
  await initTelemetry(role);
  await start();
})().catch((err) => {
  console.error(JSON.stringify({
    event: "startup_failed",
    role,
    message: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
