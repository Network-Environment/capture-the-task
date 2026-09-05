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
 * spectrum-ts is ESM-only and this project compiles to CommonJS, so the SDK
 * is pulled in with a dynamic import; static imports fail to compile.
 */
import type { ContentBuilder, Message, Space, SpectrumInstance, Platform, PlatformInstance } from "spectrum-ts" with { "resolution-mode": "import" };
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

/** `text()` is generic over a non-empty string literal; we only ever have runtime strings. */
type TextBuilder = (content: string) => ContentBuilder;

let app: SpectrumInstance | null = null;
let im: IMessageInstance | null = null;
let platform: IMessagePlatform | null = null;
let asText: TextBuilder | null = null;

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

  const { Spectrum, text } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");

  const spectrum = await Spectrum({
    projectId: process.env.SPECTRUM_PROJECT_ID!,
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
    providers: [imessage.config()],
  });
  app = spectrum;
  im = imessage(spectrum);
  platform = imessage;
  asText = text as TextBuilder;
  console.log("[imessage] Photon stream connected");

  // Fire-and-forget consumer; reconnects are handled inside the SDK.
  void (async () => {
    for await (const [space, message] of spectrum.messages) {
      try {
        await handleInbound(space, message);
      } catch (err) {
        console.error("[imessage] handler error:", err);
        void logActivity({ type: "error", detail: { channel: "imessage", message: (err as Error).message } });
      }
    }
  })();
}

async function handleInbound(space: Space, message: Message): Promise<void> {
  if (alreadySeen(message.id)) return;

  // The generic Space carries no provider fields; narrow it to the iMessage one.
  if (platform!(message.space).type === "group") return; // DMs only for a personal capture tool

  const phone = message.sender.id;
  if (!phone) return;
  const userId = resolveIMessageUser(phone);
  if (!userId) {
    console.warn(`[imessage] ignoring unknown sender ${phone}`);
    return; // allowlist: no reply, no trace of a brain
  }

  void saveConversationRef(userId, { channel: "imessage", phone, spaceId: message.space.id });

  // A message is a list of content parts: text, attachments (bytes inline),
  // and provider-specific extras we ignore.
  let text: string | undefined;
  let audio: Buffer | undefined;
  let hasOtherAttachment = false;

  for (const part of message.content) {
    if (part.type === "plain_text") {
      text = text ? `${text} ${part.text}` : part.text;
    } else if (part.type === "attachment") {
      if (part.mimeType.startsWith("audio/")) audio ??= part.data;
      else hasOtherAttachment = true;
    }
  }
  text = text?.trim() || undefined;

  if (!text && !audio) {
    if (hasOtherAttachment) {
      await space.send(asText!("I can take text and voice memos here — other attachments aren't supported yet."));
    }
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
    await space.send(asText!(toPlainText(out.title, out.body, out.tags)));
  });
}

/** Proactive delivery to a user's iMessage (job results, alerts). */
export async function sendIMessage(userId: string, text: string): Promise<boolean> {
  if (!app || !im || !asText) return false;
  const phone = phoneForUser(userId);
  if (!phone) return false;
  try {
    const user = await im.user(phone);
    const space = await im.space([user]);
    await space.send(asText(text));
    return true;
  } catch (err) {
    console.error("[imessage] proactive send failed:", err);
    return false;
  }
}

export async function stopPhotonChannel(): Promise<void> {
  await app?.stop();
}
