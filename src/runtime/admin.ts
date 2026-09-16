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
} from "../admin/dashboard";
import { cosmosConfigured } from "../services/cosmos";

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
server.get("/healthz", (_req, res, next) => {
  res.send(200, { ok: true, role: "admin", cosmos: cosmosConfigured() });
  return next();
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`[admin] listening on :${port}`);
});
