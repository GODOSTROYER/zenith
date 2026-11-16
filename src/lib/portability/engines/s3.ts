/**
 * S3-compatible adapter for the object engine and for tenant-owned artifact
 * storage. Credentials arrive as one vault secret (JSON), never in a proposal:
 *
 *   { "region": "...", "bucket": "...", "accessKeyId": "...", "secretAccessKey": "...",
 *     "sessionToken"?: "...", "endpoint"?: "https://..." }
 *
 * The AWS SDK is imported lazily so importing this module costs nothing for
 * callers that never touch S3.
 */
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { allowPrivateHostsFromEnv, assertConnectableHost, resolveConnectableHost, type HostLookup } from "../net";
import { PortabilityError, type ArtifactStore, type ObjectStorePort } from "../types";

export interface S3Credentials {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,40}$/;

/** Parse and validate the credentials secret. Errors never echo a value. */
export function parseS3Credentials(raw: string): S3Credentials {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new PortabilityError("invalid_input", "The storage credentials secret is not valid JSON.");
  }
  const text = (k: string, max: number): string => {
    const v = value[k];
    if (typeof v !== "string" || v.length === 0 || v.length > max) throw new PortabilityError("invalid_input", `The storage credentials secret is missing a usable "${k}".`);
    return v;
  };
  const bucket = text("bucket", 63);
  const region = text("region", 40);
  if (!BUCKET.test(bucket) || !REGION.test(region)) throw new PortabilityError("invalid_input", "The storage credentials name an invalid bucket or region.");
  const out: S3Credentials = { region, bucket, accessKeyId: text("accessKeyId", 256), secretAccessKey: text("secretAccessKey", 512) };
  if (value.sessionToken !== undefined) out.sessionToken = text("sessionToken", 4096);
  if (value.endpoint !== undefined) {
    const endpoint = text("endpoint", 300);
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new PortabilityError("invalid_input", "The storage endpoint is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new PortabilityError("invalid_input", "The storage endpoint must be http or https.");
    if (url.username || url.password) throw new PortabilityError("invalid_input", "The storage endpoint must not carry credentials.");
    out.endpoint = url.origin;
  }
  return out;
}

interface S3Like { send(command: unknown): Promise<unknown> }

/** Fresh sockets make each SDK attempt revalidate DNS, including literal hosts. */
function validatedAgents(opts: { allowPrivate?: boolean; lookup?: HostLookup }): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  const httpAgent = new http.Agent({ keepAlive: false });
  const httpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: true });
  const create = (secure: boolean): http.Agent["createConnection"] => (options, callback) => {
    const hostname = String(options.host ?? options.hostname ?? "").replace(/^\[|\]$/g, "");
    void resolveConnectableHost(hostname, opts).then((addresses) => {
      if (!secure && !(opts.allowPrivate ?? allowPrivateHostsFromEnv())) {
        throw new PortabilityError("invalid_input", "Storage without TLS is only allowed on a worker the operator placed inside the tenant's network.");
      }
      const address = addresses[0]!;
      const tlsOptions: tls.ConnectionOptions & net.TcpNetConnectOpts = {
        ...options, path: undefined, socket: undefined, fd: undefined,
        host: address.address, family: address.family, port: Number(options.port ?? 443), rejectUnauthorized: true,
        servername: net.isIP(hostname) ? undefined : hostname,
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostname, cert),
      };
      const socket = secure
        ? tls.connect(tlsOptions)
        : net.connect({ path: undefined, fd: undefined, host: address.address, family: address.family, port: Number(options.port ?? 80) });
      const onError = (err: Error): void => {
        socket.destroy();
        callback?.(err instanceof PortabilityError ? err : new PortabilityError("unavailable", "The storage service could not be reached."), undefined as never);
      };
      socket.setTimeout(5_000, () => socket.destroy(new PortabilityError("unavailable", "The storage service could not be reached.")));
      socket.once("error", onError);
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.setTimeout(0);
        socket.removeListener("error", onError);
        callback?.(null, socket);
      });
    }).catch((err: unknown) => {
      callback?.(err instanceof PortabilityError ? err : new PortabilityError("unavailable", "The storage service could not be reached."), undefined as never);
    });
    return undefined;
  };
  httpAgent.createConnection = create(false);
  httpsAgent.createConnection = create(true);
  return { httpAgent, httpsAgent };
}

function storageFailure(err: unknown): never {
  if (err instanceof PortabilityError) throw err;
  throw new PortabilityError("unavailable", "The storage service could not be reached with the registered credentials.");
}


export class S3ObjectStore implements ObjectStorePort {
  readonly bucket: string;
  private client?: S3Like;
  private sdk?: typeof import("@aws-sdk/client-s3");

  constructor(private readonly creds: S3Credentials, private readonly opts: { client?: S3Like; allowPrivate?: boolean; lookup?: HostLookup } = {}) {
    this.bucket = creds.bucket;
    this.client = opts.client;
  }

  private async open(): Promise<{ client: S3Like; sdk: typeof import("@aws-sdk/client-s3") }> {
    this.sdk ??= await import("@aws-sdk/client-s3");
    if (!this.client) {
      if (this.creds.endpoint) await assertConnectableHost(new URL(this.creds.endpoint).hostname, this.opts);

      this.client = new this.sdk.S3Client({
        region: this.creds.region,
        credentials: { accessKeyId: this.creds.accessKeyId, secretAccessKey: this.creds.secretAccessKey, ...(this.creds.sessionToken ? { sessionToken: this.creds.sessionToken } : {}) },
        ...(this.creds.endpoint ? { endpoint: this.creds.endpoint, forcePathStyle: true } : {}),
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000, ...validatedAgents(this.opts) },
      }) as unknown as S3Like;
    }
    return { client: this.client, sdk: this.sdk };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const { client, sdk } = await this.open();
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const page = (await client.send(new sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })).catch(storageFailure)) as {
        Contents?: { Key?: string; Size?: number }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const o of page.Contents ?? []) if (o.Key !== undefined) out.push({ key: o.Key, size: o.Size ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType?: string } | null> {
    const { client, sdk } = await this.open();
    try {
      const res = (await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }))) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> }; ContentType?: string };
      const bytes = res.Body?.transformToByteArray ? Buffer.from(await res.Body.transformToByteArray()) : Buffer.alloc(0);
      return { bytes, ...(res.ContentType ? { contentType: res.ContentType } : {}) };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return null;
      storageFailure(err);
    }
  }

  async put(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    const { client, sdk } = await this.open();
    await client.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ...(contentType ? { ContentType: contentType } : {}) })).catch(storageFailure);
  }
}

/** Tenant-owned artifact storage over S3: every key lives under `base`, so a bug cannot write elsewhere in the bucket. */
export function s3ArtifactStore(store: ObjectStorePort, base: string, label: string): ArtifactStore {
  const root = base.endsWith("/") ? base : `${base}/`;
  const safe = (key: string): string => {
    if (!/^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(key)) throw new PortabilityError("invalid_input", "An artifact key is not a usable relative path.");
    return `${root}${key}`;
  };
  return {
    label,
    put: async (key, bytes) => store.put(safe(key), bytes, "application/octet-stream"),
    get: async (key) => (await store.get(safe(key)))?.bytes ?? null,
    list: async (prefix) => (await store.list(`${root}${prefix}`)).map((o) => o.key.slice(root.length)),
  };
}
