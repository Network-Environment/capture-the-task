import restify from "restify";
import { TaskBrainBot } from "../bot";
import { deliver, initDelivery } from "../channels/deliver";
import { startPhotonChannel, stopPhotonChannel } from "../channels/photon";
import { cosmosConfigured } from "../services/cosmos";
import {
  startRequestDeliveryWorker,
  stopRequestDeliveryWorker,
} from "../services/requestDeliveryWorker";
import type { StoredRef } from "../services/conversations";
import { createBotAdapter } from "./adapter";

const adapter = createBotAdapter();
const bot = new TaskBrainBot();
const botAppId = process.env.MicrosoftAppId ?? "";

initDelivery(adapter, botAppId);
void startPhotonChannel().catch((err) =>
  console.error("[imessage] failed to start:", err)
);
startRequestDeliveryWorker(adapter, botAppId);

const server = restify.createServer({ name: "taskbrain-gateway" });
server.use(restify.plugins.bodyParser({ mapParams: false }));

function redirectToAdmin(
  req: restify.Request,
  res: restify.Response,
  next: restify.Next
): void {
  const base = process.env.ADMIN_BASE_URL;
  if (!base) {
    res.send(404, { error: "admin runtime is not configured" });
    next();
    return;
  }
  res.redirect(302, `${base}${req.getPath()}`, next);
}

server.get("/", (_req, res, next) => {
  const base = process.env.ADMIN_BASE_URL;
  if (!base) {
    res.send(200, { ok: true, role: "gateway" });
    return next();
  }
  res.redirect(302, `${base}/admin`, next);
});
server.get("/admin", redirectToAdmin);
server.get("/admin/:section", redirectToAdmin);

server.post("/api/messages", async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

// Worker-only delivery bridge for scheduled jobs and alerts. Interactive
// request results use the durable Cosmos delivery pump above.
server.post("/internal/deliver", async (req, res) => {
  const expected = process.env.DELIVERY_GATEWAY_TOKEN;
  const supplied = req.header("authorization");
  if (!expected || supplied !== `Bearer ${expected}`) {
    res.send(401, { delivered: false });
    return;
  }
  const body = req.body as {
    userId?: string;
    text?: string;
    prefer?: StoredRef;
  };
  if (!body?.userId || !body.text || body.text.length > 20_000) {
    res.send(400, { delivered: false });
    return;
  }
  const delivered = await deliver(body.userId, body.text, body.prefer);
  res.send(200, { delivered });
});

server.get("/healthz", (_req, res, next) => {
  res.send(200, { ok: true, role: "gateway", cosmos: cosmosConfigured() });
  return next();
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`[gateway] listening on :${port}`);
});

process.on("SIGTERM", async () => {
  stopRequestDeliveryWorker();
  await stopPhotonChannel();
  process.exit(0);
});
