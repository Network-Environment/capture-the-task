/**
 * iMessage channel via Photon (spectrum-ts).
 *
 * Runs a single long-lived Spectrum stream inside the App Service process:
 * inbound messages arrive over gRPC, replies and attachment bytes go back
 * over the same connection. No public URL, no webhook, no signing secret —
 * Photon has no HTTP send endpoint, so the SDK stream is the only way to do
 * two-way messaging anyway.
 *
 * Governance built in:
 *  - Only phone numbers in config/channels.json identities are processed.
 *  - Each is mapped to a canonical Entra object id so the brain is shared
 *    with Teams. Unknown senders are silently ignored.
 *  - allowActions=false (default) keeps this channel capture-only.
 *  - Inbound messages are deduped on message.id (Photon redelivers on retry).
 *
 * NOTE for maintainers: the spectrum-ts surface used here — Spectrum(),
 * imessage.config(), app.messages, space.send(), space.responding(),
 * im.getAttachment(), im.user()/im.space() — is from Photon's docs as of
 * Sept 2026. Verify against the installed version after `npm ci`.
 */
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { processCapture } from "../pipeline";
import { saveConversationRef } from "../services/conversations";
import { logActivity } from "../services/activityLog";
import {
  imessageEnabled,
  imessageAllowsActions,
  resolveIMessageUser,
  phoneForUser,
  toPlainText,
} from "./types";

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;
let app: SpectrumApp | null = null;
let im: ReturnType<typeof imessage> | null = null;

const seen = new Map<string, number>(); // message.id → seenAt (dedupe, 48h)
function alreadySeen(id: string): boolean {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 48 * 3600_000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

export async function startPhotonChannel(): Promise<void> {
  if (!imessageEnabled()) {
    console.log("[imessage] disabled (config or missing SPECTRUM_PROJECT_ID)");
    return;
  }

  app = await Spectrum({
    projectId: process.env.SPECTRUM_PROJECT_ID!,
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
    providers: [imessage.config()],
  });
  im = imessage(app);
  console.log("[imessage] Photon stream connected");

  // Fire-and-forget consumer; reconnects are handled inside the SDK.
  void (async () => {
    for await (const [space, message] of app!.messages) {
      try {
        await handleInbound(space, message);
      } catch (err) {
        console.error("[imessage] handler error:", err);
        void logActivity({ type: "error", detail: { channel: "imessage", message: (err as Error).message } });
      }
    }
  })();
}

// Loose structural types so we don't couple to exact SDK generics.
interface InboundMessage {
  id: string;
  sender?: { id: string };
  content: { type: string; text?: string; id?: string; mimeType?: string; name?: string };
  space: { id: string; type?: string; phone?: string };
}
interface Space {
  send(content: string): Promise<unknown>;
  responding<T>(fn: () => Promise<T>): Promise<T>;
}

async function handleInbound(space: Space, message: InboundMessage): Promise<void> {
  if (alreadySeen(message.id)) return;
  if (message.space.type === "group") return; // DMs only for a personal capture tool

  const phone = message.sender?.id;
  if (!phone) return;
  const userId = resolveIMessageUser(phone);
  if (!userId) {
    console.warn(`[imessage] ignoring unknown sender ${phone}`);
    return; // allowlist: no reply, no trace of a brain
  }

  void saveConversationRef(userId, { channel: "imessage", phone, spaceId: message.space.id });

  let text: string | undefined;
  let audio: Buffer | undefined;

  switch (message.content.type) {
    case "text":
      text = message.content.text;
      break;
    case "attachment": {
      if (!message.content.mimeType?.startsWith("audio/")) {
        await space.send("I can take text and voice memos here — other attachments aren't supported yet.");
        return;
      }
      const file = await im!.getAttachment(message.content.id!, message.space.phone);
      if (!file) {
        await space.send("That voice memo expired before I could fetch it — mind resending?");
        return;
      }
      audio = await file.read();
      break;
    }
    default:
      return; // reactions, richlinks, etc. — ignore quietly
  }

  await space.responding(async () => {
    const out = await processCapture({
      userId,
      channel: "imessage",
      text,
      audio,
      allowActions: imessageAllowsActions(),
      conversationRef: { channel: "imessage", phone },
    });
    await space.send(toPlainText(out.title, out.body, out.tags));
  });
}

/** Proactive delivery to a user's iMessage (job results, alerts). */
export async function sendIMessage(userId: string, text: string): Promise<boolean> {
  if (!app || !im) return false;
  const phone = phoneForUser(userId);
  if (!phone) return false;
  try {
    const user = await im.user(phone);
    const space = im.space(user);
    await space.send(text);
    return true;
  } catch (err) {
    console.error("[imessage] proactive send failed:", err);
    return false;
  }
}

export async function stopPhotonChannel(): Promise<void> {
  await app?.stop();
}
