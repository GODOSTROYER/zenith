/**
 * AWS SSM transport (ADR-0012): semantic operations through Zenith-owned SSM
 * Command documents (`deploy/aws/ssm-documents`), plus the `machine.exec`
 * escape hatch through the AWS-owned `AWS-RunShellScript`.
 *
 * Flow per request: build the typed parameter set → check it against the
 * document's own `allowedPattern`s → look for an earlier command with the same
 * `Comment` (idempotency) → `SendCommand` to exactly one instance →
 * `GetCommandInvocation` with capped exponential backoff → map the status.
 *
 * Honest limits:
 *   - AWS returns only the FIRST 24,000 characters of stdout and 8,000 of
 *     stderr from `GetCommandInvocation`. Longer output is cut at the end and
 *     reported as `truncated: true`; Zenith does not configure S3/CloudWatch
 *     output. `file.read` over SSM is therefore capped at 16 KiB (base64 in
 *     stdout); use zenithd for larger reads.
 *   - Idempotency: `SendCommand` has no client token. Before sending, recent
 *     commands on the instance are listed (`ListCommands`, filtered by
 *     document and `InvokedAfter`) and matched on `Comment`, which encodes the
 *     operation id and a hash of the request. A match is polled instead of
 *     re-sent. ListCommands is eventually consistent, so two attempts racing
 *     within seconds can still both send; the operation lease/fence token held
 *     by the caller is the primary control, this is the secondary one.
 *   - `machine.exec` builds one command line from the argv by single-quote
 *     escaping every element (see `shell.ts`). It is the escape hatch: the
 *     argv is data but the result is a shell script, so the capability is
 *     critical-risk and policy-gated. Elements containing `{{` are refused
 *     because SSM interpolates `{{ssm:…}}`/`{{ param }}` inside command text
 *     before the shell sees it, which would let an argument read Parameter
 *     Store values the caller never asked for.
 *   - Everything here is verified against `aws-sdk-client-mock` and the AWS
 *     API reference only; no live account was used.
 */
import {
  CancelCommandCommand,
  GetCommandInvocationCommand,
  ListCommandsCommand,
  SendCommandCommand,
  SSMClient,
  type Command,
  type GetCommandInvocationCommandOutput,
} from "@aws-sdk/client-ssm";
import type { AwsClientCtor, AwsSession } from "@/lib/credentials/types";
import { capability } from "@/lib/capabilities/catalog";
import { digest } from "@/lib/controlplane/digest";
import { MachineOperationError } from "../errors";
import { MachineFailureDataSchema, type MachineFailureCode } from "../results";
import { argvToCommandLine } from "../shell";
import { isDeniedFilePath, pathAllowed } from "../guards";
import { parseMachineArgs, isImplementedOperation } from "../args";
import { DEFAULT_FILE_READ_PREFIXES, SSM_COMMENT_MAX_CHARS, SSM_FILE_READ_MAX_BYTES, SSM_STDERR_LIMIT_CHARS, SSM_STDOUT_LIMIT_CHARS } from "../limits";
import { redactText, truncateUtf8 } from "../redact";
import type { MachineDriver, MachineOperation, MachineRequest, MachineResult } from "../types";
import {
  AWS_RUN_SHELL_SCRIPT,
  buildSsmDocuments,
  checkDocumentParameters,
  documentNameFor,
  OPERATION_DOCUMENTS,
  DEFAULT_SSM_DOCUMENT_PREFIX,
  type SsmCommandDocument,
  type SsmDocumentOperation,
  type ZenithSsmDocumentSuffix,
} from "./aws-ssm-docs";
import { parseSsmOutput } from "./aws-ssm-parse";

/* --------------------------------- options --------------------------------- */

export interface AwsSsmDriverOptions {
  /** must match the prefix the documents were deployed with (default `Zenith-`) */
  documentPrefix?: string;
  /** must match the FileRead document's deployed allowlist (default {@link DEFAULT_FILE_READ_PREFIXES}) */
  fileReadPrefixes?: readonly string[];
  /** must match the ServiceRestart document's deployed unit allowlist, when one was set */
  restartAllow?: readonly string[];
  /** seconds SSM may take to START the command before giving up (SendCommand.TimeoutSeconds, ≥ 30) */
  deliveryTimeoutSec?: number;
  /** poll backoff; the first poll happens after `initialMs` */
  backoff?: { initialMs: number; maxMs: number; factor: number };
  /** how far back the duplicate-avoidance lookup goes */
  idempotencyLookbackSec?: number;
  /* injectable for tests */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const DEFAULTS = {
  deliveryTimeoutSec: 60,
  backoff: { initialMs: 500, maxMs: 5000, factor: 1.6 },
  idempotencyLookbackSec: 6 * 3600,
  pollGraceSec: 15,
  maxListPages: 4,
} as const;

const SUPPORTED: readonly MachineOperation[] = [...(Object.keys(OPERATION_DOCUMENTS) as MachineOperation[]), "machine.exec"];

const INSTANCE_ID = /^(i-[0-9a-f]{8}|i-[0-9a-f]{17}|mi-[0-9a-f]{17})$/;

export const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/* ---------------------------------- plan ----------------------------------- */

interface Plan {
  documentName: string;
  /** SendCommand.Parameters */
  parameters: Record<string, string[]>;
  exec: boolean;
  docOp?: SsmDocumentOperation;
}

const isDocOperation = (op: MachineOperation): op is SsmDocumentOperation => Object.prototype.hasOwnProperty.call(OPERATION_DOCUMENTS, op);

const invalid = (message: string): MachineOperationError => new MachineOperationError("invalid_args", message);

function requireContainer(args: Record<string, unknown>): string {
  if (typeof args.container !== "string") throw invalid("container is required for this transport");
  return args.container;
}

/** The document parameters for an operation; values are already schema-validated strings/numbers. */
function documentParameters(req: MachineRequest, args: Record<string, unknown>, fileReadPrefixes: readonly string[]): Record<string, string> {
  const s = (v: unknown): string => String(v);
  switch (req.operation) {
    case "machine.inspect":
    case "system.metrics":
      return {};
    case "process.list":
      return { limit: s(args.limit), sortBy: s(args.sortBy) };
    case "service.status":
    case "machine.service.restart":
      return { unit: s(args.unit) };
    case "container.list":
      if (args.labelSelector !== undefined) throw invalid("labelSelector is only supported on Kubernetes targets");
      return { all: s(args.all), limit: s(args.limit) };
    case "container.inspect":
      return { container: requireContainer(args) };
    case "container.logs":
      return {
        container: requireContainer(args),
        lines: s(args.lines),
        timestamps: s(args.timestamps),
        ...(typeof args.since === "string" ? { since: args.since } : {}),
      };
    case "file.read": {
      const path = s(args.path);
      if (!pathAllowed(path, fileReadPrefixes)) throw new MachineOperationError("denied", "path is not under an allowed file.read prefix for this environment");
      if (isDeniedFilePath(path)) throw new MachineOperationError("denied", "path matches a never-readable pattern");
      return { path, maxBytes: s(Math.min(Number(args.maxBytes), SSM_FILE_READ_MAX_BYTES)) };
    }
    case "network.portCheck":
      return { host: s(args.host), port: s(args.port), timeoutSec: s(args.timeoutSec) };
    case "network.dnsCheck":
      return { name: s(args.name), recordType: s(args.recordType) };
    case "system.logs":
      return { since: s(args.since), lines: s(args.lines), ...(typeof args.unit === "string" ? { unit: args.unit } : {}) };
    default:
      throw new MachineOperationError("unsupported_operation", `${req.operation} is not implemented for aws_ssm`);
  }
}

interface PlanOptions {
  documentPrefix: string;
  fileReadPrefixes: readonly string[];
  /** the documents as deployed for this environment (prefix allowlists applied), used for the local pre-check */
  documents: Readonly<Record<ZenithSsmDocumentSuffix, SsmCommandDocument>>;
}

function buildPlan(req: MachineRequest, args: Record<string, unknown>, o: PlanOptions): Plan {
  const pollTimeout = Math.max(1, Math.min(req.timeoutSec, 999));
  if (req.operation === "machine.exec") {
    const argv = args.argv as string[];
    const line = argvToCommandLine(argv);
    if (line.includes("{{")) {
      throw invalid("an argv element contains '{{', which SSM would interpolate into the command text; use another transport or restructure the argument");
    }
    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    return {
      documentName: AWS_RUN_SHELL_SCRIPT,
      parameters: {
        commands: [line],
        executionTimeout: [String(Math.max(1, Math.min(Number(args.timeoutSec), 999)))],
        ...(cwd ? { workingDirectory: [cwd] } : {}),
      },
      exec: true,
    };
  }
  if (!isDocOperation(req.operation)) throw new MachineOperationError("unsupported_operation", `${req.operation} is not implemented for aws_ssm`);
  const suffix = OPERATION_DOCUMENTS[req.operation];
  const doc = o.documents[suffix];
  const values = { ...documentParameters(req, args, o.fileReadPrefixes), executionTimeout: String(pollTimeout) };
  const problems = checkDocumentParameters(doc, values);
  if (problems.length) throw new MachineOperationError("invalid_args", `parameters rejected by the ${documentNameFor(suffix, o.documentPrefix)} document contract`, { issues: problems });
  return {
    documentName: documentNameFor(suffix, o.documentPrefix),
    parameters: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [v]])),
    exec: false,
    docOp: req.operation,
  };
}

/* ------------------------------- idempotency -------------------------------- */

/**
 * The `Comment` that ties an SSM command to one Zenith request:
 * `zenith:<operationId>:<12 hex of digest(operation, target, args)>`, or with
 * a hashed operation id when that would exceed SSM's 100-character limit.
 * Two different requests under one operation id therefore never collide.
 */
export function ssmCommentFor(req: MachineRequest): string {
  const h = digest({ operation: req.operation, target: req.target.targetId, args: req.args }).slice(0, 12);
  const plain = `zenith:${req.operationId}:${h}`;
  return plain.length <= SSM_COMMENT_MAX_CHARS ? plain : `zenith:h${digest(req.operationId).slice(0, 24)}:${h}`;
}

async function findExistingCommand(ssm: SSMClient, req: MachineRequest, documentName: string, comment: string, sinceMs: number, signal: AbortSignal, pages: number): Promise<string | undefined> {
  let token: string | undefined;
  const matches: Command[] = [];
  for (let page = 0; page < pages; page++) {
    const out = await ssm.send(
      new ListCommandsCommand({
        InstanceId: req.target.targetId,
        Filters: [
          { key: "DocumentName", value: documentName },
          { key: "InvokedAfter", value: new Date(sinceMs).toISOString() },
        ],
        MaxResults: 50,
        NextToken: token,
      }),
      { abortSignal: signal }
    );
    for (const c of out.Commands ?? []) if (c.Comment === comment && c.CommandId) matches.push(c);
    token = out.NextToken;
    if (!token) break;
  }
  matches.sort((a, b) => (a.RequestedDateTime?.getTime() ?? 0) - (b.RequestedDateTime?.getTime() ?? 0));
  return matches[0]?.CommandId;
}

/* --------------------------------- errors ---------------------------------- */

const errName = (e: unknown): string => (typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "Error");
const isAbort = (e: unknown): boolean => errName(e) === "AbortError" || errName(e) === "TimeoutError";

function safeMessage(e: unknown): string {
  const m = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return redactText(m).text.slice(0, 200);
}

function mapAwsError(e: unknown, transportRef?: string): MachineOperationError {
  const n = errName(e);
  const detail = { transportRef, cause: e };
  switch (n) {
    case "InvalidInstanceId":
      return new MachineOperationError("target_unreachable", "the instance is not a registered, online SSM managed node (or the session may not reach it)", detail);
    case "InvalidParameters":
      return new MachineOperationError("invalid_args", "SSM rejected the document parameters", detail);
    case "InvalidDocument":
    case "InvalidDocumentVersion":
      return new MachineOperationError("transport_error", "the Zenith SSM document is not deployed in this account and region; run the environment bootstrap", detail);
    case "UnsupportedPlatformType":
      return new MachineOperationError("unsupported_operation", "the instance is not a Linux machine; the Zenith documents are Linux-only", detail);
    case "ThrottlingException":
    case "TooManyRequestsException":
      return new MachineOperationError("transport_error", "SSM throttled the request", { ...detail, retryable: true });
    case "AccessDeniedException":
    case "AccessDenied":
      return new MachineOperationError("transport_error", "AWS denied the SSM call; check the session role's ssm permissions", detail);
    default:
      return new MachineOperationError("transport_error", `SSM call failed: ${n}: ${safeMessage(e)}`, detail);
  }
}

/* --------------------------------- driver ---------------------------------- */

function isAwsSession(s: unknown): s is AwsSession {
  return typeof s === "object" && s !== null && (s as { provider?: unknown }).provider === "aws" && typeof (s as { client?: unknown }).client === "function";
}

const TERMINAL_STATUS = new Set(["Success", "Failed", "TimedOut", "Cancelled"]);

type Invocation = GetCommandInvocationCommandOutput;

function failureData(code: MachineFailureCode, reason: string | undefined, extra: { status?: string; exitCode?: number | null; timedOut?: boolean } = {}): Record<string, unknown> {
  return MachineFailureDataSchema.parse({ error: code, ...(reason ? { reason: redactText(reason).text.slice(0, 1000) } : {}), ...extra });
}

const EXIT_CODE_FAILURES: Record<number, MachineFailureCode> = { 64: "invalid_parameters", 65: "refused", 66: "not_found", 69: "unavailable" };

export function createAwsSsmMachineDriver(options: AwsSsmDriverOptions = {}): MachineDriver {
  const prefix = options.documentPrefix ?? DEFAULT_SSM_DOCUMENT_PREFIX;
  const fileReadPrefixes = options.fileReadPrefixes ?? DEFAULT_FILE_READ_PREFIXES;
  const documents = Object.fromEntries(buildSsmDocuments({ fileReadPrefixes, restartAllow: options.restartAllow }).map((d) => [d.suffix, d.document])) as Record<ZenithSsmDocumentSuffix, SsmCommandDocument>;
  const delivery = Math.max(30, options.deliveryTimeoutSec ?? DEFAULTS.deliveryTimeoutSec);
  const backoff = options.backoff ?? DEFAULTS.backoff;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const lookbackMs = (options.idempotencyLookbackSec ?? DEFAULTS.idempotencyLookbackSec) * 1000;

  async function execute(req: MachineRequest, session: unknown, signal: AbortSignal): Promise<MachineResult> {
    if (!isAwsSession(session)) throw new MachineOperationError("transport_error", "aws_ssm requires an AWS session from the credential broker");
    if (!isImplementedOperation(req.operation) || !SUPPORTED.includes(req.operation)) {
      throw new MachineOperationError("unsupported_operation", `${req.operation} is not implemented for aws_ssm`);
    }
    if (!INSTANCE_ID.test(req.target.targetId)) throw new MachineOperationError("invalid_request", "aws_ssm targetId must be an EC2 instance id (i-…) or managed instance id (mi-…)");
    const parsed = parseMachineArgs(req.operation, req.args);
    if (!parsed.ok) throw new MachineOperationError("invalid_args", "arguments failed validation", { issues: parsed.issues });
    const args = parsed.args as Record<string, unknown>;

    const plan = buildPlan(req, args, { documentPrefix: prefix, fileReadPrefixes, documents });
    const comment = ssmCommentFor(req);
    const mutating = capability(req.operation).mutates;
    const instanceId = req.target.targetId;
    const ssm = aws(session);
    const startedAt = new Date(now()).toISOString();
    let commandId: string | undefined;

    try {
      commandId = await findExistingCommand(ssm, req, plan.documentName, comment, now() - lookbackMs, signal, DEFAULTS.maxListPages);
      if (!commandId) {
        const sent = await ssm.send(
          new SendCommandCommand({
            InstanceIds: [instanceId],
            DocumentName: plan.documentName,
            DocumentVersion: "$DEFAULT",
            Parameters: plan.parameters,
            TimeoutSeconds: delivery,
            Comment: comment,
          }),
          { abortSignal: signal }
        );
        commandId = sent.Command?.CommandId;
        if (!commandId) throw new MachineOperationError("protocol_violation", "SendCommand returned no command id");
      }

      const deadline = now() + (req.timeoutSec + delivery + DEFAULTS.pollGraceSec) * 1000;
      const inv = await pollInvocation(ssm, commandId, instanceId, deadline, signal);
      if (inv === "deadline") return await onDeadline(ssm, req, commandId, mutating, startedAt);
      return toResult(req, plan, args, inv, commandId, startedAt);
    } catch (e) {
      if (e instanceof MachineOperationError) throw e;
      if (isAbort(e) || signal.aborted) {
        if (commandId && mutating) throw new MachineOperationError("uncertain", "the request was sent to the instance but waiting for it was aborted; its outcome is unknown", { transportRef: commandId, cause: e });
        throw new MachineOperationError("aborted", "the machine request was aborted", { transportRef: commandId, cause: e });
      }
      const mapped = mapAwsError(e, commandId);
      if (commandId && mutating && mapped.code === "transport_error") {
        throw new MachineOperationError("uncertain", `the request was sent (command ${commandId}) but its result could not be read: ${mapped.message}`, { transportRef: commandId, cause: e });
      }
      throw mapped;
    }
  }

  function aws(session: AwsSession): SSMClient {
    return session.client(SSMClient as unknown as AwsClientCtor<SSMClient>);
  }

  async function pollInvocation(ssm: SSMClient, commandId: string, instanceId: string, deadline: number, signal: AbortSignal): Promise<Invocation | "deadline"> {
    let delay = backoff.initialMs;
    for (;;) {
      await sleep(Math.round(delay * (0.8 + random() * 0.4)), signal);
      try {
        const inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }), { abortSignal: signal });
        if (inv.Status && TERMINAL_STATUS.has(inv.Status)) return inv;
      } catch (e) {
        // the invocation record appears a moment after SendCommand (eventual consistency); throttling is transient
        const n = errName(e);
        if (n !== "InvocationDoesNotExist" && n !== "ThrottlingException" && n !== "TooManyRequestsException") throw e;
      }
      if (now() >= deadline) return "deadline";
      delay = Math.min(backoff.maxMs, delay * backoff.factor);
    }
  }

  async function onDeadline(ssm: SSMClient, req: MachineRequest, commandId: string, mutating: boolean, startedAt: string): Promise<MachineResult> {
    if (mutating) {
      throw new MachineOperationError("uncertain", `command ${commandId} did not finish within the request's time budget; it may still be running or may have completed`, { transportRef: commandId });
    }
    // read-only: stop the work we started, best effort
    try {
      await ssm.send(new CancelCommandCommand({ CommandId: commandId, InstanceIds: [req.target.targetId] }));
    } catch {
      /* cancellation is best effort (it needs ssm:CancelCommand); the timeout result below stands either way */
    }
    return {
      ok: false,
      operation: req.operation,
      data: failureData("timeout", "the command did not finish within the request's time budget; cancellation was requested", { timedOut: true }),
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      transport: "aws_ssm",
      transportRef: commandId,
      simulated: false,
    };
  }

  function toResult(req: MachineRequest, plan: Plan, args: Record<string, unknown>, inv: Invocation, commandId: string, startedAt: string): MachineResult {
    const finishedAt = new Date(now()).toISOString();
    const stdoutRaw = inv.StandardOutputContent ?? "";
    const stderrRaw = inv.StandardErrorContent ?? "";
    const stdoutCut = stdoutRaw.length >= SSM_STDOUT_LIMIT_CHARS;
    const stderrCut = stderrRaw.length >= SSM_STDERR_LIMIT_CHARS;
    const base = { operation: req.operation, startedAt, finishedAt, transport: "aws_ssm" as const, transportRef: commandId, simulated: false };
    const exitCode = typeof inv.ResponseCode === "number" && inv.ResponseCode >= 0 ? inv.ResponseCode : null;
    const details = inv.StatusDetails ?? inv.Status ?? "";

    if (plan.exec) {
      const out = truncateUtf8(stdoutRaw, req.maxOutputBytes);
      const err = truncateUtf8(stderrRaw, req.maxOutputBytes);
      const timedOut = inv.Status === "TimedOut";
      return {
        ...base,
        ok: inv.Status === "Success",
        data: { exitCode, ...(timedOut ? { timedOut: true } : {}) },
        output: { stdout: out.text, stderr: err.text, exitCode, truncated: stdoutCut || stderrCut || out.truncated || err.truncated },
      };
    }

    if (inv.Status === "Success") {
      if (stdoutCut) {
        return { ...base, ok: false, data: failureData("unexpected_output", "the document output reached the 24,000-character SSM limit and was cut", { status: details }) };
      }
      const parsed = parseSsmOutput(plan.docOp as SsmDocumentOperation, stdoutRaw, args);
      return parsed.ok ? { ...base, ok: true, data: parsed.data } : { ...base, ok: false, data: failureData("unexpected_output", parsed.reason, { status: details }) };
    }

    const reason = stderrRaw.trim().split("\n")[0] || details;
    if (inv.Status === "Failed") {
      const code = (exitCode !== null && EXIT_CODE_FAILURES[exitCode]) || "command_failed";
      // "Failed" with response code -1 (null here) and a delivery-ish detail means the node never ran it
      const notRun = exitCode === null && /undeliverable|delivery/i.test(details);
      return { ...base, ok: false, data: failureData(notRun ? "delivery_failed" : code, reason, { status: details, exitCode }) };
    }
    if (inv.Status === "TimedOut") {
      const notStarted = /delivery/i.test(details);
      return { ...base, ok: false, data: failureData(notStarted ? "delivery_failed" : "timeout", reason, { status: details, timedOut: true }) };
    }
    return { ...base, ok: false, data: failureData("cancelled", reason, { status: details }) };
  }

  return { transport: "aws_ssm", supports: SUPPORTED, unsupported: UNSUPPORTED, execute };
}

const UNSUPPORTED: Partial<Record<MachineOperation, string>> = {
  "container.exec": "container.exec is not offered over SSM; use machine.exec (escape hatch) or a zenithd-managed machine",
  "file.write": "file.write requires an opt-in Linux zenithd local-template profile and is not supported by this transport",
  "file.upload": "file.upload requires an opt-in Linux zenithd local binary profile and is not supported by this transport",
  "package.install": "package.install requires the opt-in Debian data-only zenithd root helper and is unsupported by this transport",
  "service.configure": "service.configure requires an opt-in Linux zenithd local service profile and is not supported by this transport",
};
