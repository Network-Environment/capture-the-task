/** Meeting and commitment retrieval is org-wide but viewer-gated. */
import type { OrgDirectory } from "../org/types";

export const MEETING_VIEWER_ROLE = "Meeting viewer";

export const MEETING_VIEWERS = new Set(
  (process.env.MEETING_VIEWERS ??
    "bceb24c5-ef85-4301-9ab2-073805d535aa,4f323599-0df8-47f7-aa01-46dbb211894c")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export const ORG_LESSON_USER = "org";

const orgViewerIds = new Set<string>();

export function syncMeetingViewersFromDirectory(
  dir: Pick<OrgDirectory, "people" | "roles">
): string[] {
  orgViewerIds.clear();
  const holders = new Set(
    dir.roles
      .filter((r) => r.status === "active" && isMeetingViewerRole(r.title))
      .map((r) => r.personId)
  );
  for (const person of dir.people) {
    if (person.status !== "active" || !person.entraId) continue;
    if (holders.has(person.id) || isMeetingViewerRole(person.title ?? "")) {
      orgViewerIds.add(person.entraId.toLowerCase());
    }
  }
  return [...orgViewerIds];
}

export function isMeetingViewerRole(title: string): boolean {
  return title.trim().toLowerCase() === MEETING_VIEWER_ROLE.toLowerCase();
}

export function canViewMeetings(userId: string): boolean {
  const id = userId.toLowerCase();
  return MEETING_VIEWERS.has(id) || orgViewerIds.has(id);
}

export function denyMeetings(): string {
  return "Meeting intelligence is limited to designated org operators.";
}
