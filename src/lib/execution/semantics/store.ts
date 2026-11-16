/**
 * Durable binding of the executable semantics a human was shown (PROD-DUR-03).
 *
 * One row per (workspace, operation, plan digest), written by the trusted planning worker at the
 * moment the reviewed plan is published, and never changed afterwards (SQL trigger). The approval
 * flow compares the digest the approver reviewed with this row; every dispatch point recomputes the
 * semantics and compares with this row. The row, not a workflow argument, is the authority.
 */
import { readExecutableSemantics, type ExecutableSemantics } from "./digest";

const clone = <T>(value: T): T => structuredClone(value);

export interface ApprovedSemanticsRecord {
  workspaceId: string;
  operationId: string;
  planDigest: string;
  semantics: ExecutableSemantics;
  createdAt: string;
}

export interface RecordSemanticsInput {
  workspaceId: string;
  operationId: string;
  planDigest: string;
  semantics: ExecutableSemantics;
}

export class SemanticsStoreError extends Error {
  constructor(readonly code: "conflict" | "invalid_input", message: string) {
    super(message);
    this.name = "SemanticsStoreError";
  }
}

export interface SemanticsStore {
  /**
   * Write-once. The same digest again returns the existing row; a different digest for the same
   * (workspace, operation, plan) rejects with `conflict`: the reviewed semantics never move.
   */
  record(input: RecordSemanticsInput): Promise<ApprovedSemanticsRecord>;
  get(workspaceId: string, operationId: string, planDigest: string): Promise<ApprovedSemanticsRecord | null>;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function validateRecordInput(input: RecordSemanticsInput): void {
  if (!input.workspaceId || !input.operationId) throw new SemanticsStoreError("invalid_input", "workspaceId and operationId are required.");
  if (!HEX64.test(input.planDigest)) throw new SemanticsStoreError("invalid_input", "planDigest must be a SHA-256 hex digest.");
  if (!readExecutableSemantics(input.semantics)) throw new SemanticsStoreError("invalid_input", "The semantics document is malformed or its digest does not match its components.");
}

/** In-process store for tests and the in-memory development composition. */
export class MemorySemanticsStore implements SemanticsStore {
  private readonly rows = new Map<string, ApprovedSemanticsRecord>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(input: RecordSemanticsInput): Promise<ApprovedSemanticsRecord> {
    validateRecordInput(input);
    const key = `${input.workspaceId}\u0000${input.operationId}\u0000${input.planDigest}`;
    const existing = this.rows.get(key);
    if (existing) {
      if (existing.semantics.digest !== input.semantics.digest) throw new SemanticsStoreError("conflict", "The reviewed executable semantics of this plan are write-once and differ from what is recorded.");
      return clone(existing);
    }
    const row: ApprovedSemanticsRecord = { workspaceId: input.workspaceId, operationId: input.operationId, planDigest: input.planDigest, semantics: clone(input.semantics), createdAt: this.now().toISOString() };
    this.rows.set(key, row);
    return clone(row);
  }

  async get(workspaceId: string, operationId: string, planDigest: string): Promise<ApprovedSemanticsRecord | null> {
    const row = this.rows.get(`${workspaceId}\u0000${operationId}\u0000${planDigest}`);
    return row ? clone(row) : null;
  }
}
