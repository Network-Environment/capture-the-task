/** Meeting and commitment retrieval is org-wide but viewer-gated. */
export const MEETING_VIEWERS = new Set(
  (process.env.MEETING_VIEWERS ??
    "bceb24c5-ef85-4301-9ab2-073805d535aa,4f323599-0df8-47f7-aa01-46dbb211894c")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export const ORG_LESSON_USER = "org";

export function canViewMeetings(userId: string): boolean {
  return MEETING_VIEWERS.has(userId.toLowerCase());
}

export function denyMeetings(): string {
  return "Meeting intelligence is limited to designated org operators.";
}
