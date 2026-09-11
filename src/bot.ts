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
import { channelEnvelope, THINKING_RESPONSE } from "./channels/types";
import {
  botWasMentioned,
  isPersonalTeamsConversation,
  stripBotMention,
} from "./channels/teamsText";

const AUDIO_TYPES = [
  "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac", "audio/ogg",
  "application/vnd.microsoft.teams.file.download.info",
];

export class TaskBrainBot extends ActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      const userId = context.activity.from.aadObjectId ?? context.activity.from.id;
      const personal = isPersonalTeamsConversation(context.activity.conversation?.conversationType);
      const convRef = TurnContext.getConversationReference(context.activity);
      const bot = { id: context.activity.recipient?.id, name: context.activity.recipient?.name };
      const entities = context.activity.entities as { type?: string; text?: string; mentioned?: { id?: string; name?: string } }[] | undefined;

      // Channel / group chat: only handle @mentions so we never ingest the whole thread.
      if (!personal && !botWasMentioned(entities, bot.id, bot.name, context.activity.text)) {
        return next();
      }

      // Proactive jobs/alerts stay on the 1:1 chat, not the channel that @mentioned us.
      if (personal) void saveConversationRef(userId, convRef);

      const submitted = context.activity.value as
        | { taskbrainApproval?: string; pendingActionId?: string }
        | undefined;
      const approvalText =
        submitted?.taskbrainApproval && submitted.pendingActionId
          ? `${submitted.taskbrainApproval} ${submitted.pendingActionId}`
          : undefined;
      const text = approvalText ?? stripBotMention(context.activity.text, entities, bot);

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

      if (!text && !audio) {
        await context.sendActivity(
          personal
            ? "Send a thought, a task, or a voice memo — or ask me what you captured."
            : "Mention me with a question. Open the private TaskBrain chat to save or change anything."
        );
        return next();
      }

      await context.sendActivity(THINKING_RESPONSE);

      const out = await processCapture({
        userId,
        channel: "teams",
        text,
        audio,
        ...channelEnvelope("teams", {
          eventId: context.activity.id,
          conversationId: context.activity.conversation?.id,
          scope: personal ? "private" : "group",
          identity: context.activity.from.aadObjectId ? "canonical" : "weak",
          allowActions: true,
        }),
        conversationRef: personal ? convRef : undefined,
        createTask: (title, detail, due) => createTodoTask(context, title, detail, due),
      });

      await context.sendActivity({ attachments: [card(out.title, out.body, out.tags)] });
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      if (!isPersonalTeamsConversation(context.activity.conversation?.conversationType)) {
        return next();
      }
      for (const m of context.activity.membersAdded ?? []) {
        if (m.id !== context.activity.recipient.id) {
          await context.sendActivity(
            "Hey — I'm TaskBrain. Send me anything: a voice memo from your phone, a half-formed idea, a task. " +
              "I'll transcribe it, figure out what it is, and file it. Ask me things like " +
              "\"what did I capture about the substation project?\" to recall. " +
              "In a team channel, @mention me."
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
  const pendingId = body.match(/\b(pa-[a-z0-9]+)\b/i)?.[1];
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
    ...(pendingId
      ? {
          actions: [
            {
              type: "Action.Submit",
              title: "Approve",
              data: { taskbrainApproval: "approve", pendingActionId: pendingId },
            },
            {
              type: "Action.Submit",
              title: "Deny",
              data: { taskbrainApproval: "deny", pendingActionId: pendingId },
            },
          ],
        }
      : {}),
  });
}
