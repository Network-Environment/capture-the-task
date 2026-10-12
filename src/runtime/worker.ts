import restify from "restify";
import { initDelivery } from "../channels/deliver";
import { startOrchestrator, stopOrchestrator } from "../jobs/orchestrator";
import { pingCosmos } from "../services/cosmos";
import {
  requestWorkerHealthy,
  startRequestWorker,
  stopRequestWorker,
} from "../services/requestWorker";
import { onStop } from "./lifecycle";
import { beat, liveness, noteCosmosReady, readiness } from "./health";
import { createBotAdapter } from "./adapter";

const adapter = createBotAdapter();
const botAppId = process.env.MicrosoftAppId ?? "";

// The adapter is required to create a proactive TurnContext for delegated
// Teams To Do access. Normal outbound delivery is forwarded to the gateway.
initDelivery(adapter, botAppId);
startOrchestrator(adapter, botAppId);
startRequestWorker(adapter, botAppId);

const server = restify.createServer({ name: "taskbrain-worker" });
let cosmosCache: { at: number; ok: boolean } | undefined;
server.get("/healthz", (_req, res, next) => {
  res.send(200, liveness("worker"));
  return next();
});
server.get("/readyz", async (_req, res, next) => {
  if (!cosmosCache || Date.now() - cosmosCache.at > 15_000) {
    cosmosCache = { at: Date.now(), ok: await pingCosmos() };
  }
  noteCosmosReady(cosmosCache.ok);
  if (requestWorkerHealthy()) beat("request-worker", 60_000);
  const body = readiness("worker");
  const ok = body.ok && requestWorkerHealthy();
  res.send(ok ? 200 : 503, { ...body, ok });
  return next();
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`[worker] listening on :${port}`);
});

onStop(() => {
  stopRequestWorker();
  stopOrchestrator();
});
