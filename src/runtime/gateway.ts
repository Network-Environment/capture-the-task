import restify from "restify";
import { TaskBrainBot } from "../bot";
import { warmAckNames } from "../channels/acknowledge";
import { imessageUserIds } from "../channels/types";
import { deliver, initDelivery } from "../channels/deliver";
import { stopPhotonChannel, supervisePhotonChannel, photonHealthy } from "../channels/photon";
import { pingCosmos } from "../services/cosmos";
import { onStop } from "./lifecycle";
import { beat, liveness, readiness, noteCosmosReady } from "./health";
import {
  startRequestDeliveryWorker,
  stopRequestDeliveryWorker,
} from "../services/requestDeliveryWorker";
import type { StoredRef } from "../services/conversations";
import { createBotAdapter } from "./adapter";
import { logActivity } from "../services/activityLog";
import { acceptGraphNotification, verifyWebhook, type GraphNotification } from "../channels/webhook";

const adapter = createBotAdapter();
const bot = new TaskBrainBot();
const botAppId = process.env.MicrosoftAppId ?? "";

initDelivery(adapter, botAppId);
void supervisePhotonChannel();
startRequestDeliveryWorker(adapter, botAppId);

const warmNames = () =>
  void warmAckNames(imessageUserIds()).catch((err) =>
    console.error("[ack] name warm-up failed:", err)
  );
warmNames();
setInterval(warmNames, 6 * 60 * 60_000);

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

// Signed ingress for external events. Graph subscriptions use clientState;
// every other source uses HMAC over `${timestamp}.${body}`.
server.post("/api/hooks/:source", async (req, res) => {
  const source = String(req.params.source ?? "");
  const validation = (req.query as { validationToken?: string } | undefined)?.validationToken;
  if (source === "graph" && validation) {
    res.header("Content-Type", "text/plain");
    res.send(200, validation);
    return;
  }
  const raw = typeof (req as { rawBody?: string }).rawBody === "string"
    ? (req as { rawBody: string }).rawBody
    : JSON.stringify(req.body ?? {});
  if (source === "graph") {
    const notes = ((req.body as { value?: GraphNotification[] } | undefined)?.value) ?? [];
    const reason = acceptGraphNotification(process.env.GRAPH_WEBHOOK_CLIENT_STATE, notes);
    if (reason) {
      res.send(401, { accepted: false });
      return;
    }
    void logActivity({
      type: "webhook",
      origin: "system",
      channel: "internal",
      trigger: "graph",
      detail: { count: notes.length },
    });
    res.send(202, { accepted: true });
    return;
  }
  const reason = verifyWebhook({
    secret: process.env.WEBHOOK_SECRET,
    timestamp: req.header("x-taskbrain-timestamp"),
    signature: req.header("x-taskbrain-signature"),
    body: raw,
  });
  if (reason) {
    res.send(reason === "webhook secret is not configured" ? 404 : 401, { accepted: false });
    return;
  }
  void logActivity({
    type: "webhook",
    origin: "system",
    channel: "internal",
    trigger: source.slice(0, 40),
    detail: { bytes: raw.length },
  });
  res.send(202, { accepted: true });
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
    recordTurn?: boolean;
  };
  if (!body?.userId || !body.text || body.text.length > 20_000) {
    res.send(400, { delivered: false });
    return;
  }
  try {
    const delivered = await deliver(body.userId, body.text, body.prefer, {
      recordTurn: body.recordTurn === true,
    });
    res.send(200, { delivered });
  } catch (err) {
    console.error("[gateway] internal deliver failed:", err);
    res.send(200, { delivered: false });
  }
});

let cosmosCache: { at: number; ok: boolean } | undefined;
server.get("/healthz", (_req, res, next) => {
  res.send(200, liveness("gateway"));
  return next();
});
server.get("/readyz", async (_req, res) => {
  if (!cosmosCache || Date.now() - cosmosCache.at > 15_000) {
    cosmosCache = { at: Date.now(), ok: await pingCosmos() };
  }
  noteCosmosReady(cosmosCache.ok, cosmosCache.ok ? "cosmos query succeeded" : "cosmos query failed");
  beat("gateway", 60_000);
  const body = readiness("gateway");
  const ok = body.ok && photonHealthy();
  res.send(ok ? 200 : 503, { ...body, ok });
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`[gateway] listening on :${port}`);
});

onStop(() => stopRequestDeliveryWorker());
onStop(() => stopPhotonChannel());
