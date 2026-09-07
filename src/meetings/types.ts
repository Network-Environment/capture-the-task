export interface MeetingAction {
  text: string;
  ownerName: string;
  ownerId?: string;
  due?: string;
}

export interface MeetingSummary {
  title: string;
  categories: string[];
  summary: string;
  decisions: string[];
  actions: MeetingAction[];
  risks: string[];
  openQuestions: string[];
  attendees: string[];
}

export interface MeetingDoc {
  id: string;
  organizerId: string;
  organizerName?: string;
  transcriptId: string;
  meetingId?: string;
  startAt?: string;
  title: string;
  categories: string[];
  summary: string;
  decisions: string[];
  actions: MeetingAction[];
  risks: string[];
  openQuestions: string[];
  attendees: string[];
  path: string;
  createdAt: string;
  ttl?: number;
  embedding: number[];
}

export type CommitmentStatus = "open" | "done" | "stale" | "contradicted";

export interface CommitmentDoc {
  id: string;
  ownerKey: string;
  ownerName: string;
  ownerId?: string;
  text: string;
  due?: string;
  status: CommitmentStatus;
  sourceMeetingId: string;
  sourceTitle: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

export interface CheckpointDoc {
  id: string;
  organizerId: string;
  deltaLink?: string;
  lastError?: string;
  lastOkAt?: string;
}

export interface IngestHealthDoc {
  id: "latest";
  organizerId: "_system";
  lastRunAt: string;
  scanned: number;
  ingested: number;
  skipped: number;
  matched: number;
  errors: string[];
}

export interface IngestResult {
  scanned: number;
  ingested: number;
  skipped: number;
  matched: number;
  errors: string[];
}
