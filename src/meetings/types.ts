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
  backfillCompletedAt?: string;
  lastError?: string;
  lastOkAt?: string;
}

export type TranscriptAvailabilityStatus =
  | "available"
  | "queued"
  | "processing"
  | "summarized"
  | "skipped_short"
  | "failed";

export interface TranscriptAvailabilityDoc {
  id: string;
  organizerId: string;
  organizerName?: string;
  transcriptId: string;
  meetingId: string;
  createdDateTime?: string;
  titleHint?: string;
  discoveredAt: string;
  updatedAt: string;
  status: TranscriptAvailabilityStatus;
  requestedBy?: string;
  requestedAt?: string;
  processingAt?: string;
  completedAt?: string;
  retryCount?: number;
  error?: string;
  meetingDocId?: string;
  _etag?: string;
}

export interface IngestHealthDoc {
  id: "latest";
  organizerId: "_system";
  lastRunAt: string;
  scanned: number;
  ingested: number;
  skipped: number;
  matched: number;
  discovered?: number;
  queued?: number;
  processed?: number;
  errors: string[];
}

export interface IngestResult {
  scanned: number;
  ingested: number;
  skipped: number;
  matched: number;
  discovered?: number;
  processed?: number;
  errors: string[];
}
