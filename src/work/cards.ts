import type { WorkAssignment } from "./types";

export function workAdaptiveCard(work: WorkAssignment, notice?: string) {
  const due = work.due ? `Due ${work.due.slice(0, 10)}` : "No due date";
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: "Work assigned", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: work.title, wrap: true, weight: "Bolder" },
      ...(work.detail
        ? [{ type: "TextBlock", text: work.detail.slice(0, 800), wrap: true, isSubtle: true }]
        : []),
      { type: "TextBlock", text: due, isSubtle: true },
      ...(notice ? [{ type: "TextBlock", text: notice, wrap: true, color: "Attention" }] : []),
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Accept",
        data: { taskbrainWork: "accept", workId: work.id, ownerPersonId: work.ownerPersonId },
      },
      {
        type: "Action.Submit",
        title: "Done",
        data: { taskbrainWork: "done", workId: work.id, ownerPersonId: work.ownerPersonId },
      },
      {
        type: "Action.Submit",
        title: "Snooze 1 day",
        data: { taskbrainWork: "snooze", workId: work.id, ownerPersonId: work.ownerPersonId },
      },
    ],
  };
}

export function workCardAttachment(work: WorkAssignment, notice?: string) {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: workAdaptiveCard(work, notice),
  };
}
