/**
 * Turning vault secrets into live bindings, with the host checks that make a
 * tenant-supplied connection safe to open from inside Zenith's network.
 *
 * Nothing here logs or returns a connection string; errors carry no values.
 */
import net from "node:net";
import tls from "node:tls";
import { allowPrivateHostsFromEnv, resolveConnectableHost, assertConnectableHost, type HostLookup } from "./net";
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

type PostgresSsl = false | tls.ConnectionOptions;

function postgresSsl(url: URL, allowPrivate: boolean): PostgresSsl {
  const mode = url.searchParams.get("sslmode");
  if (mode === "disable") {
    if (!allowPrivate) throw new PortabilityError("invalid_input", "A Postgres connection without TLS is only allowed on a worker the operator placed inside the tenant's network.");
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return { rejectUnauthorized: true, servername: net.isIP(hostname) ? undefined : hostname, checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostname, cert) };
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
  const allowPrivate = opts.allowPrivate ?? allowPrivateHostsFromEnv();
  const ssl = postgresSsl(url, allowPrivate);
  const { default: postgres } = await import("postgres");
  const clean = new URL(uri);
  clean.searchParams.delete("sslmode");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const clientOptions = {
    // postgres invokes this factory for every new session, including reconnects.
    socket: async () => {
      const addresses = await resolveConnectableHost(hostname, opts);
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection({ host: addresses[0]!.address, family: addresses[0]!.family, port: Number(url.port || 5432) });
        socket.setTimeout(20_000, () => socket.destroy(new PortabilityError("unavailable", "The Postgres service could not be reached.")));
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.setTimeout(0);
          socket.removeListener("error", reject);
          resolve(socket);
        });
      });
    },
    max: 1,
    ssl,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 20,
    onnotice: () => undefined,
    connection: { application_name: "zenith-portability" },
  };
  const client = postgres(clean.toString(), clientOptions);
  const runner: SqlRunner = {
    async query(text, params) {
      try {
        return (await client.unsafe(text, (params ?? []) as never[])) as unknown as Record<string, unknown>[];
      } catch (err) {
        // The driver's message can carry statement text and values; only a class of failure leaves.
        if (err instanceof PortabilityError) throw err;
        const rawCode = (err as { code?: unknown }).code;
        const code = typeof rawCode === "string" && /^(?:[0-9A-Z]{5}|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|CONNECT_TIMEOUT)$/.test(rawCode) ? rawCode : "";
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
  return { binding: { kind: "mysql", conn, cli: opts.mysqlCli ?? spawnMysqlCli(process.env, { allowPrivate: opts.allowPrivate, lookup: opts.lookup }) }, close: async () => undefined };
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
