/**
 * How the control plane and the execution worker reach Temporal. The one place
 * this module family reads environment variables for the connection.
 *
 *   ZENITH_TEMPORAL_ADDRESS    host:port of the Temporal frontend      (default localhost:7233)
 *   ZENITH_TEMPORAL_NAMESPACE  Temporal namespace                      (default "default")
 *   ZENITH_TEMPORAL_API_KEY    Temporal Cloud API key; implies TLS     (optional, secret)
 *   ZENITH_TEMPORAL_TLS        "true"/"1" forces TLS without a key     (optional)
 *   ZENITH_TEMPORAL_TLS_CA_FILE      PEM server CA bundle             (optional)
 *   ZENITH_TEMPORAL_TLS_CERT_FILE    PEM client certificate chain     (with KEY_FILE)
 *   ZENITH_TEMPORAL_TLS_KEY_FILE     PEM client private key           (with CERT_FILE)
 *   ZENITH_TEMPORAL_TLS_SERVER_NAME  TLS server identity override     (optional)
 *
 * API keys and TLS material never enter logs or errors. Printable configuration
 * uses `describeTemporalConfig`, which reports only set/unset for these fields.
 * TLS files are read synchronously on first configuration load, bounded to 1 MiB
 * each, and cached by absolute path for the process lifetime. Restart both the
 * web process and worker after rotating files. The SDK validates PEM and trust
 * when connecting; loading a file is not proof of a valid certificate or trust.
 *
 * Unverified live: nothing here has been run against Temporal Cloud (no account
 * on this machine). The option shapes follow the SDK's documented API-key and
 * TLS options; see docs/platform/EXECUTION-WORKER.md.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type { TLSConfig } from "@temporalio/common/lib/internal-non-workflow";

export const DEFAULT_TEMPORAL_ADDRESS = "localhost:7233";
export const DEFAULT_TEMPORAL_NAMESPACE = "default";
export const MAX_TEMPORAL_TLS_FILE_BYTES = 1024 * 1024;

export interface TemporalConnectionConfig {
  address: string;
  namespace: string;
  /** secret; see the module comment */
  apiKey?: string;
  tls: boolean;
  /** Contains certificate/key bytes. Connection-local only; never log. */
  tlsOptions?: TLSConfig;
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
const SERVER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const tlsFiles = new Map<string, Buffer>();

/** Never expose filesystem errors, paths or file contents, including as causes. */
function readTlsFile(file: string, variable: string): Buffer {
  try {
    const absolute = resolve(file);
    const cached = tlsFiles.get(absolute);
    if (cached) return Buffer.from(cached);
    // Nonblocking open lets fstat reject FIFOs without waiting for a writer.
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
    let content: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_TEMPORAL_TLS_FILE_BYTES) throw new Error();
      // The extra byte detects growth after fstat without an unbounded read.
      const buffer = Buffer.alloc(MAX_TEMPORAL_TLS_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_TEMPORAL_TLS_FILE_BYTES || !buffer.subarray(0, size).toString("utf8").trim()) throw new Error();
      content = Buffer.from(buffer.subarray(0, size));
    } finally {
      closeSync(fd);
    }
    tlsFiles.set(absolute, content);
    // Callers/SDKs cannot mutate the process's startup snapshot.
    return Buffer.from(content);
  } catch {
    throw new TemporalConfigError(`${variable} must name a readable regular file with 1..${MAX_TEMPORAL_TLS_FILE_BYTES} nonblank bytes`);
  }
}

export function temporalConfigFromEnv(env: Env = process.env): TemporalConnectionConfig {
  const address = trimmed(env.ZENITH_TEMPORAL_ADDRESS) ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = trimmed(env.ZENITH_TEMPORAL_NAMESPACE) ?? DEFAULT_TEMPORAL_NAMESPACE;
  const apiKey = trimmed(env.ZENITH_TEMPORAL_API_KEY);
  const tlsFlag = trimmed(env.ZENITH_TEMPORAL_TLS)?.toLowerCase();
  const caFile = trimmed(env.ZENITH_TEMPORAL_TLS_CA_FILE);
  const certFile = trimmed(env.ZENITH_TEMPORAL_TLS_CERT_FILE);
  const keyFile = trimmed(env.ZENITH_TEMPORAL_TLS_KEY_FILE);
  const serverName = trimmed(env.ZENITH_TEMPORAL_TLS_SERVER_NAME);

  if (!ADDRESS.test(address)) {
    throw new TemporalConfigError("ZENITH_TEMPORAL_ADDRESS must be host:port");
  }
  if (!NAMESPACE.test(namespace)) {
    throw new TemporalConfigError(`ZENITH_TEMPORAL_NAMESPACE contains characters Temporal does not allow`);
  }
  if (tlsFlag !== undefined && !["true", "1", "false", "0"].includes(tlsFlag)) {
    throw new TemporalConfigError(`ZENITH_TEMPORAL_TLS must be "true", "1", "false" or "0"`);
  }
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new TemporalConfigError("ZENITH_TEMPORAL_TLS_CERT_FILE and ZENITH_TEMPORAL_TLS_KEY_FILE must be set together");
  }
  if (serverName && (serverName.length > 253 || !SERVER_NAME.test(serverName))) {
    throw new TemporalConfigError("ZENITH_TEMPORAL_TLS_SERVER_NAME must be a DNS hostname without a scheme, port or path");
  }
  const tlsOptions: TLSConfig | undefined = caFile || certFile || serverName ? {
    ...(caFile ? { serverRootCACertificate: readTlsFile(caFile, "ZENITH_TEMPORAL_TLS_CA_FILE") } : {}),
    ...(certFile && keyFile ? { clientCertPair: {
      crt: readTlsFile(certFile, "ZENITH_TEMPORAL_TLS_CERT_FILE"),
      key: readTlsFile(keyFile, "ZENITH_TEMPORAL_TLS_KEY_FILE"),
    } } : {}),
    ...(serverName ? { serverNameOverride: serverName } : {}),
  } : undefined;
  // Credentials and any custom TLS setting force encryption, even with TLS=false.
  const tls = apiKey !== undefined || tlsFlag === "true" || tlsFlag === "1" || tlsOptions !== undefined;
  return { address, namespace, tls, ...(apiKey ? { apiKey } : {}), ...(tlsOptions ? { tlsOptions } : {}) };
}

/** A log-safe view: no keys, PEM, file paths or server-name override values. */
export function describeTemporalConfig(config: TemporalConnectionConfig) {
  const status = (set: boolean): "set" | "unset" => set ? "set" : "unset";
  return {
    address: config.address, namespace: config.namespace, tls: config.tls,
    apiKey: status(!!config.apiKey),
    tlsCa: status(!!config.tlsOptions?.serverRootCACertificate),
    tlsCert: status(!!config.tlsOptions?.clientCertPair?.crt),
    tlsKey: status(!!config.tlsOptions?.clientCertPair?.key),
    tlsServerName: status(!!config.tlsOptions?.serverNameOverride),
  };
}

/** Temporal Cloud's regional endpoints need the namespace as gRPC metadata when authenticating with an API key. */
const isRegionalCloudEndpoint = (address: string): boolean => /\.api\.temporal\.io(?::\d+)?$/.test(address);

/** Options for `Connection.connect` / `NativeConnection.connect`. Contains secrets: never log. */
export function connectionOptionsFor(config: TemporalConnectionConfig): {
  address: string;
  tls?: true | TLSConfig;
  apiKey?: string;
  metadata?: Record<string, string>;
} {
  return {
    address: config.address,
    ...(config.tlsOptions ? { tls: config.tlsOptions } : config.tls ? { tls: true as const } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiKey && isRegionalCloudEndpoint(config.address) ? { metadata: { "temporal-namespace": config.namespace } } : {}),
  };
}
