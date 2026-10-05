/**
 * Turning vault secrets into live bindings, with the host checks that make a
 * tenant-supplied connection safe to open from inside Zenith's network.
 *
 * Nothing here logs or returns a connection string; errors carry no values.
 */
import { assertConnectableHost, type HostLookup } from "./net";
import { S3ObjectStore, parseS3Credentials, type S3Credentials } from "./engines/s3";
import { parseMysqlUri, spawnMysqlCli, type MysqlCli } from "./engines/mysql";
import { PortabilityError, type SqlRunner } from "./types";
import type { ServiceBinding } from "./service";

export interface ConnectOptions {
  allowPrivate?: boolean;
  lookup?: HostLookup;
  /** test seam for the MySQL clients */
  mysqlCli?: MysqlCli;
}

export interface OpenBinding {
  binding: ServiceBinding;
  close(): Promise<void>;
}

type PostgresSsl = false | "require" | { rejectUnauthorized: true };

function postgresSsl(url: URL, allowPrivate: boolean): PostgresSsl {
  const mode = url.searchParams.get("sslmode");
  if (mode === "disable") {
    if (!allowPrivate) throw new PortabilityError("invalid_input", "A Postgres connection without TLS is only allowed on a worker the operator placed inside the tenant's network.");
    return false;
  }
  if (mode === "verify-full" || mode === "verify-ca") return { rejectUnauthorized: true };
  return "require";
}

/** One Postgres session (a single connection): the engine issues BEGIN/COMMIT itself. */
export async function openPostgres(uri: string, opts: ConnectOptions = {}): Promise<OpenBinding> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new PortabilityError("invalid_input", "The Postgres connection secret is not a valid URI.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new PortabilityError("invalid_input", "The Postgres connection secret must be a postgres:// URI.");
  await assertConnectableHost(url.hostname, { allowPrivate: opts.allowPrivate, lookup: opts.lookup });
  const allowPrivate = opts.allowPrivate ?? false;
  const ssl = postgresSsl(url, allowPrivate);
  const { default: postgres } = await import("postgres");
  const clean = new URL(uri);
  clean.searchParams.delete("sslmode");
  const client = postgres(clean.toString(), {
    max: 1,
    ssl,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 20,
    onnotice: () => undefined,
    connection: { application_name: "zenith-portability" },
  });
  const runner: SqlRunner = {
    async query(text, params) {
      try {
        return (await client.unsafe(text, (params ?? []) as never[])) as unknown as Record<string, unknown>[];
      } catch (err) {
        // The driver's message can carry statement text and values; only a class of failure leaves.
        const code = (err as { code?: string }).code ?? "";
        if (code.startsWith("28") || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT") throw new PortabilityError("unavailable", "The Postgres service could not be reached with the registered credentials.");
        throw new PortabilityError("verification_failed", `A Postgres statement failed (${code || "error"}).`);
      }
    },
  };
  return { binding: { kind: "postgres", sql: runner }, close: async () => { await client.end({ timeout: 5 }); } };
}

export async function openMysql(uri: string, opts: ConnectOptions = {}): Promise<OpenBinding> {
  const conn = parseMysqlUri(uri);
  await assertConnectableHost(conn.host, { allowPrivate: opts.allowPrivate, lookup: opts.lookup });
  if (conn.ssl === "disabled" && !opts.allowPrivate) throw new PortabilityError("invalid_input", "A MySQL connection without TLS is only allowed on a worker the operator placed inside the tenant's network.");
  return { binding: { kind: "mysql", conn, cli: opts.mysqlCli ?? spawnMysqlCli() }, close: async () => undefined };
}

export function openObjectStore(credentialsJson: string, opts: ConnectOptions = {}): { creds: S3Credentials; store: S3ObjectStore } {
  const creds = parseS3Credentials(credentialsJson);
  return { creds, store: new S3ObjectStore(creds, { allowPrivate: opts.allowPrivate, lookup: opts.lookup }) };
}

export async function openBinding(kind: "postgres" | "mysql" | "object_store", secret: string, opts: ConnectOptions = {}): Promise<OpenBinding> {
  if (kind === "postgres") return openPostgres(secret, opts);
  if (kind === "mysql") return openMysql(secret, opts);
  const { store } = openObjectStore(secret, opts);
  return { binding: { kind: "object_store", store }, close: async () => undefined };
}
