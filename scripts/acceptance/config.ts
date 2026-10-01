/**
 * Live-acceptance configuration — the ONE place the harness reads its
 * environment.
 *
 * Everything is `ZENITH_LIVE_*`. Nothing here is a secret except the control
 * plane API token (`ZENITH_LIVE_API_TOKEN`); `describeConfig` prints a config
 * with that reduced to "set" / "unset", and nothing else in the harness prints
 * the raw value.
 *
 * Validation is syntactic only (shape, charset, ranges). Whether the AWS
 * account is the sandbox is decided by `safety.ts`, never here: a config that
 * parses is not a config that is allowed to touch a cloud.
 */

export const DEFAULT_MAX_MONTHLY_USD = 50;

/**
 * Regions a live run may use unless `ZENITH_LIVE_ALLOWED_REGIONS` says
 * otherwise. Deliberately short: cheap, well-served regions the placement price
 * catalog covers. A region outside the list is refused before any cloud call.
 */
export const DEFAULT_ALLOWED_REGIONS: readonly string[] = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "ap-south-1"];

const ACCOUNT_ID = /^\d{12}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DOMAIN = /^(?=.{4,200}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export class LiveConfigError extends Error {
  readonly code = "live_config_invalid";
  constructor(message: string) {
    super(message);
    this.name = "LiveConfigError";
  }
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface LiveConfig {
  /** `ZENITH_LIVE_AWS_ACCOUNT_ID`: the ONE account a live run may touch */
  awsAccountId?: string;
  /** `ZENITH_LIVE_REGION` (or `--region`); there is no default on purpose */
  region?: string;
  allowedRegions: string[];
  maxMonthlyUsd: number;
  /** `ZENITH_LIVE_API_URL`: origin of the Zenith control plane under test */
  apiUrl?: string;
  /** `ZENITH_LIVE_API_TOKEN`: a `za_` integration token. Secret. */
  apiToken?: string;
  /** `ZENITH_LIVE_CONNECTION_ID`: the verified AWS connection of the sandbox account */
  connectionId?: string;
  /** `ZENITH_LIVE_DNS_ZONE`: a hosted zone the connection may write to, e.g. `live.example.com` */
  dnsZone?: string;
  /** `ZENITH_LIVE_STATE_BUCKET`: defaults to `zenith-state-<account>-<region>` */
  stateBucket?: string;
  /** `ZENITH_LIVE_WORKSPACE_ID`: Zenith workspace id (part of the tofu state key) */
  workspaceId?: string;
  /** `ZENITH_LIVE_STATE_KMS_ARN`: client-side state encryption key, when the stack was created with one */
  stateKmsKeyArn?: string;
  /** `ZENITH_LIVE_APPROVAL_TIMEOUT_MS`: how long to wait for a human to approve (default 30 min) */
  approvalTimeoutMs: number;
  /** `ZENITH_LIVE_DEPLOY_TIMEOUT_MS`: how long a deploy may run (default 60 min) */
  deployTimeoutMs: number;
  /** `ZENITH_LIVE_WORKER_CONTROL`: `docker:<container>` | `process:<pidfile>` | `manual` (Demo E) */
  workerControl?: string;
  /** `ZENITH_LIVE_KUBE_CONTEXT`: kubeconfig context of a kind or sandbox cluster (Demo G) */
  kubeContext?: string;
  /** `ZENITH_LIVE_KUBE_CONNECTION_ID`: the verified Kubernetes connection of that cluster (Demo G) */
  kubeConnectionId?: string;
  /** `ZENITH_LIVE_MANAGED_CONNECTION_ID`: the managed (provider=zenith) connection (Demo I) */
  managedConnectionId?: string;
  /** `ZENITH_LIVE_MCP_URL`, `ZENITH_LIVE_MCP_TOKEN` (secret): the MCP endpoint and token (Demo H) */
  mcpUrl?: string;
  mcpToken?: string;
  /** `ZENITH_LIVE_MCP_TOOLS`: JSON map of role -> tool name for Demo H */
  mcpTools?: Record<string, string>;
  /** `ZENITH_LIVE_MANAGED_API_URL`: the managed (provider=zenith) control plane (Demo I) */
  managedApiUrl?: string;
}

function clean(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

function numberOf(env: EnvLike, name: string, fallback: number, min: number, max: number): number {
  const raw = clean(env[name]);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new LiveConfigError(`${name} must be a number between ${min} and ${max} (got "${raw.slice(0, 40)}").`);
  return n;
}

export function parseAllowedRegions(raw: string | undefined): string[] {
  const value = clean(raw);
  if (value === undefined) return [...DEFAULT_ALLOWED_REGIONS];
  const regions = value
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (regions.length === 0) throw new LiveConfigError("ZENITH_LIVE_ALLOWED_REGIONS is set but empty.");
  for (const r of regions) if (!REGION.test(r)) throw new LiveConfigError(`ZENITH_LIVE_ALLOWED_REGIONS contains "${r.slice(0, 40)}", which is not an AWS region name.`);
  return [...new Set(regions)];
}

function idOf(env: EnvLike, name: string): string | undefined {
  const v = clean(env[name]);
  if (v !== undefined && !ID.test(v)) throw new LiveConfigError(`${name} must be letters, digits, "_" or "-" (max 100).`);
  return v;
}

export function parseApiUrl(raw: string | undefined, name: string): string | undefined {
  const v = clean(raw);
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new LiveConfigError(`${name} is not a URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new LiveConfigError(`${name} must be https (plain http is accepted only for localhost): a bearer token must not cross the network in the clear.`);
  }
  if (url.username || url.password) throw new LiveConfigError(`${name} must not embed credentials.`);
  return url.origin;
}

function kubeContext(env: EnvLike): string | undefined {
  const v = clean(env.ZENITH_LIVE_KUBE_CONTEXT);
  if (v !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,120}$/.test(v)) throw new LiveConfigError("ZENITH_LIVE_KUBE_CONTEXT is not a usable kubeconfig context name.");
  return v;
}

export function loadLiveConfig(env: EnvLike = process.env, overrides: { region?: string } = {}): LiveConfig {
  const awsAccountId = clean(env.ZENITH_LIVE_AWS_ACCOUNT_ID);
  if (awsAccountId !== undefined && !ACCOUNT_ID.test(awsAccountId)) {
    throw new LiveConfigError("ZENITH_LIVE_AWS_ACCOUNT_ID must be a 12-digit AWS account id.");
  }
  const region = clean(overrides.region) ?? clean(env.ZENITH_LIVE_REGION);
  if (region !== undefined && !REGION.test(region)) throw new LiveConfigError(`The region "${region.slice(0, 40)}" is not an AWS region name.`);
  const dnsZone = clean(env.ZENITH_LIVE_DNS_ZONE)?.toLowerCase();
  if (dnsZone !== undefined && !DOMAIN.test(dnsZone)) throw new LiveConfigError("ZENITH_LIVE_DNS_ZONE must be a domain name such as live.example.com.");
  const stateBucket = clean(env.ZENITH_LIVE_STATE_BUCKET);
  if (stateBucket !== undefined && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(stateBucket)) throw new LiveConfigError("ZENITH_LIVE_STATE_BUCKET is not a valid S3 bucket name.");
  const stateKmsKeyArn = clean(env.ZENITH_LIVE_STATE_KMS_ARN);
  if (stateKmsKeyArn !== undefined && !/^arn:[a-z-]+:kms:[a-z0-9-]+:\d{12}:(?:key|alias)\/[A-Za-z0-9/_-]+$/.test(stateKmsKeyArn)) {
    throw new LiveConfigError("ZENITH_LIVE_STATE_KMS_ARN is not a KMS key or alias ARN.");
  }
  let mcpTools: Record<string, string> | undefined;
  const toolsRaw = clean(env.ZENITH_LIVE_MCP_TOOLS);
  if (toolsRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(toolsRaw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== "string")) throw new Error("shape");
      mcpTools = parsed as Record<string, string>;
    } catch {
      throw new LiveConfigError('ZENITH_LIVE_MCP_TOOLS must be a JSON object of role -> tool name, e.g. {"inspect":"...","propose":"..."}.');
    }
  }
  const workerControl = clean(env.ZENITH_LIVE_WORKER_CONTROL);
  if (workerControl !== undefined && !/^(?:manual|docker:[A-Za-z0-9][A-Za-z0-9_.-]{0,100}|process:[^\0]{1,400})$/.test(workerControl)) {
    throw new LiveConfigError('ZENITH_LIVE_WORKER_CONTROL must be "manual", "docker:<container>" or "process:<pidfile>".');
  }
  return {
    awsAccountId,
    region,
    allowedRegions: parseAllowedRegions(env.ZENITH_LIVE_ALLOWED_REGIONS),
    maxMonthlyUsd: numberOf(env, "ZENITH_LIVE_MAX_MONTHLY_USD", DEFAULT_MAX_MONTHLY_USD, 0.01, 1_000_000),
    apiUrl: parseApiUrl(env.ZENITH_LIVE_API_URL, "ZENITH_LIVE_API_URL"),
    apiToken: clean(env.ZENITH_LIVE_API_TOKEN),
    connectionId: idOf(env, "ZENITH_LIVE_CONNECTION_ID"),
    dnsZone,
    stateBucket,
    workspaceId: idOf(env, "ZENITH_LIVE_WORKSPACE_ID"),
    stateKmsKeyArn,
    approvalTimeoutMs: numberOf(env, "ZENITH_LIVE_APPROVAL_TIMEOUT_MS", 30 * 60_000, 1_000, 24 * 3_600_000),
    deployTimeoutMs: numberOf(env, "ZENITH_LIVE_DEPLOY_TIMEOUT_MS", 60 * 60_000, 1_000, 24 * 3_600_000),
    workerControl,
    kubeContext: kubeContext(env),
    kubeConnectionId: idOf(env, "ZENITH_LIVE_KUBE_CONNECTION_ID"),
    managedConnectionId: idOf(env, "ZENITH_LIVE_MANAGED_CONNECTION_ID"),
    mcpUrl: parseApiUrl(env.ZENITH_LIVE_MCP_URL, "ZENITH_LIVE_MCP_URL"),
    mcpToken: clean(env.ZENITH_LIVE_MCP_TOKEN),
    mcpTools,
    managedApiUrl: parseApiUrl(env.ZENITH_LIVE_MANAGED_API_URL, "ZENITH_LIVE_MANAGED_API_URL"),
  };
}

/** A log-safe view of a config: secrets reduced to set/unset. */
export function describeConfig(config: LiveConfig): Record<string, unknown> {
  const { apiToken, mcpToken, ...rest } = config;
  return { ...rest, apiToken: apiToken ? "set" : "unset", mcpToken: mcpToken ? "set" : "unset" };
}

/** The default S3 state bucket of the bootstrap stack (`deploy/aws`): `zenith-state-<account>-<region>`. */
export const defaultStateBucket = (accountId: string, region: string): string => `zenith-state-${accountId}-${region}`;
