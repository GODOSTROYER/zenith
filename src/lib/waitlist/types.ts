export type WaitlistStatus = "queued" | "admitted";

export interface WaitlistEntry {
  id: string;
  email: string;
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
  nextCursor: number | null;
}

export interface WaitlistSubmission {
  email: string;
  occupation: string;
  useCase: string;
}

export interface WaitlistRepository {
  /** Duplicate addresses preserve the original answers, queue position and grant. */
  join(input: WaitlistSubmission): Promise<void>;
  list(options: { status?: WaitlistStatus; after?: number; limit: number }): Promise<WaitlistPage>;
  /** One atomic FIFO operation. The request ID makes a network retry safe. */
  admit(count: number, actorId: string, requestId: string): Promise<WaitlistEntry[]>;
  admitted(email: string): Promise<boolean>;
  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}