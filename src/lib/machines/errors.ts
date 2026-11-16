/**
 * The one error type of the machine plane.
 *
 * Contract: a request that could not be authorized, validated or dispatched
 * throws `MachineOperationError`; a request that ran on the target and did not
 * succeed (non-zero exit, timeout on the box, refused by the agent) RETURNS
 * `MachineResult` with `ok: false`. `code: "uncertain"` means the request may
 * have taken effect and nothing here can prove otherwise: callers mark the
 * operation `uncertain` and never re-dispatch it automatically.
 *
 * Messages never carry argument values, credentials or command output; they
 * name the field and the rule.
 */
import type { MachineErrorCode, MachineResult } from "./types";

export interface MachineErrorDetail {
  retryable?: boolean;
  /** SSM command id / zenithd request id, when the request was already dispatched */
  transportRef?: string;
  /** field-level problems for `invalid_args`, `path: rule` */
  issues?: string[];
  /** the completed result, when the failure came after execution (`evidence_failed`) */
  result?: MachineResult;
  cause?: unknown;
}

export class MachineOperationError extends Error {
  readonly code: MachineErrorCode;
  readonly detail: MachineErrorDetail;

  constructor(code: MachineErrorCode, message: string, detail: MachineErrorDetail = {}) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = "MachineOperationError";
    this.code = code;
    this.detail = detail;
  }

  get retryable(): boolean {
    return this.detail.retryable === true;
  }
  get transportRef(): string | undefined {
    return this.detail.transportRef;
  }
}

export const isMachineOperationError = (e: unknown): e is MachineOperationError => e instanceof MachineOperationError;
