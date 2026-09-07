/**
 * Fixtures for the gateway tests. Not a test file — vitest collects `*.test.ts`.
 *
 * Two rules keep these honest:
 *
 *  - Nothing here is a mock of the thing under test. The artifact store, the
 *    authority and the tracker data store are all real; only the sibling
 *    workstreams the gateway *calls* (access W5, quota and events W8) are
 *    doubled, through the seam the gateway owns.
 *  - Every double behaves like the contract it stands in for, including its
 *    refusals — a `readJsonBody` that never throws `body_too_large` would make
 *    the 413 test prove nothing.
 *
 * This module imports only `next/server` and the pure contracts, so it is safe
 * to import statically above a test's `isolatedDataDir()` call.
 *
 * Workstream W6 (hosted R3).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  APP_SESSION_COOKIE,
  HostedError,
  RECIPE_V1,
  type AppGrant,
  type AppRole,
  type AppSession,
  type AppState,
  type ArtifactProvenance,
  type HostedApp,
  type QuotaCounter,
  type Release,
} from "@/lib/hosted/contracts";
import type { Authority } from "@/lib/hosted/authority";

/** The control origin the default configuration serves on, and the port app hosts carry. */
export const CONTROL_ORIGIN = "http://localhost:3400";

/** The host header an app's browser sends under the default configuration. */
export const appHost = (slug: string): string => `${slug}.apps.localhost:3400`;

/** The origin a same-site request from that app carries. */
export const appOrigin = (slug: string): string => `http://${appHost(slug)}`;

/* -------------------------------- artifacts ------------------------------- */

/** The three files of the fixture build: a page, a hashed script, an unhashed image. */
export const BUILT_FILES = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Equipment</title></head>' +
    '<body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>\n',
  "assets/app-abc123.js": 'console.log("equipment tracker");\nexport const build = "abc123";\n',
  "assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n',
} as const;

/** Write the fixture build tree under `root` and answer with the directory. */
export function writeBuiltTree(root: string, name = "build"): string {
  const dir = path.join(root, name);
  for (const [relative, contents] of Object.entries(BUILT_FILES)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return dir;
}

/** Provenance good enough for the artifact store; W2's builder writes the real thing. */
export function provenance(jobId: string): ArtifactProvenance {
  return {
    sourceDigest: "0".repeat(64),
    sourceKind: "directory",
    jobId,
    recipe: RECIPE_V1,
    contractVersion: 1,
    schemaVersion: 1,
    builtBy: "recipe-local",
    buildBoundary: "test fixture: no build ran",
    builtAt: new Date("2026-09-01T09:00:00.000Z").toISOString(),
  };
}

/* --------------------------------- requests ------------------------------- */

/** How one gateway call is described. Everything has a sensible default. */
export interface CallOptions {
  /** Defaults to `alpha.apps.localhost:3400`. */
  host?: string;
  /** Request path with its leading slash, query included. Defaults to `/`. */
  path?: string;
  method?: string;
  /** `Accept`. Pass `"text/html"` for a navigation, the default is a program call. */
  accept?: string;
  cookie?: string;
  origin?: string;
  contentType?: string | null;
  body?: string;
  headers?: Record<string, string>;
  /** Override the route's `host` parameter, to test a Host/param mismatch. */
  paramHost?: string;
  /** Override the parsed segments, to test paths a browser could not produce. */
  segments?: string[];
}

/** The request and the route parameters one call is made with. */
export interface GatewayCall {
  req: NextRequest;
  params: { host: string; path?: string[] };
}

/**
 * Build a call exactly as the route handler receives one: a `NextRequest`
 * whose Host header is the app host (the middleware rewrite preserves it) and
 * `params` naming the same host plus the path segments.
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

/** The cookie header carrying an app session value. */
export const sessionCookie = (value: string): string => `${APP_SESSION_COOKIE}=${value}`;

/* --------------------------------- doubles -------------------------------- */

/** A session and grant pair a cookie value resolves to. */
export interface ResolvedSession {
  session: AppSession;
  grant: AppGrant;
}

/** Build a plausible session + grant for an app, as W5's access module would. */
export function resolved(
  app: { id: string },
  opts: { subject: string; email: string; role: AppRole; sessionId?: string; expiresAt?: string }
): ResolvedSession {
  const sessionId = opts.sessionId ?? `session-${opts.subject.slice(0, 8)}-${app.id}`;
  const now = new Date("2026-09-07T09:00:00.000Z").toISOString();
  const expiresAt = opts.expiresAt ?? new Date("2026-09-07T21:00:00.000Z").toISOString();
  return {
    session: {
      id: sessionId,
      appId: app.id,
      subject: opts.subject,
      grantId: `grant-${opts.subject.slice(0, 8)}-${app.id}`,
      createdAt: now,
      expiresAt,
    },
    grant: {
      id: `grant-${opts.subject.slice(0, 8)}-${app.id}`,
      appId: app.id,
      subject: opts.subject,
      email: opts.email,
      role: opts.role,
      state: "active",
      grantedBy: opts.subject,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** What the doubles recorded, for a test to assert on. */
export interface DoubleState {
  /** cookie value → what the access module would resolve it to, per app id. */
  sessions: Map<string, ResolvedSession>;
  /** Every `recordEvent` call, in order. */
  events: { event: string; outcome?: string; logicalId?: string; subject?: string }[];
  /** Every app id `admitRequest` was called for, in order. */
  counted: string[];
  /** Set false to make the quota refuse. */
  quotaAllowed: boolean;
  quotaLimit: number;
  /** Exchange codes the callback double will accept. */
  exchanges: Map<string, { state: string; appId: string; cookieValue: string; expiresAt: string }>;
  /** Cookie values `terminateAppSession` was called with. */
  terminated: string[];
}

/** The doubles, and the state they record into. */
export interface Doubles {
  state: DoubleState;
  deps: {
    resolveAppSession: (cookieValue: string, appId: string) => ResolvedSession | null;
    redeemExchange: (
      code: string,
      opts: { appId: string; state: string }
    ) => { cookieValue: string; session: AppSession; grant: AppGrant };
    appSessionCookie: (value: string, expiresAt: string) => string;
    clearAppSessionCookie: () => string;
    terminateAppSession: (cookieValue: string, reason: string) => boolean;
    admitRequest: (
      appId: string,
      opts?: { now?: Date; limit?: number }
    ) => { allowed: boolean; counter: QuotaCounter; limit: number };
    readJsonBody: (req: Request, maxBytes?: number) => Promise<unknown>;
    recordEvent: (input: {
      event: string;
      outcome?: string;
      logicalId?: string;
      subject?: string;
    }) => boolean;
  };
}

/**
 * Doubles for the sibling workstreams the gateway calls.
 *
 * They are not permissive stand-ins: `resolveAppSession` answers null for a
 * cookie minted against another app (which is exactly the case the sibling-app
 * test needs), and `readJsonBody` enforces the byte cap it is given.
 */
export function makeDoubles(): Doubles {
  const state: DoubleState = {
    sessions: new Map(),
    events: [],
    counted: [],
    quotaAllowed: true,
    quotaLimit: 10_000,
    exchanges: new Map(),
    terminated: [],
  };

  return {
    state,
    deps: {
      resolveAppSession(cookieValue, appId) {
        const found = state.sessions.get(cookieValue);
        // A live session for another app is not a session here. The gateway
        // must not be able to tell the two cases apart either.
        if (!found || found.session.appId !== appId) return null;
        return found;
      },

      redeemExchange(code, opts) {
        const exchange = state.exchanges.get(code);
        if (!exchange)
          throw new HostedError("not_found", "That sign-in link has already been used, or it expired.", {
            fix: "Open the app again from your Zenith apps page.",
          });
        if (exchange.appId !== opts.appId || exchange.state !== opts.state)
          throw new HostedError("forbidden", "That sign-in link was not issued for this app.", {
            fix: "Open the app from your Zenith apps page.",
          });
        state.exchanges.delete(code);
        const pair = resolved(
          { id: opts.appId },
          { subject: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", role: "owner" }
        );
        state.sessions.set(exchange.cookieValue, pair);
        return { cookieValue: exchange.cookieValue, session: pair.session, grant: pair.grant };
      },

      appSessionCookie(value, expiresAt) {
        return `${APP_SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
      },

      clearAppSessionCookie() {
        return `${APP_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
      },

      terminateAppSession(cookieValue) {
        state.terminated.push(cookieValue);
        return state.sessions.delete(cookieValue);
      },

      admitRequest(appId) {
        state.counted.push(appId);
        const counter: QuotaCounter = {
          appId,
          day: "2026-09-07",
          requests: state.counted.filter((id) => id === appId).length,
          denied: 0,
        };
        return { allowed: state.quotaAllowed, counter, limit: state.quotaLimit };
      },

      async readJsonBody(req, maxBytes = 1_048_576) {
        const raw = await req.text();
        if (Buffer.byteLength(raw, "utf8") > maxBytes)
          throw new HostedError("body_too_large", "That change is larger than one request may carry.", {
            fix: `Requests are limited to ${maxBytes} bytes.`,
          });
        try {
          return JSON.parse(raw || "{}") as unknown;
        } catch {
          throw new HostedError("invalid_input", "That request body was not valid JSON.", {
            fix: "Send a JSON object.",
          });
        }
      },

      recordEvent(input) {
        state.events.push(input);
        return true;
      },
    },
  };
}

/** The response body, parsed as the hosted error envelope. */
export async function errorBody(
  res: Response
): Promise<{ code: string; message: string; fix?: string; details?: Record<string, unknown> }> {
  const parsed = (await res.json()) as { error: { code: string; message: string; fix?: string; details?: Record<string, unknown> } };
  return parsed.error;
}

/** Assert-friendly view of the headers a test cares about. */
export const headerMap = (res: Response): Record<string, string> => {
  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
};

/** A minimal `HostedApp` shape for tests that never touch the authority. */
export const fakeApp = (overrides: Partial<HostedApp> = {}): HostedApp => ({
  id: "app-fake",
  workspaceId: "ws-one",
  slug: "alpha",
  name: "Alpha equipment tracker",
  contractVersion: 1,
  schemaVersion: 1,
  state: "active",
  createdBy: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
  activeReleaseId: null,
  activeFence: 0,
  runtime: "local",
  ...overrides,
});

/* --------------------------------- seeding -------------------------------- */

/**
 * Rows the gateway reads. These go through the real repositories in real
 * transactions; only the `Authority` type is imported here, so this module
 * still opens nothing when it is loaded.
 */
export function seedApp(
  a: Authority,
  opts: { slug: string; workspaceId?: string; state?: AppState; name?: string }
): HostedApp {
  return a.tx(() =>
    a.repos.apps.insert({
      id: randomUUID(),
      workspaceId: opts.workspaceId ?? "ws-one",
      slug: opts.slug,
      name: opts.name ?? `${opts.slug} equipment tracker`,
      createdBy: "11111111-1111-4111-8111-111111111111",
      runtime: "local",
      state: opts.state ?? "active",
    })
  );
}

/** Record an artifact row for a digest the artifact store already holds. */
export function seedArtifactRow(a: Authority, digest: string, bytes: number, files: number): void {
  a.tx(() =>
    a.repos.artifacts.insert({
      digest,
      byteSize: bytes,
      fileCount: files,
      provenance: provenance(`job-${digest.slice(0, 8)}`),
    })
  );
}

/** Insert an active release and move the app's durable pointer at it. */
export function seedActiveRelease(a: Authority, app: HostedApp, digest: string): Release {
  const release = a.tx(() =>
    a.repos.releases.insert({
      id: randomUUID(),
      appId: app.id,
      number: a.repos.releases.nextNumber(app.id),
      artifactDigest: digest,
      jobId: randomUUID(),
      runtime: "local",
      status: "active",
    })
  );
  const moved = a.tx(() => a.repos.apps.setActiveRelease(app.id, release.id, app.activeFence));
  if (!moved) throw new Error("the fixture could not move the app's active-release pointer");
  return release;
}
