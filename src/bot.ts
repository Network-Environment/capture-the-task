/**
 * Teams channel adapter (Bot Framework). Normalizes an activity into a
 * CaptureInput, runs the shared pipeline, renders the result as an Adaptive
 * Card. All capture logic lives in src/pipeline.ts.
 */
import { ActivityHandler, TurnContext, CardFactory, Attachment } from "botbuilder";
import { processCapture } from "./pipeline";
import { downloadAudio } from "./services/transcription";
import { createTodoTask } from "./services/graphTasks";
import { saveConversationRef } from "./services/conversations";

const AUDIO_TYPES = [
  "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac", "audio/ogg",
  "application/vnd.microsoft.teams.file.download.info",
];

export class TaskBrainBot extends ActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      const userId = context.activity.from.aadObjectId ?? context.activity.from.id;
      const convRef = TurnContext.getConversationReference(context.activity);
      void saveConversationRef(userId, convRef);

      // Voice clip → bytes (Teams-served URLs need the connector token)
      let audio: Buffer | undefined;
      const att = (context.activity.attachments ?? []).find((a) => AUDIO_TYPES.includes(a.contentType));
      if (att) {
        await context.sendActivity({ type: "typing" });
        const url = resolveAudioUrl(att);
        if (!url) {
          await context.sendActivity("I got an attachment I can't read. Voice clips and audio files only.");
          return next();
        }
        audio = await downloadAudio(url, await getAttachmentToken(context));
      }

      const out = await processCapture({
        userId,
        channel: "teams",
        text: context.activity.text,
        audio,
        allowActions: true,
        conversationRef: convRef,
        createTask: (title, detail, due) => createTodoTask(context, title, detail, due),
      });

      await context.sendActivity({ attachments: [card(out.title, out.body, out.tags)] });
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      for (const m of context.activity.membersAdded ?? []) {
        if (m.id !== context.activity.recipient.id) {
          await context.sendActivity(
            "Hey — I'm TaskBrain. Send me anything: a voice memo from your phone, a half-formed idea, a task. " +
              "I'll transcribe it, figure out what it is, and file it. Ask me things like " +
              "\"what did I capture about the substation project?\" to recall."
          );
        }
      }
      await next();
    });
  }
}

function resolveAudioUrl(a: Attachment): string | undefined {
  if (a.contentType === "application/vnd.microsoft.teams.file.download.info") {
    return (a.content as { downloadUrl?: string })?.downloadUrl;
  }
  return a.contentUrl;
}

async function getAttachmentToken(context: TurnContext): Promise<string | undefined> {
  try {
    const connector = context.turnState.get(context.adapter.ConnectorClientKey);
    const creds = connector?.credentials;
    return creds ? await creds.getToken() : undefined;
  } catch {
    return undefined;
  }
}

function card(title: string, body: string, tags: string[]): Attachment {
  return CardFactory.adaptiveCard({
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: title, weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: body, wrap: true },
      ...(tags.length
        ? [{ type: "TextBlock", text: tags.map((t) => `#${t}`).join("  "), isSubtle: true, wrap: true }]
        : []),
    ],
  });
}
