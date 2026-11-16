/**
 * A local fake of the Google endpoints the GCP package talks to, on
 * `node:http`. Nothing here is Google: responses are whatever a test
 * registers, shaped after the public REST references. It exists to exercise
 * OUR client code (host allowlist, status classification, bounded reads,
 * request bodies) — never to claim Google behaves this way.
 *
 * `fetchImpl` rewrites `https://<host>/<path>` to `http://127.0.0.1:<port>`
 * and passes the original host in a header so routes are keyed by
 * `<host><path>`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGcpSession, type CreateGcpSessionInput } from "@/lib/providers/gcp/credentials";
import type { GcpSessionHandle } from "@/lib/providers/gcp/types";
import type { GcpConnectionConfig } from "@/lib/credentials/types";

export interface FakeRequest {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: string;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type Handler = (req: FakeRequest) => FakeReply | Promise<FakeReply>;

export const CONNECTION: GcpConnectionConfig = {
  provider: "gcp",
  mode: "oidc_web_identity",
  projectId: "acme-prod-123456",
  workloadIdentityProvider: "projects/123456789012/locations/global/workloadIdentityPools/zenith/providers/zenith-oidc",
  observeServiceAccount: "zenith-observe@acme-prod-123456.iam.gserviceaccount.com",
  deployServiceAccount: "zenith-deploy@acme-prod-123456.iam.gserviceaccount.com",
  region: "asia-south1",
};

export const SUBJECT_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ6ZW5pdGg6d3M6d3NfMTpjb25uOmNfMSJ9.c2lnbmF0dXJlLWZvci10ZXN0cw";
export const STS_TOKEN = "ya29.fake-federated-token-for-tests-0001";
export const ACCESS_TOKEN = "ya29.fake-impersonated-access-token-0002";

export class FakeGoogle {
  readonly requests: FakeRequest[] = [];
  private routes: { method: string; key: string | RegExp; handler: Handler }[] = [];
  private server?: Server;
  port = 0;

  on(method: string, key: string | RegExp, handler: Handler | FakeReply): this {
    this.routes.push({ method, key, handler: typeof handler === "function" ? handler : () => handler });
    return this;
  }

  get(key: string | RegExp, reply: FakeReply | Handler): this {
    return this.on("GET", key, reply);
  }

  /** Register the STS and IAM Credentials exchange with the canonical tokens. */
  auth(over: { accessToken?: string; expireInSec?: number } = {}): this {
    this.on("POST", "sts.googleapis.com/v1/token", () => ({ json: { access_token: STS_TOKEN, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 } }));
    this.on("POST", /^iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/.+:generateAccessToken$/, () => ({
      json: { accessToken: over.accessToken ?? ACCESS_TOKEN, expireTime: new Date(Date.now() + (over.expireInSec ?? 900) * 1000).toISOString() },
    }));
    return this;
  }

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const host = String(req.headers["x-fake-host"] ?? "");
      const url = new URL(req.url ?? "/", "http://fake");
      let body: unknown;
      try {
        body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        body = undefined;
      }
      const fr: FakeRequest = { method: req.method ?? "GET", host, path: url.pathname, query: url.searchParams, headers: req.headers as FakeRequest["headers"], body, rawBody };
      this.requests.push(fr);
      const full = `${host}${url.pathname}`;
      const route = this.routes.find((r) => r.method === fr.method && (typeof r.key === "string" ? r.key === full : r.key.test(full)));
      const reply: FakeReply = route
        ? await route.handler(fr)
        : { status: 404, json: { error: { code: 404, status: "NOT_FOUND", message: `no fake route for ${fr.method} ${full}` } } };
      res.statusCode = reply.status ?? 200;
      for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
      if (reply.text !== undefined) res.end(reply.text);
      else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply.json ?? {}));
      }
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** `fetch` that sends every request to this server, remembering the intended host. */
  readonly fetchImpl: typeof fetch = (input, init) => {
    const u = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set("x-fake-host", u.host);
    return fetch(`http://127.0.0.1:${this.port}${u.pathname}${u.search}`, { ...init, headers, redirect: "manual" });
  };

  requestsTo(method: string, key: string | RegExp): FakeRequest[] {
    return this.requests.filter((r) => r.method === method && (typeof key === "string" ? `${r.host}${r.path}` === key : key.test(`${r.host}${r.path}`)));
  }

  /** A live session minted through the fake STS/IAM. Registers `auth()` if no STS route exists. */
  async session(over: Partial<CreateGcpSessionInput> = {}): Promise<GcpSessionHandle> {
    if (!this.routes.some((r) => r.key === "sts.googleapis.com/v1/token")) this.auth();
    return createGcpSession({
      connection: CONNECTION,
      purpose: "observe",
      mintSubjectToken: async () => SUBJECT_TOKEN,
      fetchImpl: this.fetchImpl,
      ...over,
    });
  }
}

export async function fakeGoogle(): Promise<FakeGoogle> {
  return new FakeGoogle().start();
}

