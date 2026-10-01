/**
 * Control-plane side of the workflow layer: start, signal, cancel and query
 * operation workflows, and probe whether Temporal is reachable at all.
 *
 * Server-only (Node runtime): it imports the Temporal gRPC client. Never import
 * it from client components, edge routes or from `definitions/`.
 *
 * Idempotency: the workflow id is `op-<operationId>` (types.ts). A second start
 * with the same id is not an error and does not start a second execution:
 *
 *  - while the first is running, `workflowIdConflictPolicy: USE_EXISTING` makes
 *    the server hand back the running execution;
 *  - once it has finished, `workflowIdReusePolicy: REJECT_DUPLICATE` refuses to
 *    run the operation again (an operation runs once; a retry is a NEW
 *    operation with a new id), and this module turns that refusal into the
 *    existing (closed) handle.
 *
 * Both cases return the existing execution's ids. Each start snapshots only
 * its declared ids and scalar flags before transport. Runtime extra fields,
 * accessors and serialization hooks never enter workflow arguments.
 *
 * Connection settings come from `config.ts` (ZENITH_TEMPORAL_* env vars, read
 * in one function). The API key is never logged or put in an error.
 */

import { createHash } from "node:crypto";
import { credentialPatternsIn } from "@/lib/credentials/redact";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
  type WorkflowHandle,
} from "@temporalio/client";
import {
  connectionOptionsFor,
  describeTemporalConfig,
  temporalConfigFromEnv,
  type TemporalConnectionConfig,
} from "./config";
import {
  QUERIES,
  RECONCILE_WORKFLOW_ID,
  SIGNALS,
  TASK_QUEUE,
  WORKFLOW_ID,
  WORKFLOW_TYPES,
  type DayTwoWorkflowInput,
  type DeployWorkflowInput,
  type ReconcileWorkflowInput,
  type RemediationWorkflowInput,
  type WorkflowProgress,
} from "./types";

/* --------------------------------- errors ---------------------------------- */

export class TemporalUnavailableError extends Error {
  readonly code = "temporal_unavailable";
  constructor(message: string) {
    super(message);
  }
}

/* --------------------------------- client ---------------------------------- */

const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 10_000;

const clients = new Map<string, Promise<{ client: Client; connection: Connection }>>();

function cacheKey(config: TemporalConnectionConfig): string {
  const keyDigest = config.apiKey ? createHash("sha256").update(config.apiKey).digest("hex").slice(0, 16) : "-";
  return [config.address, config.namespace, config.tls ? "tls" : "plain", keyDigest].join("|");
}

/** Remove the API key from any text that is about to leave this module. */
function scrub(message: string, config: TemporalConnectionConfig): string {
  const clean = config.apiKey ? message.split(config.apiKey).join("[redacted]") : message;
  return clean.slice(0, 300);
}

/**
 * The shared, lazily created client for a config (default: from the environment).
 * A failed connect is not cached, so the next call retries.
 */
export async function workflowClient(config: TemporalConnectionConfig = temporalConfigFromEnv()): Promise<Client> {
  const key = cacheKey(config);
  let pending = clients.get(key);
  if (!pending) {
    pending = Connection.connect({ ...connectionOptionsFor(config), connectTimeout: CONNECT_TIMEOUT_MS }).then((connection) => ({
      connection,
      client: new Client({ connection, namespace: config.namespace }),
    }));
    clients.set(key, pending);
    pending.catch(() => clients.delete(key));
  }
  try {
    return (await pending).client;
  } catch (err) {
    const { address, namespace } = describeTemporalConfig(config);
    throw new TemporalUnavailableError(`Cannot reach Temporal at ${address} (namespace ${namespace}): ${scrub(err instanceof Error ? err.message : String(err), config)}`);
  }
}

/** Close every shared connection (process shutdown, tests). */
export async function closeWorkflowClients(): Promise<void> {
  const open = [...clients.values()];
  clients.clear();
  await Promise.all(open.map(async (p) => (await p.catch(() => undefined))?.connection.close()));
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TemporalUnavailableError(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface CallOptions {
  /** inject a client (tests, or a caller that manages its own connection) */
  client?: Client;
  /** override the default task queue (tests) */
  taskQueue?: string;
  timeoutMs?: number;
}

const clientFor = (opts: CallOptions | undefined): Promise<Client> => (opts?.client ? Promise.resolve(opts.client) : workflowClient());

/* --------------------------------- starting -------------------------------- */

export class InvalidWorkflowInputError extends Error {
  readonly code = "invalid_workflow_input";
  constructor(field?: string) {
    // Field names come only from the fixed contract, never from caller data.
    super(field ? `Invalid workflow input field: ${field}` : "Invalid workflow input");
  }
}

const ID_SCALAR = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * TypeScript types cannot constrain deserialized objects. Build a fresh plain
 * payload with own scalar data properties only, before connecting to Temporal.
 * Id syntax and credential shapes are tripwires, not proof an id exists; the
 * activities still enforce workspace ownership against stored records.
 */
function workflowPayload<T extends object>(input: T, fields: Record<keyof T, "id" | "boolean">): T {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new InvalidWorkflowInputError();
  const payload: Record<string, string | boolean> = {};
  for (const [field, kind] of Object.entries(fields)) {
    const property = Object.getOwnPropertyDescriptor(input, field);
    const value: unknown = property && "value" in property ? property.value : undefined;
    if (kind === "boolean") {
      if (typeof value !== "boolean") throw new InvalidWorkflowInputError(field);
    } else if (typeof value !== "string" || !ID_SCALAR.test(value) || credentialPatternsIn(value).length > 0) {
      throw new InvalidWorkflowInputError(field);
    }
    payload[field] = value as string | boolean;
  }
  return payload as T;
}

export interface StartedWorkflow {
  workflowId: string;
  /** run id of the execution this call started or found */
  runId: string;
  handle: WorkflowHandle;
}

async function startOnce(
  type: string,
  workflowId: string,
  args: unknown[],
  reuse: WorkflowIdReusePolicy,
  opts: CallOptions | undefined
): Promise<StartedWorkflow> {
  const client = await clientFor(opts);
  try {
    const handle = await withTimeout(
      client.workflow.start(type, {
        workflowId,
        taskQueue: opts?.taskQueue ?? TASK_QUEUE,
        args,
        workflowIdReusePolicy: reuse,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }),
      opts?.timeoutMs ?? CALL_TIMEOUT_MS,
      `starting ${type}`
    );
    return { workflowId, runId: handle.firstExecutionRunId, handle };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      // The operation already ran to completion under this id: return that execution.
      const handle = client.workflow.getHandle(workflowId);
      const description = await withTimeout(handle.describe(), opts?.timeoutMs ?? CALL_TIMEOUT_MS, `describing ${workflowId}`);
      return { workflowId, runId: description.runId, handle };
    }
    throw err;
  }
}

/** Start (or find) the deploy workflow for an operation. Duplicate starts return the existing execution. */
export async function startDeploy(input: DeployWorkflowInput, opts?: CallOptions): Promise<StartedWorkflow> {
  const payload = workflowPayload(input, {
    operationId: "id", workspaceId: "id", projectId: "id", environmentId: "id",
    revisionId: "id", deploymentId: "id", connectionId: "id", preApproved: "boolean", build: "boolean",
  });
  return startOnce(WORKFLOW_TYPES.deploy, WORKFLOW_ID(payload.operationId), [payload], WorkflowIdReusePolicy.REJECT_DUPLICATE, opts);
}

export async function startDayTwo(input: DayTwoWorkflowInput, opts?: CallOptions): Promise<StartedWorkflow> {
  const payload = workflowPayload(input, { operationId: "id", workspaceId: "id", environmentId: "id", capability: "id" });
  return startOnce(WORKFLOW_TYPES.dayTwo, WORKFLOW_ID(payload.operationId), [payload], WorkflowIdReusePolicy.REJECT_DUPLICATE, opts);
}

export async function startRemediation(input: RemediationWorkflowInput, opts?: CallOptions): Promise<StartedWorkflow> {
  const payload = workflowPayload(input, { operationId: "id", workspaceId: "id", environmentId: "id", incidentId: "id" });
  return startOnce(WORKFLOW_TYPES.remediation, WORKFLOW_ID(payload.operationId), [payload], WorkflowIdReusePolicy.REJECT_DUPLICATE, opts);
}

/**
 * Start one reconcile pass. At most one pass per environment runs at a time
 * (`USE_EXISTING`); a finished pass does not block the next one.
 */
export async function startReconcile(input: ReconcileWorkflowInput, opts?: CallOptions): Promise<StartedWorkflow> {
  const payload = workflowPayload(input, { workspaceId: "id", environmentId: "id", allowAutoRepair: "boolean" });
  return startOnce(WORKFLOW_TYPES.reconcile, RECONCILE_WORKFLOW_ID(payload.environmentId), [payload], WorkflowIdReusePolicy.ALLOW_DUPLICATE, opts);
}

/* --------------------------- signalling and queries ------------------------- */

export type SignalResult =
  | { delivered: true }
  | {
      delivered: false;
      /** no such workflow, or it already finished; the database row is the truth, the signal only wakes the workflow */
      reason: "not_found";
    };

async function signalOperation(operationId: string, signal: string, opts: CallOptions | undefined): Promise<SignalResult> {
  const client = await clientFor(opts);
  try {
    await withTimeout(client.workflow.getHandle(WORKFLOW_ID(operationId)).signal(signal), opts?.timeoutMs ?? CALL_TIMEOUT_MS, `signalling ${signal}`);
    return { delivered: true };
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return { delivered: false, reason: "not_found" };
    throw err;
  }
}

/** Tell a waiting workflow an approval row was written. The workflow re-verifies it through `checkApproval`. */
export function signalApproval(operationId: string, opts?: CallOptions): Promise<SignalResult> {
  return signalOperation(operationId, SIGNALS.approvalRecorded, opts);
}

/**
 * Ask a running operation to stop. The workflow cancels its current activity,
 * marks the operation `cancelled` and releases its lease. It never destroys or
 * rolls back anything; steps that already changed the environment stay changed
 * and reconcile observes them.
 */
export function cancelOperation(operationId: string, opts?: CallOptions): Promise<SignalResult> {
  return signalOperation(operationId, SIGNALS.cancel, opts);
}

/**
 * The workflow's live progress, or `null` when there is no such workflow.
 * Answering needs a worker (the query runs in workflow code); with none
 * running this throws `TemporalUnavailableError` after the timeout instead of
 * hanging.
 */
export async function getProgress(operationId: string, opts?: CallOptions): Promise<WorkflowProgress | null> {
  const client = await clientFor(opts);
  try {
    return await withTimeout(
      client.workflow.getHandle(WORKFLOW_ID(operationId)).query<WorkflowProgress>(QUERIES.progress),
      opts?.timeoutMs ?? CALL_TIMEOUT_MS,
      "querying progress"
    );
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return null;
    throw err;
  }
}

/* --------------------------------- probing --------------------------------- */

export type TemporalAvailability =
  | { available: true; address: string; namespace: string; latencyMs: number }
  | {
      available: false;
      address: string;
      namespace: string;
      reason: "unreachable" | "timeout" | "namespace_not_found" | "unauthenticated" | "error";
      message: string;
    };

export interface ProbeOptions {
  config?: TemporalConnectionConfig;
  /** give up after this long (default 2000) */
  timeoutMs?: number;
  /** reuse a result younger than this (default 5000; 0 disables the cache) */
  ttlMs?: number;
}

const probeCache = new Map<string, { at: number; result: TemporalAvailability }>();

const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

/**
 * Is Temporal reachable, and does the namespace exist? Short timeout, typed
 * answer, never throws: capability surfaces call this to decide whether to offer
 * real-infrastructure operations. The result is cached for a few seconds so a
 * busy status route does not open a connection per request.
 */
export async function temporalAvailable(opts: ProbeOptions = {}): Promise<TemporalAvailability> {
  const config = opts.config ?? temporalConfigFromEnv();
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const ttlMs = opts.ttlMs ?? 5_000;
  const key = cacheKey(config);

  const cached = probeCache.get(key);
  if (cached && ttlMs > 0 && Date.now() - cached.at < ttlMs) return cached.result;

  const { address, namespace } = describeTemporalConfig(config);
  const started = Date.now();
  let connection: Connection | undefined;
  let result: TemporalAvailability;
  try {
    connection = await withTimeout(Connection.connect({ ...connectionOptionsFor(config), connectTimeout: timeoutMs }), timeoutMs + 500, "connecting");
    await withTimeout(connection.workflowService.describeNamespace({ namespace }), timeoutMs, "describing the namespace");
    result = { available: true, address, namespace, latencyMs: Date.now() - started };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = scrub(err instanceof Error ? err.message : String(err), config);
    const base = { available: false as const, address, namespace, message };
    if (err instanceof TemporalUnavailableError) result = { ...base, reason: "timeout" };
    else if (code === GRPC_NOT_FOUND) result = { ...base, reason: "namespace_not_found" };
    else if (code === GRPC_UNAUTHENTICATED || code === GRPC_PERMISSION_DENIED) result = { ...base, reason: "unauthenticated" };
    else if (/timed? ?out|deadline|connect|unavailable|ECONNREFUSED/i.test(message)) result = { ...base, reason: "unreachable" };
    else result = { ...base, reason: "error" };
  } finally {
    await connection?.close().catch(() => undefined);
  }
  if (ttlMs > 0) probeCache.set(key, { at: Date.now(), result });
  return result;
}

/** Forget cached probe results (tests). */
export function resetAvailabilityCache(): void {
  probeCache.clear();
}
