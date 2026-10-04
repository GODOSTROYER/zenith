/**
 * `executeMachineOperation`: the single entry point for running a semantic
 * operation on a machine or workload (spec §18, ADR-0012).
 *
 * Order of work, each step able to refuse:
 *   1. envelope      — shape, id alphabets, `timeoutSec ≤ 300`, `maxOutputBytes ≤ 1 MiB`
 *   2. grant         — defence in depth: the CALLER (capability broker) has already
 *                      verified the grant's signature and issued it for this
 *                      operation; here we assert it really is for this capability,
 *                      operation id, workspace, environment and resource, and is
 *                      not expired. A mismatch is refused, never "fixed".
 *   3. constraints   — policy "restrict" constraints carried in the grant
 *                      (`maxTimeoutSec`, `maxOutputBytes` lower the request's
 *                      budgets; `maxLines`, `pathPrefixes` refuse)
 *   4. transport     — a driver exists for the target's transport and supports
 *                      the operation (its `unsupported` note explains why not)
 *   5. arguments     — strict per-operation schema; the PARSED arguments are what run
 *   6. execute       — inside `sessions.withSession` (credentials live only there)
 *   7. post-process  — limits re-enforced, credential patterns redacted
 *   8. evidence      — one `machine_request` record per request, refused ones included
 *
 * Grant SIGNATURE verification, single-use consumption and policy evaluation
 * are the broker's job and are deliberately not repeated here.
 *
 * Errors: a request that cannot run throws `MachineOperationError`; a request
 * that ran and definitively failed returns `ok: false`. An unknown write
 * outcome throws uncertainty after retaining its bounded receipt.
 */
import { capability, isCapability } from "@/lib/capabilities/catalog";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { z } from "zod";
import { isImplementedOperation, MachineRequestSchema, parseMachineArgs, describeIssues } from "./args";
import { evidenceForRejection, evidenceForResult } from "./evidence";
import { MachineOperationError, isMachineOperationError } from "./errors";
import { isDeniedFilePath, isCanonicalWritePath, writePathAllowed, pathAllowed } from "./guards";
import { FileWriteFailureDataSchema, MachineResultDataSchemas } from "./results";
import { MAX_OUTPUT_BYTES, MAX_TIMEOUT_SEC } from "./limits";
import { redactDeep, truncateUtf8 } from "./redact";
import type { MachineDriver, MachineDrivers, MachineEvidenceSink, MachineOperation, MachineRequest, MachineResult, MachineSessionProvider } from "./types";

export interface MachineExecutionContext {
  /** verified by the caller; asserted here, never trusted blindly */
  grant: CapabilityGrantClaims;
  drivers: MachineDrivers;
  sessions: MachineSessionProvider;
  evidence: MachineEvidenceSink;
  signal: AbortSignal;
  now?: () => Date;
}

/** The semantic operation names ARE the capability names (catalog.ts). */
export function capabilityForOperation(op: MachineOperation): string {
  if (!isCapability(op)) throw new Error(`Machine operation ${op} has no capability in the catalog.`);
  return op;
}

/** Constraints this executor understands; unknown keys belong to other executors and are ignored. */
const ConstraintsSchema = z
  .object({
    maxTimeoutSec: z.number().int().min(1).optional(),
    maxOutputBytes: z.number().int().min(1).optional(),
    maxLines: z.number().int().min(1).optional(),
    pathPrefixes: z.array(z.string().min(1).max(1024)).max(64).optional(),
  })
  .passthrough();

function assertGrant(req: MachineRequest, grant: CapabilityGrantClaims, nowMs: number): void {
  const mismatch = (why: string) => new MachineOperationError("grant_mismatch", `the capability grant does not authorize this request: ${why}`);
  if (grant.exp * 1000 <= nowMs) throw new MachineOperationError("grant_expired", "the capability grant has expired");
  if (grant.cap !== capabilityForOperation(req.operation)) throw mismatch(`grant is for capability ${grant.cap}, request is ${req.operation}`);
  if (grant.op !== req.operationId) throw mismatch("grant is bound to a different operation");
  if (grant.ws !== req.target.workspaceId) throw mismatch("grant is for a different workspace");
  if (grant.env !== undefined && grant.env !== req.target.environmentId) throw mismatch("grant is for a different environment");
  if (grant.res !== undefined && grant.res !== req.target.resourceId) throw mismatch("grant is for a different resource");
  if (capability(req.operation).scopeLevel === "resource" && grant.res === undefined) throw mismatch("grant is not scoped to a resource");
}

function parseConstraints(grant: CapabilityGrantClaims, op: MachineOperation): z.infer<typeof ConstraintsSchema> {
  if (op === "file.write" || op === "file.upload") {
    const c = grant.constraints ?? {};
    if (Object.keys(c).some((k) => !["maxTimeoutSec", "maxOutputBytes", "pathPrefixes"].includes(k)) ||
      (Array.isArray(c.pathPrefixes) && c.pathPrefixes.some((p) => typeof p !== "string" || !isCanonicalWritePath(p))) ||
      [c.maxTimeoutSec, c.maxOutputBytes].some((n) => typeof n === "number" && n > 1073741824)) {
      throw new MachineOperationError("grant_mismatch", "the write grant carries constraints this executor cannot enforce");
    }
  }
  const parsed = ConstraintsSchema.safeParse(grant.constraints ?? {});
  if (!parsed.success) throw new MachineOperationError("grant_mismatch", "the capability grant carries constraints this executor cannot interpret", { issues: describeIssues(parsed.error) });
  return parsed.data;
}

function enforceConstraints(op: MachineOperation, args: Record<string, unknown>, c: z.infer<typeof ConstraintsSchema>): void {
  if (c.maxLines !== undefined && typeof args.lines === "number" && args.lines > c.maxLines) {
    throw new MachineOperationError("limit_exceeded", `lines exceeds the grant's maxLines constraint (${c.maxLines})`);
  }
  if ((op === "file.write" || op === "file.upload") && c.pathPrefixes && !writePathAllowed(String(args.path), c.pathPrefixes)) {
    throw new MachineOperationError("denied", "write path is outside signed scope");
  }
  if (op === "file.read" && c.pathPrefixes) {
    const path = String(args.path);
    if (!pathAllowed(path, c.pathPrefixes) || isDeniedFilePath(path)) {
      throw new MachineOperationError("denied", "path is outside the grant's pathPrefixes constraint");
    }
  }
}

/** Fields that hold raw remote text, redacted and byte-capped on the way out. */
const CONTENT_FIELD = "content";
const REDACTABLE_OPS: ReadonlySet<MachineOperation> = new Set(["file.read", "container.logs", "system.logs"]);

function postProcess(req: MachineRequest, driver: MachineDriver, result: MachineResult): MachineResult {
  if (result.operation !== req.operation) throw new MachineOperationError("protocol_violation", "the driver returned a result for a different operation");
  if (result.transport !== driver.transport) throw new MachineOperationError("protocol_violation", "the driver returned a result for a different transport");

  if (req.operation === "file.write" || req.operation === "file.upload") {
    const parsed = (result.ok ? MachineResultDataSchemas[req.operation] : FileWriteFailureDataSchema).safeParse(result.data);
    if (!parsed.success) throw new MachineOperationError("uncertain", "the write result could not establish an outcome", { transportRef: result.transportRef });
    const data = parsed.data as Record<string, unknown>;
    if (!result.ok && data.effect !== "none" && data.effect !== "unknown") throw new MachineOperationError("uncertain", "the write failure omitted its effect receipt", { transportRef: result.transportRef });
    const versionKey = req.operation === "file.upload" ? "sourceVersion" : "contentVersion";
    if (result.ok && (data.path !== req.args.path || data[versionKey] !== req.args[versionKey])) throw new MachineOperationError("uncertain", "the write receipt does not bind the approved destination/version", { transportRef: result.transportRef });
    if (req.operation === "file.upload" && result.ok && data.created !== (req.args.expectedSha256 === null)) throw new MachineOperationError("uncertain", "the upload receipt contradicts its approved create or replace precondition", { transportRef: result.transportRef });
    const { output: _output, ...safe } = result;
    return { ...safe, data };
  }
  const max = req.maxOutputBytes;
  const state = { changed: false };
  // Redact complete strings first: truncating a credential can defeat its pattern,
  // and replacement markers can be longer than the original secret.
  let data = redactDeep(result.data, state);
  const content = data[CONTENT_FIELD];
  if (typeof content === "string") {
    const cut = truncateUtf8(content, max);
    if (cut.truncated) data = { ...data, [CONTENT_FIELD]: cut.text, truncated: true };
  }

  let output = result.output;
  if (output) {
    const exceeded = Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > max;
    output = redactDeep(output, state);
    const out = truncateUtf8(output.stdout, max);
    const err = truncateUtf8(output.stderr, Math.max(0, max - Buffer.byteLength(out.text)));
    output = { ...output, stdout: out.text, stderr: err.text, truncated: output.truncated || exceeded || out.truncated || err.truncated };
  }
  if (state.changed && REDACTABLE_OPS.has(req.operation)) data = { ...data, redacted: true };
  if (typeof content !== "string" && Buffer.byteLength(JSON.stringify(data)) > max) {
    return { ...result, ok: false, data: { error: "output_limit" }, ...(output ? { output } : {}) };
  }
  return { ...result, data, ...(output ? { output } : {}) };
}

export async function executeMachineOperation(req: MachineRequest, ctx: MachineExecutionContext): Promise<MachineResult> {
  let completed: MachineResult;
  const now = ctx.now ?? (() => new Date());
  if (ctx.signal.aborted) throw new MachineOperationError("aborted", "the machine request was aborted before it started");

  const env = MachineRequestSchema.safeParse(req);
  if (!env.success) throw new MachineOperationError("invalid_request", "the machine request is malformed", { issues: describeIssues(env.error) });
  const request = env.data as MachineRequest;

  const driver = ctx.drivers[request.target.transport];
  let parsedArgs: Record<string, unknown> = {};

  /** write the rejection record, then surface the ORIGINAL error even if the record cannot be written */
  const reject = async (e: MachineOperationError): Promise<never> => {
    try {
      await ctx.evidence.record(evidenceForRejection(request, e.code, e.message, driver?.simulated === true, e.detail.issues, e.transportRef));
    } catch {
      /* the refusal itself is the important fact; a failing sink must not mask it */
    }
    throw e;
  };

  try {
    assertGrant(request, ctx.grant, now().getTime());
    const constraints = parseConstraints(ctx.grant, request.operation);

    if (!driver) throw new MachineOperationError("unsupported_transport", `no machine driver is configured for transport ${request.target.transport}`);
    if (!isImplementedOperation(request.operation)) {
      throw new MachineOperationError("unsupported_operation", `${request.operation} is part of the capability vocabulary but no transport implements it yet`);
    }
    if (!driver.supports.includes(request.operation)) {
      throw new MachineOperationError("unsupported_operation", driver.unsupported?.[request.operation] ?? `${request.operation} is not supported by the ${driver.transport} transport`);
    }

    const parsed = parseMachineArgs(request.operation, request.args);
    if (!parsed.ok) throw new MachineOperationError("invalid_args", "arguments failed validation", { issues: parsed.issues });
    parsedArgs = parsed.args as Record<string, unknown>;

    const timeoutSec = Math.min(request.timeoutSec, constraints.maxTimeoutSec ?? MAX_TIMEOUT_SEC);
    const maxOutputBytes = Math.min(request.maxOutputBytes, constraints.maxOutputBytes ?? MAX_OUTPUT_BYTES);
    if (typeof parsedArgs.timeoutSec === "number" && request.operation.endsWith("exec") && parsedArgs.timeoutSec > timeoutSec) {
      throw new MachineOperationError("limit_exceeded", `the command's timeoutSec (${parsedArgs.timeoutSec}) exceeds the request's time budget (${timeoutSec}s)`);
    }
    if ((request.operation === "file.write" || request.operation === "file.upload") && maxOutputBytes < 2048) throw new MachineOperationError("limit_exceeded", "file.write requires a 2048-byte metadata result budget");
    enforceConstraints(request.operation, parsedArgs, constraints);

    const effective: MachineRequest = { ...request, args: parsedArgs, timeoutSec, maxOutputBytes };
    const execute = async (): Promise<MachineResult> => {
      const raw = await ctx.sessions.withSession(
        { target: request.target, operation: request.operation, operationId: request.operationId, grant: ctx.grant },
        (session) => driver.execute(effective, session, ctx.signal)
      );
      const result = postProcess(effective, driver, raw);

      try {
        const record = await ctx.evidence.record(evidenceForResult(effective, parsedArgs, result));
        return { ...result, evidenceId: record.id };
      } catch (cause) {
        throw new MachineOperationError("evidence_failed", "the request completed but its evidence record could not be written", { result, cause });
      }
    };
    completed = ctx.evidence.runOnce ? await ctx.evidence.runOnce(effective, execute, driver.simulated === true) : await execute();
  } catch (e) {
    if (isMachineOperationError(e)) {
      if (e.code === "evidence_failed") throw e;
      return reject(e);
    }
    // the credential broker refusing a session is a denial, not a driver bug
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "credential_denied") {
      return reject(new MachineOperationError("denied", "the credential broker refused to issue a session for this request", { cause: e }));
    }
    // a driver bug or an unexpected throw: still a refusal with evidence, not an unhandled rejection
    return reject(new MachineOperationError("transport_error", "the machine driver failed unexpectedly", { cause: e }));
  }
  // Classify after recording and caching, including a cached result on replay.
  // Preserve the genuine phase/backup receipt instead of recording a rejection.
  if ((request.operation === "file.write" || request.operation === "file.upload") && !completed.ok && completed.data.effect === "unknown") {
    throw new MachineOperationError("uncertain", "the machine write's durable outcome is unknown; it must never be re-dispatched", {
      result: completed,
      transportRef: completed.transportRef,
    });
  }
  return completed;
}
