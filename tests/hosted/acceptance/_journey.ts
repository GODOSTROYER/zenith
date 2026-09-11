/**
 * Shared helpers for the twelve-gate acceptance suite.
 *
 * This is the adversarial suite's own scaffolding, and it holds to one rule
 * that the rest of `tests/hosted/**` relaxes for its own good reasons: **no
 * double ever produces a success here.** Nothing in this file stands in for a
 * module. It opens no database, imports no application code at load time, and
 * contains no behaviour a gate could pass against. What it does is:
 *
 *  - import the real barrels *after* a test has pinned `ZENITH_DATA`
 *    (`loadHosted`), because `@/lib/env` reads that variable on first use;
 *  - build the requests a browser would send to an app host (`call`), with the
 *    Host header the middleware rewrite preserves;
 *  - walk the real launch (`signIn`): `createExchange` on the control side,
 *    the callback on the app host, and the cookie the browser is left holding;
 *  - run a real `recipe-local` publish to completion (`publish`);
 *  - turn a fixture directory into a submitted tarball (`tarballFrom`), so a
 *    gate can publish a *modified* copy of `fixtures/tracker-app` without
 *    touching the fixture on disk;
 *  - adapt Node's `http` server onto `handleGateway` (`startGatewayServer`),
 *    which is what lets a real browser — and a real `fetch` — reach the
 *    gateway over a loopback socket.
 *
 * Not a test file: vitest only collects `*.test.ts`. It also deliberately does
 * not import `vitest`, so `scripts/hosted-browser.ts` can use the server
 * adapter without dragging a test runner into a script.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { APP_SESSION_COOKIE, type HostedApp, type HostedJob } from "@/lib/hosted/contracts";
import { entriesFromDirectory, gzip, writeTar, type TarEntry } from "../../_support/tar";

/* ------------------------------ the modules ------------------------------ */

/** Every hosted barrel, imported for real. */
export interface HostedModules {
  access: typeof import("@/lib/hosted/access");
  artifacts: typeof import("@/lib/hosted/artifacts");
  authority: typeof import("@/lib/hosted/authority");
  backup: typeof import("@/lib/hosted/backup");
  build: typeof import("@/lib/hosted/build");
  config: typeof import("@/lib/hosted/config");
  contracts: typeof import("@/lib/hosted/contracts");
  data: typeof import("@/lib/hosted/data");
  events: typeof import("@/lib/hosted/events");
  gateway: typeof import("@/lib/hosted/gateway");
  health: typeof import("@/lib/hosted/health");
  quota: typeof import("@/lib/hosted/quota");
  release: typeof import("@/lib/hosted/release");
  runtime: typeof import("@/lib/hosted/runtime");
  source: typeof import("@/lib/hosted/source");
  usage: typeof import("@/lib/hosted/usage");
}

/**
 * The environment every acceptance file runs under.
 *
 * Called *after* `isolatedDataDir()` and *before* any `await import`. Nothing
 * here weakens a check: the build runner and the runtime are the real ones,
 * and `ZENITH_SECRET_KEY` exists because invitation delivery payloads are
 * sealed with it — an install without one refuses to issue an invitation,
 * which is a different test.
 */
export function acceptanceEnv(dataDir: string): void {
  process.env.ZENITH_BUILD_RUNNER = "recipe-local";
  process.env.ZENITH_RUNTIME = "local";
  process.env.ZENITH_APP_DOMAIN = "apps.localhost";
  process.env.ZENITH_APP_SCHEME = "http";
  process.env.ZENITH_CONTROL_ORIGIN = "http://localhost:3400";
  process.env.ZENITH_SECRET_KEY = "1".repeat(64);
  process.env.ZENITH_BACKUP_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.ZENITH_BACKUP_TARGET = "filesystem";
  process.env.ZENITH_BACKUP_DIR = path.join(dataDir, "off-host");
  delete process.env.ZENITH_SMTP_URL;
  delete process.env.ZENITH_SPEND_ENVELOPE_USD;
}

/** Import every hosted barrel. Dynamic: `ZENITH_DATA` must already be pinned. */
export async function loadHosted(): Promise<HostedModules> {
  const [
    access,
    artifacts,
    authority,
    backup,
    build,
    config,
    contracts,
    data,
    events,
    gateway,
    health,
    quota,
    release,
    runtime,
    source,
    usage,
  ] = await Promise.all([
    import("@/lib/hosted/access"),
    import("@/lib/hosted/artifacts"),
    import("@/lib/hosted/authority"),
    import("@/lib/hosted/backup"),
    import("@/lib/hosted/build"),
    import("@/lib/hosted/config"),
    import("@/lib/hosted/contracts"),
    import("@/lib/hosted/data"),
    import("@/lib/hosted/events"),
    import("@/lib/hosted/gateway"),
    import("@/lib/hosted/health"),
    import("@/lib/hosted/quota"),
    import("@/lib/hosted/release"),
    import("@/lib/hosted/runtime"),
    import("@/lib/hosted/source"),
    import("@/lib/hosted/usage"),
  ]);
  return {
    access,
    artifacts,
    authority,
    backup,
    build,
    config,
    contracts,
    data,
    events,
    gateway,
    health,
    quota,
    release,
    runtime,
    source,
    usage,
  };
}

/** Everything an acceptance file tears down, in the order the teardown needs. */
export async function closeHosted(m: HostedModules): Promise<void> {
  try {
    await m.gateway.resetGatewayDeps();
    await m.release.resetReleaseDeps();
    await m.release.stopHostedJobRunner();
  } catch {
    /* teardown is best effort; the data directory removal is what matters */
  }
  try {
    await m.data.closeAllAppData();
  } catch {
    /* as above */
  }
  m.authority.closeAuthority();
}

/* ------------------------------ the platform ----------------------------- */

/** The repository root, so a fixture is found whatever the test's cwd is. */
export const repoRoot = (): string => process.cwd();

/** A fixture directory by name, as `FIXTURES` in the release module resolves it. */
export const fixtureDir = (name: "tracker-app" | "minimal-app"): string =>
  name === "tracker-app"
    ? path.join(repoRoot(), "fixtures", "tracker-app")
    : path.join(repoRoot(), "fixtures", "hosted", "minimal-app");

/** The environment an acceptance record has to name. Printed by the suites. */
export function environmentNote(sqliteVersion: string): Record<string, string> {
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    sqlite: sqliteVersion,
    dataDir: process.env.ZENITH_DATA ?? "(unset)",
    buildRunner: process.env.ZENITH_BUILD_RUNNER ?? "(unset)",
    runtime: process.env.ZENITH_RUNTIME ?? "(unset)",
  };
}

/* -------------------------------- identities ------------------------------ */

/**
 * A fifth identity, on purpose.
 *
 * `IDENTITIES` in `tests/hosted/_fixtures.ts` holds the three grant holders and
 * one stranger every other suite uses. Gate 2 needs somebody who is not in that
 * cast at all — no workspace membership, no grant, nothing but an invitation —
 * so the recipient is declared here rather than appended to a shared fixture
 * the rest of the hosted suites depend on.
 */
export const RECIPIENT = {
  subject: "55555555-5555-4555-8555-555555555555",
  email: "rae.recipient@example.test",
  name: "Rae Recipient",
} as const;

/** A second outsider, for the cases that need two people with no membership. */
export const OUTSIDER = {
  subject: "66666666-6666-4666-8666-666666666666",
  email: "otto.outsider@example.test",
  name: "Otto Outsider",
} as const;

/** What a live provider check would answer for one of these. */
export const verifiedIdentity = (
  who: { subject: string; email: string },
  opts: { emailVerified?: boolean } = {}
): { subject: string; email: string; emailVerified: boolean; sessionId: string } => ({
  subject: who.subject,
  email: who.email.toLowerCase(),
  emailVerified: opts.emailVerified ?? true,
  sessionId: `provider-session-${who.subject.slice(0, 8)}`,
});

/* --------------------------------- sources -------------------------------- */

/** One file of a submitted source package, replaced or added. */
export type SourceEdit = Record<string, string | Buffer | null>;

/**
 * A gzipped tar of a fixture directory, with edits applied.
 *
 * This is how a gate publishes a *changed* copy of a committed fixture: the
 * bytes are assembled in memory, so `fixtures/tracker-app` on disk is never
 * touched and the digest still changes. A `null` edit drops the file.
 */
export function tarballFrom(root: string, edits: SourceEdit = {}): Buffer {
  const entries: TarEntry[] = entriesFromDirectory(root);
  const dropped = new Set(Object.entries(edits).filter(([, v]) => v === null).map(([k]) => k));
  const replaced = new Map(
    Object.entries(edits)
      .filter((pair): pair is [string, string | Buffer] => pair[1] !== null)
      .map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8")])
  );

  const out = entries
    .filter((entry) => !dropped.has(entry.path))
    .map((entry) => {
      const replacement = replaced.get(entry.path);
      if (replacement === undefined) return entry;
      replaced.delete(entry.path);
      return { ...entry, bytes: replacement };
    });
  // Whatever is left in `replaced` names a file the fixture does not have.
  for (const [p, bytes] of replaced) out.push({ path: p, bytes });
  return gzip(writeTar(out));
}

/** The same, base64-encoded, which is how a publish request carries it. */
export const tarballBase64 = (root: string, edits: SourceEdit = {}): string =>
  tarballFrom(root, edits).toString("base64");

/** Hostile archives are assembled from these primitives; re-exported for the gates. */
export { entriesFromDirectory, gzip, writeTar, type TarEntry };

/* --------------------------------- requests ------------------------------- */

/** The Host header a browser sends for an app under the default configuration. */
export const appHost = (slug: string, port = 3400): string => `${slug}.apps.localhost:${port}`;

/** The origin a same-site request from that app carries. */
export const appOrigin = (slug: string, port = 3400): string => `http://${appHost(slug, port)}`;

/** The control origin the default configuration serves on. */
export const CONTROL_HOST = "localhost:3400";

/** How one gateway call is described. */
export interface CallOptions {
  host?: string;
  /** Path with its leading slash, query included. Defaults to `/`. */
  path?: string;
  method?: string;
  accept?: string;
  cookie?: string;
  origin?: string;
  contentType?: string | null;
  body?: string;
  headers?: Record<string, string>;
  /** Override the route's `host` parameter, to test a Host/param mismatch. */
  paramHost?: string;
  /** Override the parsed segments, for paths a browser could not produce. */
  segments?: string[];
}

/** The request and route parameters one gateway call is made with. */
export interface GatewayCall {
  req: NextRequest;
  params: { host: string; path?: string[] };
}

/**
 * Build a call exactly as the route handler receives one: a `NextRequest`
 * whose Host header is the app host (the middleware rewrite preserves it) plus
 * `params` naming the same host and the path segments.
 */
export function call(options: CallOptions = {}): GatewayCall {
  const host = options.host ?? appHost("alpha");
  const rawPath = options.path ?? "/";
  const [pathname = "/", query] = rawPath.split("?");
  const method = (options.method ?? "GET").toUpperCase();

  const headers: Record<string, string> = { host, ...(options.headers ?? {}) };
  if (options.accept !== undefined) headers.accept = options.accept;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.contentType === undefined && options.body !== undefined)
    headers["content-type"] = "application/json";
  else if (typeof options.contentType === "string") headers["content-type"] = options.contentType;

  const req = new NextRequest(`http://${host}${pathname}${query ? `?${query}` : ""}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });

  const segments =
    options.segments ?? (pathname === "/" ? undefined : pathname.replace(/^\//, "").split("/"));
  return { req, params: { host: options.paramHost ?? host, path: segments } };
}

/** The hosted error envelope a refusal carries. */
export interface ErrorEnvelope {
  code: string;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
}

/** The refusal body, parsed. Throws if the response was not the envelope. */
export async function errorBody(res: Response): Promise<ErrorEnvelope> {
  const parsed = (await res.json()) as { error?: ErrorEnvelope };
  if (!parsed.error) throw new Error(`expected a hosted error envelope, got ${JSON.stringify(parsed)}`);
  return parsed.error;
}

/** Every header of a response, lowercased, for assertions that name both sides. */
export function headerMap(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

/** The `__Host-zenith_app` value a `set-cookie` carries, or null. */
export function cookieValueOf(res: Response): string | null {
  const setCookie = res.headers.getSetCookie().join("\n") || (res.headers.get("set-cookie") ?? "");
  const match = new RegExp(`${APP_SESSION_COOKIE}=([^;\\s]+)`).exec(setCookie);
  const value = match?.[1];
  return value === undefined || value === "" ? null : value;
}

/** The cookie header a browser would send back. */
export const cookieHeader = (value: string): string => `${APP_SESSION_COOKIE}=${value}`;

/* ------------------------------- the journey ------------------------------ */

/**
 * Walk the real launch and answer with the cookie header the browser holds.
 *
 * Control side: `createExchange` mints a single-use code bound to app, subject
 * and state. App side: the callback is followed on the app host and the
 * `Set-Cookie` it answers with is the session. No step is simulated, and a
 * failure at any of them throws with what actually happened.
 */
export async function signIn(
  m: HostedModules,
  app: HostedApp,
  subject: string,
  opts: { port?: number; state?: string } = {}
): Promise<string> {
  const port = opts.port ?? 3400;
  const state = opts.state ?? `state-${randomUUID()}`;
  const { redirect } = await m.access.createExchange(app.id, subject, state);
  const url = new URL(redirect);

  const { req, params } = call({
    host: appHost(app.slug, port),
    path: `${url.pathname}${url.search}`,
    accept: "text/html",
  });
  const res = await m.gateway.handleGateway(req, params);
  if (res.status !== 303)
    throw new Error(
      `the exchange callback answered ${res.status}, expected 303: ${await res.clone().text()}`
    );
  const value = cookieValueOf(res);
  if (!value) throw new Error("the exchange callback set no __Host-zenith_app cookie");
  return cookieHeader(value);
}

/* -------------------------------- publishing ------------------------------ */

/** What a real publish is asked for. */
export interface PublishInput {
  app: HostedApp;
  actor: string;
  /** A named fixture, or submitted bytes. */
  source:
    | { kind: "fixture"; name: string }
    | { kind: "tarball"; base64: string; filename?: string };
  jobId?: string;
}

/** Queue a publish and run it to completion. The job is returned whatever it did. */
export async function publish(m: HostedModules, input: PublishInput): Promise<HostedJob> {
  const jobId = input.jobId ?? randomUUID();
  await m.release.admitPublish({
    jobId,
    appId: input.app.id,
    workspaceId: input.app.workspaceId,
    actor: input.actor,
    source: input.source,
  });
  return m.release.runJobOnce(jobId);
}

/** The same, but a job that did not succeed throws with its recorded error. */
export async function publishOrThrow(m: HostedModules, input: PublishInput): Promise<HostedJob> {
  const job = await publish(m, input);
  if (job.status !== "succeeded")
    throw new Error(
      `publish ${job.id} ended ${job.status} in phase ${job.phase}: ${job.error ?? "no error recorded"}\n` +
        (await m.release.jobLogs(job.id)).slice(-12).join("\n")
    );
  return job;
}

/** The digest, release id and number a finished publish produced. */
export function releaseOf(job: HostedJob): { releaseId: string; number: number; digest: string } {
  return {
    releaseId: String(job.phaseData.releaseId),
    number: Number(job.phaseData.releaseNumber),
    digest: String(job.phaseData.artifactDigest),
  };
}

/* -------------------------------- artifacts ------------------------------- */

/** Where the artifact store keeps one file's bytes. Used to tamper with them. */
export const storedFilePath = (artifactDir: string, digest: string, file: string): string =>
  path.join(artifactDir, "sha256", digest, "files", ...file.split("/"));

/** Every stored file of an artifact, as bytes, for the "no secret got in" scan. */
export function readStoredFiles(artifactDir: string, digest: string): { path: string; bytes: Buffer }[] {
  const base = path.join(artifactDir, "sha256", digest, "files");
  const out: { path: string; bytes: Buffer }[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absolute, entry.name);
      if (entry.isDirectory()) walk(childAbsolute, childRelative);
      else out.push({ path: childRelative, bytes: fs.readFileSync(childAbsolute) });
    }
  };
  walk(base, "");
  return out;
}

/* ------------------------------ loopback server --------------------------- */

/** What one raw loopback call answered. */
export interface LoopbackResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  setCookie: string[];
  body: string;
}

/**
 * One HTTP call to the loopback server, with the `Host` header of an app.
 *
 * `node:http` rather than `fetch` on purpose: the connection is made to
 * `127.0.0.1` and the app host travels as a header, so nothing depends on the
 * operating system resolving `*.localhost` — which Windows, in particular,
 * does not have to do. Chrome resolves those names itself, which is why the
 * browser script can use the real hostname while this cannot.
 */
export function loopbackRequest(
  port: number,
  opts: {
    host: string;
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: {
          host: opts.host,
          ...(opts.body === undefined ? {} : { "content-length": Buffer.byteLength(opts.body) }),
          ...(opts.headers ?? {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            setCookie: response.headers["set-cookie"] ?? [],
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.on("error", reject);
    if (opts.body !== undefined) request.write(opts.body);
    request.end();
  });
}

/** The gateway entry point, as a value, so this module imports no app code. */
export type GatewayHandler = (
  req: NextRequest,
  params: { host: string; path?: string[] }
) => Promise<Response>;

/** A running loopback server in front of `handleGateway`. */
export interface GatewayServer {
  port: number;
  /** The loopback addresses it is actually bound to. */
  bound: string[];
  /** The origin of one app on this server, e.g. `http://alpha.apps.localhost:51234`. */
  origin(slug: string): string;
  /** Requests seen, in order, for a script's summary. */
  seen: { method: string; host: string; path: string; status: number }[];
  close(): Promise<void>;
}

/**
 * Put a real HTTP socket in front of `handleGateway`.
 *
 * The adapter does exactly what `src/middleware.ts` does in the running app and
 * nothing more: it keeps the Host header, splits the path into the segments the
 * route would receive, and hands both to the gateway. It adds no header, sets
 * no cookie and answers nothing itself — every status a caller sees is the
 * gateway's own.
 */
export async function startGatewayServer(
  handle: GatewayHandler,
  opts: { hosts?: string[] } = {}
): Promise<GatewayServer> {
  const seen: GatewayServer["seen"] = [];

  const listener: http.RequestListener = (incoming, outgoing) => {
    void (async () => {
      const hostHeader = (incoming.headers.host ?? "").trim();
      const rawUrl = incoming.url ?? "/";
      const url = new URL(rawUrl, `http://${hostHeader || "127.0.0.1"}`);
      const method = (incoming.method ?? "GET").toUpperCase();

      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const one of value) headers.append(name, one);
        else headers.set(name, value);
      }

      let body: Buffer | undefined;
      if (method !== "GET" && method !== "HEAD") {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        body = Buffer.concat(chunks);
      }

      const req = new NextRequest(`http://${hostHeader}${url.pathname}${url.search}`, {
        method,
        headers,
        ...(body === undefined || body.length === 0 ? {} : { body: new Uint8Array(body) }),
      });
      const segments =
        url.pathname === "/" ? undefined : url.pathname.replace(/^\//, "").split("/").map(decodeURIComponent);

      let response: Response;
      try {
        response = await handle(req, { host: hostHeader, path: segments });
      } catch (err) {
        // The gateway is documented never to throw. If it does, say so loudly
        // rather than turning it into a plausible-looking 500 page.
        outgoing.writeHead(599, { "content-type": "text/plain" });
        outgoing.end(`the gateway threw: ${err instanceof Error ? err.stack : String(err)}`);
        seen.push({ method, host: hostHeader, path: url.pathname, status: 599 });
        return;
      }

      seen.push({ method, host: hostHeader, path: url.pathname, status: response.status });
      const outHeaders: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie") return;
        outHeaders[name] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) outHeaders["set-cookie"] = cookies;

      outgoing.writeHead(response.status, outHeaders);
      if (method === "HEAD" || response.body === null) {
        outgoing.end();
        return;
      }
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })();
  };

  /**
   * One listener per loopback address, sharing one port.
   *
   * Chrome resolves `*.localhost` itself, and may pick either `127.0.0.1` or
   * `::1`. A server bound to only one of them looks down half the time, so the
   * caller may ask for both; the extra binds are best effort, because a host
   * with IPv6 disabled is a fine host to run this on.
   */
  const hosts = opts.hosts ?? ["127.0.0.1"];
  const servers: http.Server[] = [];
  const bound: string[] = [];

  const first = http.createServer(listener);
  await new Promise<void>((resolve, reject) => {
    first.once("error", reject);
    first.listen(0, hosts[0], () => resolve());
  });
  servers.push(first);
  bound.push(hosts[0]);
  const port = (first.address() as AddressInfo).port;

  for (const host of hosts.slice(1)) {
    const extra = http.createServer(listener);
    try {
      await new Promise<void>((resolve, reject) => {
        extra.once("error", reject);
        extra.listen(port, host, () => resolve());
      });
      servers.push(extra);
      bound.push(host);
    } catch {
      extra.close();
    }
  }

  return {
    port,
    bound,
    origin: (slug: string) => `http://${slug}.apps.localhost:${port}`,
    seen,
    close: async () => {
      for (const server of servers)
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
    },
  };
}
