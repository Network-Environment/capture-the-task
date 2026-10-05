/**
 * Teams channel adapter (Bot Framework). Normalizes an activity, transcribes
 * voice on the gateway, and enqueues an agent request. The worker runs
 * processCapture; the gateway delivery pump renders the stored result as an
 * Adaptive Card. All capture logic lives in src/pipeline.ts.
 */
import { ActivityHandler, TurnContext, Attachment } from "botbuilder";
import { InvokeException } from "botbuilder-core";
import { StatusCodes } from "botframework-schema";
import { downloadAudio } from "./services/transcription";
import { saveConversationRef } from "./services/conversations";
import { acceptInboundMessage } from "./channels/acceptInbound";
import { channelEnvelope } from "./channels/types";
import { enqueueAgentRequest } from "./services/requestQueue";
import { transcribeBuffer } from "./services/transcription";
import {
  botWasMentioned,
  isPersonalTeamsConversation,
  pinTeamsThread,
  stripBotMention,
} from "./channels/teamsText";
import { handleWorkCardAction } from "./work/assign";
import { completeGraphSignIn, graphConnectionName } from "./services/graphTasks";

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
      const convRef = pinTeamsThread(
        TurnContext.getConversationReference(context.activity),
        context.activity
      );
      const bot = { id: context.activity.recipient?.id, name: context.activity.recipient?.name };
      const entities = context.activity.entities as { type?: string; text?: string; mentioned?: { id?: string; name?: string } }[] | undefined;

      // Channel / group chat: only handle @mentions so we never ingest the whole thread.
      if (!personal && !botWasMentioned(entities, bot.id, bot.name, context.activity.text)) {
        return next();
      }

      // Proactive jobs/alerts stay on the 1:1 chat, not the channel that @mentioned us.
      if (personal) void saveConversationRef(userId, convRef);

      const workSubmit = context.activity.value as
        | { taskbrainWork?: string; workId?: string; ownerPersonId?: string }
        | undefined;
      if (workSubmit?.taskbrainWork && workSubmit.workId) {
        const result = await handleWorkCardAction(
          workSubmit.taskbrainWork,
          workSubmit.workId,
          workSubmit.ownerPersonId,
          userId
        );
        await context.sendActivity(result);
        return next();
      }

      const submitted = context.activity.value as
        | { taskbrainApproval?: string; pendingActionId?: string }
        | undefined;
      const approvalText =
        submitted?.taskbrainApproval && submitted.pendingActionId
          ? `${submitted.taskbrainApproval} ${submitted.pendingActionId}`
          : undefined;
      let text = approvalText ?? stripBotMention(context.activity.text, entities, bot);

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

      await context.sendActivity({ type: "typing" });

      if (audio) {
        text = await transcribeBuffer(audio);
        if (!text) {
          await context.sendActivity("I couldn't make out that recording — mind trying again?");
          return next();
        }
      }

      const envelope = channelEnvelope("teams", {
        eventId: context.activity.id,
        conversationId: context.activity.conversation?.id,
        scope: personal ? "private" : "group",
        identity: context.activity.from.aadObjectId ? "canonical" : "weak",
        allowActions: true,
      });
      await acceptInboundMessage({
        userId,
        channel: "teams",
        text: text!,
        eventId: envelope.eventId,
        conversationId: envelope.conversationId,
        displayNameHint: context.activity.from.name,
        scope: personal ? "private" : "group",
        conversationRef: { channel: "teams", teamsRef: convRef },
        send: (body) => context.sendActivity(body),
        enqueue: async () =>
          (
            await enqueueAgentRequest({
              userId,
              channel: "teams",
              text: text!,
              eventId: envelope.eventId,
              conversationId: envelope.conversationId,
              policy: envelope.policy,
              conversationRef: { channel: "teams", teamsRef: convRef },
            })
          ).disposition,
      });
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      if (!isPersonalTeamsConversation(context.activity.conversation?.conversationType)) {
        return next();
      }
      for (const m of context.activity.membersAdded ?? []) {
        if (m.id !== context.activity.recipient.id) {
          await context.sendActivity(
            "Hey — I'm TaskBrain. Send a voice memo, a task, or a question. Ask “what can you do?” and I’ll walk what I can do, and what is still limited. " +
              "When you need Microsoft 365, I’ll send a sign-in card in this chat. One sign-in covers Teams and iMessage. " +
              "In a team channel, @mention me. Group chats can look things up, but they don’t save or assign work."
          );
        }
      }
      await next();
    });

    this.onTokenResponseEvent(async (context, next) => {
      const token = await completeGraphSignIn(context);
      if (token) {
        await context.sendActivity(
          "Signed in. Ask again and I’ll use your calendar, mail, files, and To Do."
        );
      }
      await next();
    });
  }

  protected async onSignInInvoke(context: TurnContext): Promise<void> {
    const token = await completeGraphSignIn(context);
    if (!token) {
      const value = (context.activity.value ?? {}) as { id?: string };
      throw new InvokeException(StatusCodes.PRECONDITION_FAILED, {
        id: value.id,
        connectionName: graphConnectionName(),
        failureDetail: "The bot is unable to exchange token.",
      });
    }
    await context.sendActivity(
      "Signed in. Ask again and I’ll use your calendar, mail, files, and To Do."
    );
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

