# TaskBrain

**Purpose.** TaskBrain is Net Env’s capture-and-follow-through assistant. You talk to it in Teams (text or voice) or iMessage. It files what you want remembered, answers from live systems instead of guessing, and executes only what you explicitly asked for.

It is not a general chatbot, a transcript archive, or a replacement for Outlook, Teams, or Smartsheet. It is a second brain plus an operator that can look things up and act with your authorization.

---

## How to talk to it

Send a complete thought. It infers the outcome and chooses tools; you do not need magic phrases.

| You want… | Say something like… |
|---|---|
| Remember it | “Capture: follow up with Morgan on commissioning Friday.” |
| A personal task | “Add a task to call Pat tomorrow.” |
| An answer | “When did I last meet with Joe?” / “Who owns the open commissioning risk?” |
| Work assigned | “Assign Val the generator warranty review due Thursday.” |
| Recurring help | “Every Friday at 4 PM send me a digest of open risks.” |

Voice memos are transcribed. Replies stay short. High-impact writes come back as a preview you approve (`approve pa-x`).

---

## What it can do

**Personal capture.** Tasks, ideas, and references go into your private second brain (searchable notes). Teams-connected tasks also land in Microsoft To Do. Recent captures in the same chat can be undone.

**Your calendar (Outlook).** Searches *your* calendar only — whether and when you met someone, subjects, attendees. It never opens another person’s mailbox.

**Meeting memory.** For designated meeting viewers, it can search stored Teams/Plaud **summaries** (about 90 days): decisions, discussion, and who committed to what. Summaries are not a complete calendar; use Outlook for “when,” summaries for “what happened.”

**Org directory.** People, teams, reporting, mandates, and how someone prefers to receive work (Teams, To Do, Planner). Ambiguous first names get one clarifying question.

**Work follow-through.** Create, nudge, or complete assignments for named people. Destinations come from the org record, not a guess. Open meeting commitments can be listed and marked done.

**Shared projects.** The execution graph is the source of truth for project/task status, owners, blockers, and dependencies. Inferred relationships are proposed for team review, not silently written.

**PMO / Smartsheet.** Search sheets, read status and risks, propose row changes. Writes park until you approve. It will not invent sheet IDs.

**Memory.** Dated facts from captures and meetings; personal opinions stay personal. It will not write org-wide judgments about people.

**Scheduling.** Recurring or one-shot jobs (digests, lookups) delivered back to the same conversation. Timezone is US Central.

**Public web.** Search the public web, or open a named public URL for a page snapshot. Not used for private org, calendar, meeting, or sheet data.

---

## Guardrails (by design)

- **Reads vs writes.** Looking something up is allowed. Saving, assigning, scheduling, or changing shared systems requires a clear request. Shared, destructive, or scheduled changes need a preview and approval.
- **No fabrication.** If a source is empty, gated, or unsigned-in, it says so.
- **Scope.** Your notes are yours. Meeting intelligence is viewer-gated. Calendar is requester-only.
- **Identity.** Quoted or hypothetical instructions are not authorization to act.
- **Concurrency.** Messages are queued internally; you just get a working acknowledgement, then the answer.

---

## Channels and identity

Use it from **Teams** (full Graph: To Do + your calendar after you consent) or **iMessage** if your number is mapped. Group chats do not get personal writes. First calendar use may prompt a one-time Microsoft sign-in for `Calendars.ReadBasic`.
