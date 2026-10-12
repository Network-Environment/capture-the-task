import { readFileSync } from "node:fs";
import { join } from "node:path";
import restify from "restify";
import {
  adminPage,
  mutateExecutionGraphApi,
  queueMeetingSummaries,
  readExecutionGraphApi,
  readMemoryFactsApi,
  readMcpHealthApi,
  saveOrgDirectory,
  savePmoBoard,
  verifyMeetingCsrf,
} from "../admin/dashboard";
import { recoveryDecision } from "../admin/recoveryConsole";
import { resolveIncident } from "../services/recoveryIncidents";
import { getAgentRequest } from "../services/requestQueue";
import { pingCosmos } from "../services/cosmos";
import { liveness, noteCosmosReady, readiness } from "./health";

const server = restify.createServer({ name: "taskbrain-admin" });
server.use(restify.plugins.bodyParser());

server.get("/", (_req, res, next) => {
  res.redirect(302, "/admin", next);
});
server.get("/admin", adminPage);
server.get("/admin/assets/graph.js", (_req, res, next) => {
  try {
    res.sendRaw(
      200,
      readFileSync(join(process.cwd(), "dist", "admin", "graph.js"), "utf8"),
      {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "private, no-cache",
      }
    );
  } catch {
    res.send(503, "graph client bundle is unavailable; run npm run build:admin");
  }
  return next();
});
server.get("/admin/api/graph", readExecutionGraphApi);
server.post("/admin/api/graph", mutateExecutionGraphApi);
server.get("/admin/api/memory-facts", readMemoryFactsApi);
server.get("/admin/api/mcp-health", readMcpHealthApi);
server.get("/admin/:section", adminPage);
server.post("/admin/meetings/summarize", queueMeetingSummaries);
server.post("/admin/org", saveOrgDirectory);
server.post("/admin/boards", savePmoBoard);
server.post("/admin/recovery", async (req, res) => {
  const productionAdmin = Boolean(
    process.env.WEBSITE_INSTANCE_ID && req.header("x-ms-client-principal")
  );
  const body = (req.body ?? {}) as { action?: string; source?: string; subject?: string; requestId?: string; _csrf?: string };
  if (!verifyMeetingCsrf(String(body._csrf ?? ""), "recovery")) {
    res.send(403, { error: "invalid or expired request" });
    return;
  }
  const request = body.requestId ? await getAgentRequest(String(body.requestId)) : undefined;
  const decision = recoveryDecision({
    action: String(body.action ?? ""),
    request,
    productionAdmin,
  });
  if (!decision.ok) {
    res.send(403, { error: decision.reason });
    return;
  }
  if (body.action === "dismiss" && body.source && body.subject) {
    await resolveIncident(body.source, body.subject, "dismissed", "dismissed from admin", "admin");
  }
  res.send(200, { ok: true, reason: decision.reason });
});
let cosmosCache: { at: number; ok: boolean } | undefined;
server.get("/healthz", (_req, res, next) => {
  res.send(200, liveness("admin"));
  return next();
});
server.get("/readyz", async (_req, res) => {
  if (!cosmosCache || Date.now() - cosmosCache.at > 15_000) {
    cosmosCache = { at: Date.now(), ok: await pingCosmos() };
  }
  noteCosmosReady(cosmosCache.ok);
  const body = readiness("admin");
  res.send(body.ok ? 200 : 503, body);
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`[admin] listening on :${port}`);
});
