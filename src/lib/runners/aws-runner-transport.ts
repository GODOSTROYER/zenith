/**
 * AWS SDK v3 over a customer-side runner (`aws.http` jobs).
 *
 * Drivers keep using ordinary AWS SDK clients. A client built here has its
 * transport replaced: instead of opening a socket to AWS, every request becomes
 * one `aws.http` job (RUNNER-PROTOCOL.md section 4) that the customer's runner
 * SigV4-signs with ITS local identity and executes; the response comes back as
 * the job result and is handed to the SDK's own deserializer. The control plane
 * never holds AWS credentials in this mode.
 *
 * How the SDK is bent (everything here is verified by tests/runners/aws-transport
 * against real SDK clients — JSON, query and REST protocols):
 *   - `signer`  a no-op that only records the SigV4 signing service and region the
 *               SDK resolved (`x-zenith-signing-*`, consumed and removed by the
 *               handler), so the job carries the right `service`/`region` even for
 *               global services (Route 53 and IAM sign as us-east-1);
 *   - `credentials` a static dummy. It never signs anything; it only stops the SDK
 *               from running the default credential chain (env, IMDS);
 *   - `requestHandler` `RunnerHttpHandler`: serializes the request, awaits the job,
 *               rebuilds an `HttpResponse`;
 *   - `maxAttempts: 1`  the SDK must not retry a job: one SDK call is at most one
 *               job. Retrying a mutating call is the workflow's decision, not the
 *               transport's (and an `uncertain` job must never be re-dispatched).
 *
 * Sent to the runner: method, https URL (host + path + query), headers minus
 * `Authorization`, `X-Amz-Security-Token`, `X-Amz-Date` (and hop-by-hop ones the
 * runner recomputes), and the body bytes (base64). The runner enforces its own
 * host and action allowlist and refuses anything else.
 *
 * Honest limits:
 *   - bodies are buffered (8 MiB request cap; the runner's response cap applies),
 *     so streaming uploads/downloads of large objects are out of scope;
 *   - S3 aws-chunked/trailer checksums would need a payload-hash header the runner
 *     strips; clients are built with `requestChecksumCalculation: "WHEN_REQUIRED"`
 *     so plain calls do not use them;
 *   - waiting for a runner adds its poll latency (long-poll makes it near zero,
 *     but it is not a socket to AWS).
 */
import { Readable } from "node:stream";
import { buildQueryString, HttpResponse } from "@smithy/core/protocols";
import type { HttpHandlerOptions, HttpRequest } from "@smithy/types";
import { CredentialDeniedError, type AwsClientCtor, type AwsSession } from "@/lib/credentials/types";
import { awaitRunnerJob, DispatchError, enqueueRunnerJob, requireSucceeded } from "@/lib/runners/dispatch";
import { getRunnerRuntime, type RunnerRuntime } from "@/lib/runners/runtime";
import { unverifiedClaims } from "@/lib/runners/signing";

const SIGNING_SERVICE_HEADER = "x-zenith-signing-service";
const SIGNING_REGION_HEADER = "x-zenith-signing-region";

/** Headers the control plane never sends: credentials/signing metadata, and hop-by-hop ones the runner recomputes. */
const DROPPED_HEADERS = new Set(["authorization", "x-amz-security-token", "x-amz-date", "x-amz-content-sha256", "host", "content-length", "connection", "transfer-encoding", "expect", "keep-alive", "proxy-authorization", "proxy-connection"]);

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Not credentials: a placeholder the no-op signer never uses. Kept obviously fake so a scan never mistakes it for a key. */
const PLACEHOLDER_CREDENTIALS = { accessKeyId: "zenith-runner-transport", secretAccessKey: "zenith-runner-transport" } as const;

export interface RunnerAwsTransportOptions {
  runnerId: string;
  workspaceId: string;
  operationId: string;
  /** the capability grant for this operation (its `cap` claim names the job's capability) */
  grant: string;
  region: string;
  /** default: the grant's `cap` claim */
  capability?: string;
  timeoutSec?: number;
  maxOutputBytes?: number;
  queueTtlSec?: number;
  /** default 1; raising it lets the SDK re-send (and the runner re-execute) a call */
  maxAttempts?: number;
  /** return false once the brokered session has ended; further calls are refused */
  isActive?: () => boolean;
  runtime?: RunnerRuntime;
}

/** An SDK request rejected before or instead of a job (payload cap, ended session, non-https endpoint). */
export class RunnerTransportError extends Error {
  constructor(
    readonly code: "request_too_large" | "insecure_endpoint" | "session_ended",
    message: string
  ) {
    super(message);
    this.name = "RunnerTransportError";
  }
}

async function readBody(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const chunks: Buffer[] = [];
  let total = 0;
  const take = (c: unknown): void => {
    const b = typeof c === "string" ? Buffer.from(c) : Buffer.from(c as Uint8Array);
    total += b.length;
    if (total > MAX_REQUEST_BYTES) throw new RunnerTransportError("request_too_large", `The request body exceeds ${MAX_REQUEST_BYTES} bytes; the runner transport buffers bodies.`);
    chunks.push(b);
  };
  if (typeof (body as Readable).pipe === "function" || Symbol.asyncIterator in (body as object)) {
    for await (const c of body as AsyncIterable<unknown>) take(c);
  } else if (typeof (body as ReadableStream).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      take(value);
    }
  } else {
    throw new RunnerTransportError("request_too_large", "Unsupported request body type.");
  }
  return Buffer.concat(chunks);
}

/** The SDK's no-op signer: records what it would have signed for, signs nothing. */
export const recordingSigner = {
  async sign(request: HttpRequest, options?: { signingRegion?: string; signingService?: string }): Promise<HttpRequest> {
    const headers = { ...request.headers };
    if (options?.signingService) headers[SIGNING_SERVICE_HEADER] = options.signingService;
    if (options?.signingRegion) headers[SIGNING_REGION_HEADER] = options.signingRegion;
    return { ...request, headers } as HttpRequest;
  },
};

/** `ecs.us-east-1.amazonaws.com` → `ecs`; only used when the SDK did not name a signing service. */
const serviceFromHost = (hostname: string): string => hostname.split(".")[0] ?? "";

/** An SDK `requestHandler` that runs each request as an `aws.http` job. */
export class RunnerHttpHandler {
  readonly metadata = { handlerProtocol: "http/1.1" };

  constructor(
    private readonly opts: RunnerAwsTransportOptions,
    private readonly region: string
  ) {}

  destroy(): void {}
  updateHttpClientConfig(): void {}
  httpHandlerConfigs(): Record<string, never> {
    return {};
  }

  async handle(request: HttpRequest, handlerOptions?: HttpHandlerOptions): Promise<{ response: HttpResponse }> {
    const { opts } = this;
    if (opts.isActive && !opts.isActive()) throw new RunnerTransportError("session_ended", "The brokered AWS session has ended; this client can no longer be used.");
    if (request.protocol !== "https:") throw new RunnerTransportError("insecure_endpoint", "aws.http requires https endpoints.");

    const headers: Record<string, string> = {};
    let service: string | undefined;
    let signingRegion: string | undefined;
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (lower === SIGNING_SERVICE_HEADER) service = value;
      else if (lower === SIGNING_REGION_HEADER) signingRegion = value;
      else if (!DROPPED_HEADERS.has(lower)) headers[lower] = value;
    }
    const query = buildQueryString(request.query ?? {});
    const url = `https://${request.hostname}${request.port ? `:${request.port}` : ""}${request.path || "/"}${query ? `?${query}` : ""}`;
    const body = await readBody(request.body);
    if (body.length > MAX_REQUEST_BYTES) throw new RunnerTransportError("request_too_large", `The request body exceeds ${MAX_REQUEST_BYTES} bytes; the runner transport buffers bodies.`);

    const rt = opts.runtime ?? getRunnerRuntime();
    const capability = opts.capability ?? String(unverifiedClaims(opts.grant)?.cap ?? "");
    const jobId = await enqueueRunnerJob(
      {
        workspaceId: opts.workspaceId,
        runnerId: opts.runnerId,
        operationId: opts.operationId,
        capability,
        kind: "aws.http",
        grant: opts.grant,
        timeoutSec: opts.timeoutSec,
        maxOutputBytes: opts.maxOutputBytes,
        queueTtlSec: opts.queueTtlSec,
        payload: {
          service: service ?? serviceFromHost(request.hostname),
          region: signingRegion ?? this.region,
          method: request.method.toUpperCase(),
          url,
          headers,
          ...(body.length > 0 ? { bodyB64: Buffer.from(body).toString("base64") } : {}),
        },
      },
      rt
    );
    const awaited = await awaitRunnerJob<{ status: number; headers?: Record<string, string>; bodyB64?: string }>(jobId, { workspaceId: opts.workspaceId, signal: handlerOptions?.abortSignal as AbortSignal | undefined }, rt);
    const { result } = requireSucceeded(awaited);
    if (!result || typeof result.status !== "number") throw new DispatchError("invalid_payload", "The runner's aws.http result has no HTTP status.");
    return {
      response: new HttpResponse({
        statusCode: result.status,
        headers: Object.fromEntries(Object.entries(result.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
        body: Readable.from([Buffer.from(result.bodyB64 ?? "", "base64")]),
      }),
    };
  }
}

/**
 * Build the `client()` of an `AwsSession` whose clients talk through a runner.
 * `WS-CRED`'s `runner` auth mode plugs this into its session.
 */
export function createRunnerAwsSessionClientFactory(opts: RunnerAwsTransportOptions): AwsSession["client"] {
  return <C>(ctor: AwsClientCtor<C>, overrides?: { region?: string }): C => {
    const region = overrides?.region ?? opts.region;
    return new ctor({
      region,
      credentials: PLACEHOLDER_CREDENTIALS,
      signer: recordingSigner,
      requestHandler: new RunnerHttpHandler(opts, region),
      maxAttempts: opts.maxAttempts ?? 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  };
}

export interface RunnerAwsSessionOptions extends RunnerAwsTransportOptions {
  accountId: string;
  expiresAt: string;
}

/** A complete `AwsSession` for `transport: "runner"`. There is no credential to hand to a child process. */
export function createRunnerAwsSession(opts: RunnerAwsSessionOptions): AwsSession {
  return {
    provider: "aws",
    accountId: opts.accountId,
    region: opts.region,
    expiresAt: opts.expiresAt,
    transport: "runner",
    client: createRunnerAwsSessionClientFactory(opts),
    childProcessEnv() {
      throw new CredentialDeniedError("A runner session holds no AWS credentials; run OpenTofu with a `tofu.run` job on the runner instead.");
    },
  };
}
