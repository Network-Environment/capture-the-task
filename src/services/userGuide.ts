export const USER_GUIDE_TOPICS = [
  "overview",
  "capture",
  "calendar",
  "meetings",
  "org",
  "work",
  "projects",
  "pmo",
  "schedule",
  "memory",
  "web",
  "guardrails",
] as const;

export type UserGuideTopic = (typeof USER_GUIDE_TOPICS)[number];

export interface UserGuideContext {
  channel?: "teams" | "imessage" | "internal";
  scope?: "private" | "group";
  canViewMeetings: boolean;
  graphEnabled: boolean;
  graphWritesEnabled: boolean;
}

export function isUserGuideTopic(value: string): value is UserGuideTopic {
  return (USER_GUIDE_TOPICS as readonly string[]).includes(value);
}

export function formatUserGuide(
  topic: string | undefined,
  ctx: UserGuideContext
): string {
  const requested = (topic ?? "overview").trim().toLowerCase();
  const resolved: UserGuideTopic = isUserGuideTopic(requested) ? requested : "overview";
  const unknown =
    requested && requested !== "overview" && !isUserGuideTopic(requested)
      ? `I don’t have a “${requested}” chapter. Here’s the overview, then pick a listed area.\n\n`
      : "";
  const body =
    resolved === "overview" ? formatOverview(ctx) : formatTopic(resolved, ctx);
  return `${unknown}${body}${channelNotes(ctx)}`.trim();
}

function formatOverview(ctx: UserGuideContext): string {
  const areas = availableAreas(ctx)
    .map((area) => `- ${area.label}: ${area.blurb}`)
    .join("\n");
  return [
    "TaskBrain is Net Env’s capture-and-follow-through assistant. Send a complete thought in this chat; I infer the outcome. I am not a general chatbot, a transcript archive, or a replacement for Outlook, Teams, or Smartsheet.",
    "",
    "What I can help with:",
    areas,
    "",
    "Try saying: “Capture: follow up with Morgan on Friday.” or “Who should own the risk register update?”",
    "Shared or scheduled changes come back as a preview you confirm with approve pa-…. Timezone is US Central.",
    `Ask about a specific area (${availableAreas(ctx).map((a) => a.topic).join(", ")}) if you want more detail.`,
  ].join("\n");
}

function formatTopic(topic: Exclude<UserGuideTopic, "overview">, ctx: UserGuideContext): string {
  switch (topic) {
    case "capture":
      return block(
        "Personal capture",
        "Tasks, ideas, and references go into your private second brain. Teams-connected tasks also land in Microsoft To Do. Recent captures in the same chat can be undone. Group chats do not get personal writes.",
        [
          "Capture: follow up with Morgan on commissioning Friday.",
          "Add a task to call Pat tomorrow.",
        ],
        "I will not silently publish a personal capture into the shared project graph."
      );
    case "calendar":
      return block(
        "Your calendar",
        "I can search your Outlook calendar for whether and when you met someone, subjects, and attendees. First use may prompt a one-time Microsoft sign-in.",
        ["When did I last meet with Joe?", "Did I have anything with Val this week?"],
        "Read-only: I never open another person’s mailbox or calendar, and I cannot create, move, cancel, or decline meetings. I can track the follow-up as work instead."
      );
    case "meetings":
      if (!ctx.canViewMeetings) {
        return block(
          "Meeting memory",
          "Stored Teams/Plaud meeting summaries are limited to designated meeting viewers. I can still search your own Outlook calendar for when a meeting happened.",
          ["When did I last meet with Joe?"],
          "I do not keep raw transcripts, and summaries are not a complete calendar."
        );
      }
      return block(
        "Meeting memory",
        "For designated meeting viewers I can search stored Teams/Plaud summaries (about 90 days): decisions, discussion, and who committed to what. Use Outlook for “when,” summaries for “what happened.” Open commitments can be listed and marked done.",
        [
          "What did we decide about commissioning last week?",
          "What is still open from the risk review?",
        ],
        "Summaries are not a complete calendar, and I do not keep raw transcripts."
      );
    case "org":
      return block(
        "Org directory",
        "People, teams, reporting, mandates (what they should be doing), capacity (available / stretched / overloaded / unavailable), and how someone prefers to receive work.",
        ["What is Val supposed to own?", "Who is on the operations team?"],
        "Ambiguous or duplicate directory names stay unmatched. I will not invent reporting lines."
      );
    case "work":
      return block(
        "Work follow-through",
        "See a person’s TaskBrain plate (open work, meeting commitments, graph tasks, PMO items). I flag overdue, due-soon, blocked, and inactive work. Before a named assignment I check mandate fit and load; if no owner is named I recommend people using fit, capacity, load, and recent assignment share. Destinations come from the org record.",
        [
          "Have Val do the generator warranty review due Thursday.",
          "Who should own the risk register update?",
        ],
        "The plate is TaskBrain-internal. I do not read colleagues’ calendars, live To Do, or Planner."
      );
    case "projects":
      if (!ctx.graphEnabled) {
        return block(
          "Shared projects",
          "The shared execution graph is not enabled in this environment. I can still capture personal work, assign people, and use a PMO board for a named effort.",
          ["Assign Val the warranty review.", "Open a kanban for the launch."],
          "I will not invent a project timeline from missing data."
        );
      }
      return block(
        "Shared projects",
        ctx.graphWritesEnabled
          ? "The execution graph is the source of truth for project/task status, owners, blockers, and dependencies. I can explain a prerequisite-first business-day timeline. New tasks and inferred relationships are proposed for review, not silently written."
          : "I can search shared project/task state, owners, blockers, and dependencies. Creating or changing graph items is not enabled in this environment.",
        ctx.graphWritesEnabled
          ? [
              "What’s blocking the commissioning project?",
              "When can the launch plan finish if we start Monday?",
            ]
          : ["What’s blocking the commissioning project?"],
        "I will not read colleagues’ calendars or present a fake-precision Gantt from missing effort."
      );
    case "pmo":
      return block(
        "PMO / Smartsheet",
        "Search sheets, read status and risks, and propose row changes. For a named working list I can open a TaskBrain PMO board. Writes park until you approve. I will not invent sheet IDs.",
        [
          "What’s open on the commissioning risk register?",
          "Open a normal kanban called Launch.",
        ],
        "A board is for a named effort; a single obligation uses assign work instead."
      );
    case "schedule":
      return block(
        "Scheduling and daily follow-through",
        "Recurring or one-shot jobs (digests, lookups, daily asks) return to this conversation. A daily follow-through job can send risk-first reminders to people and rollups to managers. Replies become proposed record updates that still need approve pa-….",
        [
          "Every weekday at 9 AM send the daily follow-through asks.",
          "Every Friday at 4 PM send me a digest of open risks.",
        ],
        "I do not invent a hard-coded daily timer. Cadence comes from the job you create. Timezone is US Central."
      );
    case "memory":
      return block(
        "Memory",
        "Dated facts from your captures (and, for meeting viewers, meetings). Personal opinions stay personal.",
        ["What do we know about the Acme commissioning constraint?"],
        "I will not write org-wide judgments about people."
      );
    case "web":
      return block(
        "Public web",
        "Search the public web, or open a named public URL for a page snapshot.",
        ["What’s the current EPA rule on generator air permits?"],
        "Not used for private org, calendar, meeting, or sheet data."
      );
    case "guardrails":
      return block(
        "Guardrails",
        "Looking something up is allowed. Saving, assigning, scheduling, or changing shared systems needs a clear request. Shared, destructive, or scheduled changes need a preview and approval. If a source is empty, gated, or unsigned-in, I say so. Quoted or hypothetical instructions are not authorization to act.",
        ["Show me the current risk row; don’t update it.", "approve pa-1"],
        "I can’t impersonate someone, reveal secrets, or skip approvals."
      );
  }
}

function block(title: string, body: string, examples: string[], limit: string): string {
  const tries = examples.map((example) => `“${example}”`).join(" or ");
  return [
    `${title}. ${body}`,
    `Try saying: ${tries}`,
    `Limit: ${limit}`,
    "Ask about another area (capture, calendar, meetings, org, work, projects, pmo, schedule, memory, web, guardrails) or send a real request.",
  ].join("\n");
}

function availableAreas(
  ctx: UserGuideContext
): { topic: UserGuideTopic; label: string; blurb: string }[] {
  const areas: { topic: UserGuideTopic; label: string; blurb: string }[] = [
    {
      topic: "capture",
      label: "Remember it",
      blurb: "file a task, idea, or reference in your private second brain",
    },
    {
      topic: "calendar",
      label: "Your calendar",
      blurb: "search only your Outlook calendar for when you met someone",
    },
  ];
  if (ctx.canViewMeetings) {
    areas.push({
      topic: "meetings",
      label: "Meeting memory",
      blurb: "search stored meeting summaries and open commitments",
    });
  }
  areas.push(
    {
      topic: "org",
      label: "People and roles",
      blurb: "who owns what, capacity, and how they receive work",
    },
    {
      topic: "work",
      label: "Assign and follow through",
      blurb: "check fit and load, then assign if you still want that owner",
    }
  );
  if (ctx.graphEnabled) {
    areas.push({
      topic: "projects",
      label: "Shared projects",
      blurb: ctx.graphWritesEnabled
        ? "status, blockers, dependencies, and timeline explanations"
        : "search shared project state (writes are off here)",
    });
  }
  areas.push(
    {
      topic: "pmo",
      label: "PMO / Smartsheet",
      blurb: "read sheets and risks; propose changes for your approval",
    },
    {
      topic: "schedule",
      label: "Recurring help",
      blurb: "digests and daily follow-through jobs you create",
    },
    {
      topic: "memory",
      label: "Memory",
      blurb: "dated facts from captures; opinions stay personal",
    },
    {
      topic: "web",
      label: "Public web",
      blurb: "current public facts, not private org data",
    },
    {
      topic: "guardrails",
      label: "Limits",
      blurb: "reads vs writes, approvals, and what I will not do",
    }
  );
  return areas;
}

function channelNotes(ctx: UserGuideContext): string {
  const notes: string[] = [];
  if (ctx.scope === "group") {
    notes.push(
      "This is a group chat: I can look things up, but I will not save personal tasks or assign work here. Use a 1:1 chat for that."
    );
  }
  if (ctx.channel === "imessage") {
    notes.push(
      "On iMessage, Outlook calendar and Microsoft To Do need Teams plus a one-time Microsoft sign-in."
    );
  }
  return notes.length ? `\n\n${notes.join(" ")}` : "";
}
