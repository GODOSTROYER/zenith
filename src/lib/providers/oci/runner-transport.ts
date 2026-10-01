/**
 * The control-plane half of the proposed `oci.http` runner job
 * (docs/platform/RUNNER-PROTOCOL-OCI.md): an `OciApiTransport` that turns each
 * request into an UNSIGNED job payload, hands it to an injected `dispatch`
 * function (the runner job queue, owned by the runner-server workstream), and
 * decodes the allowlisted response.
 *
 * It exists so the TypeScript drivers and the proposed wire format are tested
 * against each other today, even though the runner side (`go/`) does not
 * implement `oci.http` yet. It performs the SAME validation the runner must
 * repeat (never trust a peer's validation):
 *
 *   - `service` must be one of the logical ids in `services.ts` (no host);
 *   - `region` must look like an OCI region id;
 *   - `path` must be absolute, without `..`, `//`, `?`, `#`, backslash or
 *     control characters (the query travels separately);
 *   - only allowlisted request headers pass; `Authorization`, `Host`,
 *     signature and date headers are refused, never stripped silently;
 *   - the request must be in the allowlist of the capability the session was
 *     created for (allowlist.ts), so a session minted for `infrastructure.observe`
 *     cannot be used to restart anything;
 *   - bodies are JSON-serializable and at most `maxRequestBytes`;
 *   - responses are capped at `maxResponseBytes` and only allowlisted headers
 *     are kept.
 *
 * Secret values travel in `bodyB64` for `secret.write` only. The payload is
 * NOT logged here; `dispatch` implementations must treat `oci.http` payloads
 * for vault writes as sensitive (RUNNER-PROTOCOL-OCI.md §6).
 */
import { isAllowed } from "./allowlist";
import { isRegionId, OCI_SERVICE_HOSTS, type OciServiceId } from "./services";
import { OCI_REQUEST_HEADER_ALLOWLIST, OCI_RESPONSE_HEADER_ALLOWLIST, type OciApiRequest, type OciApiResponse, type OciApiTransport, type OciHttpMethod } from "./transport";

/** Payload of an `oci.http` job: an unsigned OCI REST request. */
export interface OciHttpJobPayload {
  service: OciServiceId;
  region: string;
  method: OciHttpMethod;
  /** absolute path, already percent-encoded, no query string */
  path: string;
  /** ordered `[name, value]` pairs so the runner signs exactly what it sends */
  query: [string, string][];
  headers: Record<string, string>;
  /** base64 of the exact request body bytes; absent for no body */
  bodyB64?: string;
  /** only for `queue-data` */
  endpointHost?: string;
}

/** What the runner returns for an `oci.http` job. */
export interface OciHttpJobResult {
  status: number;
  headers: Record<string, string>;
  /** base64 of the response body, capped by the job's `maxOutputBytes` */
  bodyB64?: string;
  /** true when the runner cut the body at the cap */
  truncated?: boolean;
}

export type OciRunnerDispatch = (payload: OciHttpJobPayload, opts: { signal?: AbortSignal }) => Promise<OciHttpJobResult>;

export class OciTransportRefused extends Error {
  readonly code = "oci_request_refused";
  constructor(message: string) {
    super(message);
    this.name = "OciTransportRefused";
  }
}

export interface RunnerTransportLimits {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

const METHODS = new Set<OciHttpMethod>(["GET", "HEAD", "POST", "PUT", "DELETE"]);
const FORBIDDEN_HEADERS = /^(authorization|host|date|x-date|x-content-sha256|content-length|content-type|signature|cookie|proxy-.*)$/i;
// eslint-disable-next-line no-control-regex
const BAD_PATH = /[\u0000-\u001f\u007f\\?#]|\.\.|\/\//;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,200}[a-z0-9])?\.oraclecloud\.com$/i;

export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Validate and serialize one request. Throws `OciTransportRefused` on anything the runner would refuse. */
export function toJobPayload(req: OciApiRequest, limits: RunnerTransportLimits = {}): OciHttpJobPayload {
  if (!(req.service in OCI_SERVICE_HOSTS)) throw new OciTransportRefused(`Unknown OCI service "${String(req.service)}".`);
  if (!isRegionId(req.region)) throw new OciTransportRefused(`"${String(req.region).slice(0, 40)}" is not an OCI region id.`);
  if (!METHODS.has(req.method)) throw new OciTransportRefused(`Method ${String(req.method)} is not allowed.`);
  if (typeof req.path !== "string" || !req.path.startsWith("/") || req.path.length > 2048 || BAD_PATH.test(req.path)) throw new OciTransportRefused("The request path is not a plain absolute path.");

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const name = k.toLowerCase();
    if (FORBIDDEN_HEADERS.test(name)) throw new OciTransportRefused(`Header ${name} is set by the runner and may not be supplied.`);
    if (!(OCI_REQUEST_HEADER_ALLOWLIST as readonly string[]).includes(name)) throw new OciTransportRefused(`Header ${name} is not in the allowlist.`);
    if (typeof v !== "string" || v.length > 256 || /[\r\n]/.test(v)) throw new OciTransportRefused(`Header ${name} has an invalid value.`);
    headers[name] = v;
  }

  const query: [string, string][] = Object.entries(req.query ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  let endpointHost: string | undefined;
  if (req.service === "queue-data") {
    if (!req.endpointHost || !HOST.test(req.endpointHost)) throw new OciTransportRefused("queue-data requests need an *.oraclecloud.com endpointHost.");
    endpointHost = req.endpointHost.toLowerCase();
  } else if (req.endpointHost !== undefined) {
    throw new OciTransportRefused("endpointHost is only valid for queue-data.");
  }

  let bodyB64: string | undefined;
  if (req.body !== undefined) {
    if (req.method === "GET" || req.method === "HEAD") throw new OciTransportRefused(`${req.method} requests carry no body.`);
    const bytes = Buffer.from(JSON.stringify(req.body), "utf8");
    if (bytes.length > (limits.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES)) throw new OciTransportRefused("The request body is too large.");
    bodyB64 = bytes.toString("base64");
  }
  return { service: req.service, region: req.region, method: req.method, path: req.path, query, headers, ...(bodyB64 !== undefined ? { bodyB64 } : {}), ...(endpointHost ? { endpointHost } : {}) };
}

/** Decode a runner result into an `OciApiResponse` (allowlisted headers, parsed JSON). */
export function fromJobResult(result: OciHttpJobResult, limits: RunnerTransportLimits = {}): OciApiResponse {
  if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) throw new OciTransportRefused("The runner returned an invalid HTTP status.");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    const name = k.toLowerCase();
    if ((OCI_RESPONSE_HEADER_ALLOWLIST as readonly string[]).includes(name) && typeof v === "string") headers[name] = v.slice(0, 2000);
  }
  if (result.bodyB64 === undefined || result.bodyB64 === "") return { status: result.status, headers, body: undefined };
  const bytes = Buffer.from(result.bodyB64, "base64");
  if (bytes.length > (limits.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) throw new OciTransportRefused("The runner's response is larger than allowed.");
  if (result.truncated) throw new OciTransportRefused("The runner truncated the response; it cannot be parsed reliably.");
  const text = bytes.toString("utf8");
  try {
    return { status: result.status, headers, body: JSON.parse(text) };
  } catch {
    return { status: result.status, headers, body: text.slice(0, 2000) };
  }
}

export interface RunnerTransportOptions extends RunnerTransportLimits {
  /** the capability this session was brokered for; requests outside its allowlist are refused */
  capability: string;
}

export function createRunnerOciTransport(dispatch: OciRunnerDispatch, limits: RunnerTransportOptions): OciApiTransport {
  return {
    async request(req, opts) {
      if (!isAllowed(limits.capability, req)) throw new OciTransportRefused(`${req.method} ${req.service} request is not in the allowlist of capability ${limits.capability}.`);
      const payload = toJobPayload(req, limits);
      const result = await dispatch(payload, { signal: opts?.signal });
      return fromJobResult(result, limits);
    },
  };
}
