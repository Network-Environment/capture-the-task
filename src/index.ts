import restify from "restify";
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
} from "botbuilder";
import { TaskBrainBot } from "./bot";
import {
  adminPage,
  mutateExecutionGraphApi,
  queueMeetingSummaries,
  readExecutionGraphApi,
  saveOrgDirectory,
} from "./admin/dashboard";
import { startOrchestrator } from "./jobs/orchestrator";
import { initDelivery } from "./channels/deliver";
import { startPhotonChannel, stopPhotonChannel } from "./channels/photon";
import { refreshMeetingViewers } from "./org/store";
import { cosmosConfigured } from "./services/cosmos";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const auth = new ConfigurationBotFrameworkAuthentication(
  process.env as ConfigurationBotFrameworkAuthenticationOptions
);
const adapter = new CloudAdapter(auth);

adapter.onTurnError = async (context, error) => {
  console.error("[onTurnError]", error);
  await context.sendActivity(
    "Something broke on my end — that capture was not saved. Try again in a moment."
  );
};

const bot = new TaskBrainBot();
const botAppId = process.env.MicrosoftAppId ?? "";

// Proactive delivery (jobs, alerts) routes to Teams or iMessage per user.
initDelivery(adapter, botAppId);

// iMessage channel via Photon: persistent stream, no-op if not configured.
startPhotonChannel().catch((e) => console.error("[imessage] failed to start:", e));

// Single orchestrator: polls jobs every 60s, runs them through the agent.
startOrchestrator(adapter, botAppId);

const server = restify.createServer();
server.use(restify.plugins.bodyParser());

server.post("/api/messages", async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

// Sign-in can land on the root (Easy Auth only preserves a return path when the
// user started at a protected URL), so send the bare hostname to the dashboard.
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
server.get("/admin/:section", adminPage);
server.post("/admin/meetings/summarize", queueMeetingSummaries);
server.post("/admin/org", saveOrgDirectory);

server.get("/healthz", (_req, res, next) => {
  res.send(200, {
    ok: true,
    cosmos: cosmosConfigured(),
    storage: Boolean(process.env.STORAGE_CONNECTION_STRING),
  });
  return next();
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`TaskBrain listening on :${port}`);
  void refreshMeetingViewers().catch((err) =>
    console.error("[org] meeting viewer warmup failed:", err)
  );
});

process.on("SIGTERM", async () => {
  await stopPhotonChannel();
  process.exit(0);
});
