const role = (process.env.TASKBRAIN_ROLE ?? "gateway").toLowerCase();

const entrypoints: Record<string, () => Promise<unknown>> = {
  admin: () => import("./runtime/admin.js"),
  gateway: () => import("./runtime/gateway.js"),
  worker: () => import("./runtime/worker.js"),
};

const start = entrypoints[role];
if (!start) {
  throw new Error(
    `Unknown TASKBRAIN_ROLE "${role}"; expected admin, gateway, or worker.`
  );
}

void start().catch((err) => {
  console.error(`[startup:${role}]`, err);
  process.exitCode = 1;
});
