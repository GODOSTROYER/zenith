export type WaitlistStatus = "queued" | "admitted";

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string;
  features: string[];
  occupation: string;
  useCase: string;
  /** Immutable FIFO sequence; gaps are harmless. */
  position: number;
  status: WaitlistStatus;
  createdAt: string;
  admittedAt: string | null;
  admittedBy: string | null;
}

export interface WaitlistPage {
  entries: WaitlistEntry[];
  total: number;
  queued: number;
  admitted: number;
  /** Total matching the status and search filters, before applying the cursor. */
  matched?: number;
  nextCursor: number | null;
}

export interface WaitlistSubmission {
  email: string;
  name?: string;
  occupation?: string;
  features?: string[];
  useCase?: string;
}

export type WaitlistAdmissionSelection =
  | { mode: "selected"; entryIds: string[] }
  | { mode: "next"; count: number }
  | { mode: "all" };

export interface WaitlistAdmissionPreview {
  id: string;
  mode: WaitlistAdmissionSelection["mode"];
  /** Exact number of queued people captured by this immutable preview. */
  count: number;
  /** First 100 captured people in queue order. */
  entries: WaitlistEntry[];
  createdAt: string;
  expiresAt: string;
}

export interface WaitlistAdmissionBatch {
  requestId: string;
  actorId: string;
  requestedCount: number;
  admittedCount: number;
  createdAt: string;
  mode: WaitlistAdmissionSelection["mode"];
}

export interface WaitlistAdmissionResult {
  count: number;
  requestId: string;
}

export interface WaitlistAdmissionHistoryDetail {
  batch: WaitlistAdmissionBatch;
  entries: WaitlistEntry[];
  nextOffset: number | null;
}

export interface WaitlistAdmissionHistory {
  batches: WaitlistAdmissionBatch[];
}

export interface WaitlistRepository {
  /** Duplicate addresses preserve the original answers, queue position and grant. */
  join(input: WaitlistSubmission): Promise<void>;
  list(options: { status?: WaitlistStatus; after?: number; limit: number; q?: string }): Promise<WaitlistPage>;
  /** One atomic FIFO operation. The request ID makes a network retry safe. */
  admit(count: number, actorId: string, requestId: string): Promise<WaitlistEntry[]>;
  /** Captures queued IDs now, including a complete snapshot for approve-all. */
  preview(selection: WaitlistAdmissionSelection, actorId: string): Promise<WaitlistAdmissionPreview>;
  /** Applies the saved selection once; retries must keep the same request ID. */
  admitPreview(previewId: string, actorId: string, requestId: string): Promise<WaitlistAdmissionResult>;
  history(options: { limit: number }): Promise<WaitlistAdmissionHistory>;
  historyDetail(requestId: string, options?: { offset?: number; limit?: number }): Promise<WaitlistAdmissionHistoryDetail>;
  admitted(email: string): Promise<boolean>;
  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}
