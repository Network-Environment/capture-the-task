import { CardFactory, type Attachment } from "botbuilder";
import type { Outbound } from "../pipeline";

export function outboundCard(out: Pick<Outbound, "title" | "body" | "tags">): Attachment {
  const pendingId = out.body.match(/\b(pa-[a-z0-9]+)\b/i)?.[1];
  return CardFactory.adaptiveCard({
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: out.title, weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: out.body, wrap: true },
      ...(out.tags.length
        ? [
            {
              type: "TextBlock",
              text: out.tags.map((tag) => `#${tag}`).join("  "),
              isSubtle: true,
              wrap: true,
            },
          ]
        : []),
    ],
    ...(pendingId
      ? {
          actions: [
            {
              type: "Action.Submit",
              title: "Approve",
              data: {
                taskbrainApproval: "approve",
                pendingActionId: pendingId,
              },
            },
            {
              type: "Action.Submit",
              title: "Deny",
              data: {
                taskbrainApproval: "deny",
                pendingActionId: pendingId,
              },
            },
          ],
        }
      : {}),
  });
}
