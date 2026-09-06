/**
 * iMessage channel via Photon (spectrum-ts).
 *
 * Runs a single long-lived Spectrum stream inside the App Service process:
 * inbound messages arrive over the SDK stream, replies and attachment bytes go
 * back over the same connection. No public URL, no webhook, no signing secret —
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
 * spectrum-ts is ESM-only and this project compiles to CommonJS, so the SDK
 * is pulled in with a dynamic import; static imports fail to compile.
 */
import type { SpectrumInstance, Platform, PlatformInstance } from "spectrum-ts" with { "resolution-mode": "import" };
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

type IMessagePlatform = (typeof import("spectrum-ts/providers/imessage", {
  with: { "resolution-mode": "import" },
}))["imessage"];
type IMessageInstance = IMessagePlatform extends Platform<infer Def> ? PlatformInstance<Def> : never;

// The provider stream is typed as [space, message], so pulling the pair apart
// here gives the iMessage-specific fields (space.type, sender.id) for free.
type IMessageStream = IMessageInstance["messages"];
type IMessageSpace = IMessageStream extends AsyncIterable<[infer S, unknown]> ? S : never;
type IMessageMessage = IMessageStream extends AsyncIterable<[unknown, infer M]> ? M : never;

let app: SpectrumInstance | null = null;
let im: IMessageInstance | null = null;

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

  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");

  const spectrum = await Spectrum({
    projectId: process.env.SPECTRUM_PROJECT_ID!,
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
    providers: [imessage.config()],
  });
  app = spectrum;
  im = imessage(spectrum);
  console.log("[imessage] Photon stream connected");

  // Fire-and-forget consumer; reconnects are handled inside the SDK.
  void (async () => {
    for await (const [space, message] of im!.messages) {
      try {
        await handleInbound(space, message);
      } catch (err) {
        console.error("[imessage] handler error:", err);
        void logActivity({ type: "error", detail: { channel: "imessage", message: (err as Error).message } });
      }
    }
  })();
}

async function handleInbound(space: IMessageSpace, message: IMessageMessage): Promise<void> {
  if (alreadySeen(message.id)) return;
  if (space.type === "group") return; // DMs only for a personal capture tool

  const phone = message.sender?.id;
  if (!phone) return;
  const userId = resolveIMessageUser(phone);
  if (!userId) {
    console.warn(`[imessage] ignoring unknown sender ${phone}`);
    return; // allowlist: no reply, no trace of a brain
  }

  void saveConversationRef(userId, { channel: "imessage", phone, spaceId: space.id });

  // Content is one part per message: text, a voice memo, or an attachment
  // whose bytes are fetched lazily. Anything else (reactions, typing) is noise.
  const content = message.content;
  let text: string | undefined;
  let audio: Buffer | undefined;
  let unsupportedAttachment = false;

  switch (content.type) {
    case "text":
      text = content.text.trim() || undefined;
      break;
    case "markdown":
      text = content.markdown.trim() || undefined;
      break;
    case "voice":
      audio = await content.read();
      break;
    case "attachment":
      if (content.mimeType.startsWith("audio/")) audio = await content.read();
      else unsupportedAttachment = true;
      break;
    default:
      return;
  }

  if (!text && !audio) {
    if (unsupportedAttachment) {
      await space.send("I can take text and voice memos here — other attachments aren't supported yet.");
    }
    return;
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
    const space = await im.space.create(user);
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
