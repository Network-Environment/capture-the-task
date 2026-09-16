import restify from "restify";
import { initDelivery } from "../channels/deliver";
import { startOrchestrator } from "../jobs/orchestrator";
import { cosmosConfigured } from "../services/cosmos";
import {
  startRequestWorker,
  stopRequestWorker,
} from "../services/requestWorker";
import { createBotAdapter } from "./adapter";

const adapter = createBotAdapter();
const botAppId = process.env.MicrosoftAppId ?? "";

// The adapter is required to create a proactive TurnContext for delegated
// Teams To Do access. Normal outbound delivery is forwarded to the gateway.
initDelivery(adapter, botAppId);
startOrchestrator(adapter, botAppId);
startRequestWorker(adapter, botAppId);

const server = restify.createServer({ name: "taskbrain-worker" });
server.get("/healthz", (_req, res, next) => {
  res.send(200, { ok: true, role: "worker", cosmos: cosmosConfigured() });
  return next();
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`[worker] listening on :${port}`);
});

process.on("SIGTERM", () => {
  stopRequestWorker();
  process.exit(0);
});
