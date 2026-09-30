/**
 * How the control plane and the execution worker reach Temporal. The one place
 * this module family reads environment variables for the connection.
 *
 *   ZENITH_TEMPORAL_ADDRESS    host:port of the Temporal frontend      (default localhost:7233)
 *   ZENITH_TEMPORAL_NAMESPACE  Temporal namespace                      (default "default")
 *   ZENITH_TEMPORAL_API_KEY    Temporal Cloud API key; implies TLS     (optional, secret)
 *   ZENITH_TEMPORAL_TLS        "true"/"1" forces TLS without a key     (optional)
 *
 * The API key is a secret: it is never logged, never put in an error message and
 * never returned by `describeTemporalConfig`. Everything that prints a config
 * uses `describeTemporalConfig`.
 *
 * Unverified live: nothing here has been run against Temporal Cloud (no account
 * on this machine). The option shapes follow the SDK's documented API-key and
 * TLS options; see docs/platform/EXECUTION-WORKER.md.
 */

export const DEFAULT_TEMPORAL_ADDRESS = "localhost:7233";
export const DEFAULT_TEMPORAL_NAMESPACE = "default";

export interface TemporalConnectionConfig {
  address: string;
  namespace: string;
  /** secret; see the module comment */
  apiKey?: string;
  tls: boolean;
}

export class TemporalConfigError extends Error {
  readonly code = "temporal_config_invalid";
}

type Env = Readonly<Record<string, string | undefined>>;

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const ADDRESS = /^[A-Za-z0-9._-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;
const NAMESPACE = /^[A-Za-z0-9._-]{1,255}$/;

export function temporalConfigFromEnv(env: Env = process.env): TemporalConnectionConfig {
  const address = trimmed(env.ZENITH_TEMPORAL_ADDRESS) ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = trimmed(env.ZENITH_TEMPORAL_NAMESPACE) ?? DEFAULT_TEMPORAL_NAMESPACE;
  const apiKey = trimmed(env.ZENITH_TEMPORAL_API_KEY);
  const tlsFlag = trimmed(env.ZENITH_TEMPORAL_TLS)?.toLowerCase();

  if (!ADDRESS.test(address)) {
    throw new TemporalConfigError(`ZENITH_TEMPORAL_ADDRESS must be host:port (got "${address.slice(0, 80)}")`);
  }
  if (!NAMESPACE.test(namespace)) {
    throw new TemporalConfigError(`ZENITH_TEMPORAL_NAMESPACE contains characters Temporal does not allow`);
  }
  if (tlsFlag !== undefined && !["true", "1", "false", "0"].includes(tlsFlag)) {
    throw new TemporalConfigError(`ZENITH_TEMPORAL_TLS must be "true", "1", "false" or "0"`);
  }
  // An API key must never travel in the clear, so it forces TLS on.
  const tls = apiKey !== undefined || tlsFlag === "true" || tlsFlag === "1";
  return { address, namespace, tls, ...(apiKey ? { apiKey } : {}) };
}

/** A log-safe view of a config: the key is reduced to whether it is set. */
export function describeTemporalConfig(config: TemporalConnectionConfig): { address: string; namespace: string; tls: boolean; apiKey: "set" | "unset" } {
  return { address: config.address, namespace: config.namespace, tls: config.tls, apiKey: config.apiKey ? "set" : "unset" };
}

/** Temporal Cloud's regional endpoints need the namespace as gRPC metadata when authenticating with an API key. */
const isRegionalCloudEndpoint = (address: string): boolean => /\.api\.temporal\.io(?::\d+)?$/.test(address);

/** Options for `Connection.connect` / `NativeConnection.connect`. Contains the API key: never log it. */
export function connectionOptionsFor(config: TemporalConnectionConfig): {
  address: string;
  tls?: true;
  apiKey?: string;
  metadata?: Record<string, string>;
} {
  return {
    address: config.address,
    ...(config.tls ? { tls: true as const } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiKey && isRegionalCloudEndpoint(config.address) ? { metadata: { "temporal-namespace": config.namespace } } : {}),
  };
}
