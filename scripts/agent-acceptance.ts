/**
 * The linked-agent journey, end to end, in one process, over a real socket.
 *
 * Run:
 *   npm run agent:acceptance
 *
 * `scripts/hosted-acceptance.ts` does this for hosted apps; this is its
 * counterpart for the thing a user actually asks for — *connect my coding
 * agent to Zenith and deploy something*. It is the step CI runs after the
 * suites, so a regression in the **sequence** rather than in any one module is
 * caught:
 *
 *   start → poll (pending) → the approval screen's own lookup → approve →
 *   exchange → capabilities → prepare → browser review of the exact digest →
 *   execute → the deployment watched through GET /api/projects/:id → revoke →
 *   401
 *
 * ## What is real here, and what is not
 *
 * Real: the route handlers, over a loopback HTTP server on a port this script
 * owns, so every header, body and status is the one the product produces. Real:
 * the file credential authority, writing the version-1 credential file that
 * the **unmodified** `authenticate()` then reads. Real: the action runner, the
 * engine and the `sandbox` provider, so the deployment actually runs. Real:
 * the browser identity check — `verifyRequestIdentity` does its live
 * `auth.getUser()` round trip, and the session cookie is minted by
 * `@supabase/ssr` itself rather than hand-rolled.
 *
 * Not real: **the identity provider**. A second loopback server answers
 * `GET /auth/v1/user`, and `NEXT_PUBLIC_SUPABASE_URL` points at it. That is the
 * only double in this script, it sits entirely outside Zenith, and it is
 * unavoidable: `supabaseSessionAuthority` refuses rather than admitting an
 * unverified identity (`src/lib/hosted/access/identity.ts:85`), which is
 * exactly the behaviour we want to keep. Nothing inside `src/**` is mocked,
 * stubbed or injected — in particular `setSessionAuthorityForTests` is **not**
 * called, so the authority under test is the shipping one.
 *
 * Also not real: the deployment. Phase 1 is the `sandbox` provider and every
 * URL it produces is flagged `simulated`. The script asserts that flag rather
 * than hoping the reader remembers.
 *
 * ## Windows
 *
 * `loadCredentials()` refuses a credential file on Windows by design
 * (`src/lib/agent-access/security.ts:52`), so the file-store half of this
 * journey cannot run there. The script exits **2** with that sentence — never
 * 0 — because a pass that skipped the whole journey is the one outcome worth
 * less than a failure.
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 this host cannot run it.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/* Environment first: `@/lib/env` reads ZENITH_DATA on first use, so every
   application module below is imported dynamically, after this block — and
   after the two servers have been given their ports. */
const DATA_DIR = path.join(process.cwd(), ".data-agent-acceptance");
const CREDENTIAL_FILE = path.join(DATA_DIR, "agent-authority", "credentials.json");

process.env.ZENITH_DATA = DATA_DIR;
process.env.ZENITH_FAST = "1";
process.env.ZENITH_AGENT_CONTROL = "1";
process.env.ZENITH_AGENT_WRITES = "1";
process.env.ZENITH_AGENT_CREDENTIAL_FILE = CREDENTIAL_FILE;
process.env.ZENITH_SECRET_KEY = "7".repeat(64);
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "acceptance-publishable-key";
delete process.env.ZENITH_STORE;
delete process.env.ZENITH_HOSTED_STORE;

const WORKSPACE = "ws-agent-acceptance";
const OWNER = { subject: "a1b2c3d4-0000-4000-8000-00000000ada0", email: "ada@zenith.test", name: "Ada" };

const NO_POSIX_MESSAGE =
  "the agent acceptance journey needs a POSIX credential file and this is Windows.\n" +
  "`loadCredentials()` refuses on win32 (src/lib/agent-access/security.ts:52), so the file credential\n" +
  "authority has nowhere to write. Run this on Linux or macOS — CI's `agent` job does — or link against a\n" +
  "hosted Zenith, where the Postgres credential authority is used instead. Nothing has been verified here.";

/** One line of the table this script prints. */
interface Row {
  step: string;
  ok: boolean;
  detail: string;
}

const rows: Row[] = [];

/** Record a check. Returns what it was given, so it reads inline. */
function check(step: string, ok: boolean, detail: string): boolean {
  rows.push({ step, ok, detail });
  return ok;
}

/** Record a check that must hold for the run to continue. */
function must(step: string, ok: boolean, detail: string): void {
  check(step, ok, detail);
  if (!ok) throw new Error(`${step}: ${detail}`);
}

function table(): string {
  const width = Math.max(...rows.map((row) => row.step.length), 4);
  return rows
    .map((row) => `${row.ok ? " ok  " : "FAIL "} ${row.step.padEnd(width)}  ${row.detail}`)
    .join("\n");
}

/* ------------------------- the identity provider double ------------------------- */

/** A JWT the Supabase client will decode, and `getClaims()` will validate by asking. */
function accessToken(): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = part({ alg: "HS256", typ: "JWT" });
  const payload = part({
    sub: OWNER.subject,
    email: OWNER.email,
    aud: "authenticated",
    role: "authenticated",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    user_metadata: { full_name: OWNER.name },
    app_metadata: {},
  });
  // The signature is never checked: `alg: HS256` makes auth-js fall back to
  // `getUser()` against the provider, which is the round trip this whole
  // script wants to be real. It still has to be base64url, so it is.
  return `${header}.${payload}.${Buffer.alloc(32, 9).toString("base64url")}`;
}

interface Stub {
  origin: string;
  close: () => Promise<void>;
}

/**
 * The GoTrue endpoints `@supabase/ssr` calls, and nothing else.
 *
 * `GET /auth/v1/user` is the whole contract: `getClaims()` falls back to it for
 * an HS256 token, and `verifyRequestIdentity()` calls it directly. A 401 from
 * here is the provider positively saying "this is not a signed-in caller",
 * which is the only answer that becomes a 401 rather than a 503.
 */
async function startIdentityProvider(token: string): Promise<Stub> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorized = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") === token;
    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (url.pathname === "/auth/v1/user") {
      if (!authorized) return send(401, { message: "invalid claim: missing sub claim", code: 401 });
      return send(200, {
        id: OWNER.subject,
        aud: "authenticated",
        role: "authenticated",
        email: OWNER.email,
        email_confirmed_at: "2026-01-01T00:00:00.000Z",
        user_metadata: { full_name: OWNER.name },
        app_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
    // Nothing else is served on purpose: an endpoint this script does not
    // implement is a call it did not expect, and a 404 makes that visible.
    send(404, { message: `the acceptance identity provider does not serve ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ----------------------------- the app's own socket ---------------------------- */

type Handler = (req: unknown, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface Mounted {
  method: string;
  /** `/api/projects/:id` — one dynamic segment is all this script needs. */
  pattern: string;
  handler: Handler;
}

interface AppServer {
  origin: string;
  mount: (routes: Mounted[]) => void;
  close: () => Promise<void>;
}

/**
 * A loopback server in front of the route handlers.
 *
 * Going over a socket rather than calling the handlers directly is the point:
 * `checkRequestOrigin()` reads the `host` header, `browser()` reads `origin`,
 * and `boundedBody()` reads a stream. A direct call would let this script
 * construct a request the platform never would.
 */
async function startApp(NextRequest: new (url: string, init?: RequestInit) => unknown): Promise<AppServer> {
  let routes: Mounted[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const origin = `http://localhost:${(server.address() as { port: number }).port}`;
      const url = new URL(req.url ?? "/", origin);
      const match = routes.find((route) => route.method === req.method && matches(route.pattern, url.pathname));
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "not_mounted", message: `${req.method} ${url.pathname}` } }));
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const one of value) headers.append(name, one);

      const request = new NextRequest(url.toString(), {
        method: req.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });

      try {
        const answer = await match.handler(request, {
          params: Promise.resolve(params(match.pattern, url.pathname)),
        });
        const body = Buffer.from(await answer.arrayBuffer());
        const out: Record<string, string> = {};
        answer.headers.forEach((value, name) => {
          out[name] = value;
        });
        res.writeHead(answer.status, { ...out, "content-length": body.byteLength });
        res.end(body);
      } catch (error) {
        // A handler that throws is a failure of the run, not of the socket:
        // report it as a 500 with the message so the transcript names it.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "handler_threw", message: error instanceof Error ? error.message : String(error) },
          })
        );
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://localhost:${port}`,
    mount: (next) => {
      routes = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const segments = (value: string): string[] => value.split("/").filter(Boolean);

function matches(pattern: string, pathname: string): boolean {
  const a = segments(pattern);
  const b = segments(pathname);
  return a.length === b.length && a.every((part, index) => part.startsWith(":") || part === b[index]);
}

function params(pattern: string, pathname: string): Record<string, string> {
  const a = segments(pattern);
  const b = segments(pathname);
  const out: Record<string, string> = {};
  a.forEach((part, index) => {
    if (part.startsWith(":")) out[part.slice(1)] = decodeURIComponent(b[index]);
  });
  return out;
}

/* ---------------------------------- the run ---------------------------------- */

interface Answer {
  status: number;
  text: string;
  json: Record<string, unknown>;
}

async function main(): Promise<number> {
  if (process.platform === "win32") {
    process.stderr.write(`${NO_POSIX_MESSAGE}\n`);
    return 2;
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(CREDENTIAL_FILE), { recursive: true, mode: 0o700 });

  const token = accessToken();
  const provider = await startIdentityProvider(token);
  process.env.NEXT_PUBLIC_SUPABASE_URL = provider.origin;

  /* Now, and only now, the application. */
  const { NextRequest } = await import("next/server");
  const app = await startApp(NextRequest as unknown as new (url: string, init?: RequestInit) => unknown);
  process.env.ZENITH_AGENT_ORIGIN = app.origin;

  const store = await import("@/lib/db/store");
  const { runAction } = await import("@/lib/actions/core");
  const { registerAllActions } = await import("@/lib/actions/defs");
  const security = await import("@/lib/agent-access/security");

  const linkStart = await routeModule("src/app/api/agent/link/start/route.ts", "P1");
  const linkToken = await routeModule("src/app/api/agent/link/token/route.ts", "P1");
  const linkLookup = await routeModule("src/app/api/integrations/agent/link/route.ts", "P1");
  const linkApprove = await routeModule("src/app/api/integrations/agent/link/approve/route.ts", "P1");
  const linkRevoke = await routeModule("src/app/api/integrations/agent/link/revoke/route.ts", "P1");
  const tools = await import("@/app/api/agent/v2/tools/route");
  const review = await import("@/app/api/integrations/agent/review/route");
  const project = await import("@/app/api/projects/[id]/route");
  const deployment = await import("@/app/api/deployments/[id]/route");

  app.mount([
    { method: "POST", pattern: "/api/agent/link/start", handler: linkStart.POST as Handler },
    { method: "POST", pattern: "/api/agent/link/token", handler: linkToken.POST as Handler },
    { method: "GET", pattern: "/api/integrations/agent/link", handler: linkLookup.GET as Handler },
    { method: "POST", pattern: "/api/integrations/agent/link/approve", handler: linkApprove.POST as Handler },
    { method: "POST", pattern: "/api/integrations/agent/link/revoke", handler: linkRevoke.POST as Handler },
    { method: "POST", pattern: "/api/agent/v2/tools", handler: tools.POST as unknown as Handler },
    { method: "POST", pattern: "/api/integrations/agent/review", handler: review.POST as unknown as Handler },
    { method: "GET", pattern: "/api/projects/:id", handler: project.GET as unknown as Handler },
    { method: "GET", pattern: "/api/deployments/:id", handler: deployment.GET as unknown as Handler },
  ]);

  const cookie = await sessionCookie(provider.origin, token);

  /* ------------------------------ the plumbing ----------------------------- */

  const call = async (
    method: string,
    pathname: string,
    init: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<Answer> => {
    const res = await fetch(`${app.origin}${pathname}`, {
      method,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* reported through `text` */
    }
    return { status: res.status, text, json };
  };

  /** What the signed-in browser sends: its cookie, its origin, and never a bearer. */
  const browser = (method: string, pathname: string, body?: unknown): Promise<Answer> =>
    call(method, pathname, { body, headers: { cookie, origin: app.origin } });

  /** What the terminal sends: a bearer and a workspace selection, and no cookie. */
  const agent = (name: string, args: Record<string, unknown>, bearer: string): Promise<Answer> =>
    call("POST", "/api/agent/v2/tools", {
      body: { name, arguments: args },
      headers: { authorization: `Bearer ${bearer}`, "x-zenith-workspace": WORKSPACE },
    });

  const data = (answer: Answer): Record<string, unknown> => {
    const envelope = answer.json as { structuredContent?: { data?: Record<string, unknown> } };
    return envelope.structuredContent?.data ?? answer.json;
  };

  let projectId = "";
  let environmentId = "";
  let deploymentId = "";
  let credentialId = "";
  let bearer = "";

  try {
    /* --------------------------- a seeded workspace -------------------------- */

    registerAllActions();
    store.resetDb();
    const at = new Date().toISOString();
    const db = store.db();
    db.workspaces.push({ id: WORKSPACE, name: "Acceptance", slug: "acceptance", createdAt: at });
    db.members.push({
      id: OWNER.subject,
      workspaceId: WORKSPACE,
      name: OWNER.name,
      email: OWNER.email,
      role: "admin",
    });
    db.connections.push({
      id: "conn-acceptance",
      workspaceId: WORKSPACE,
      provider: "sandbox",
      label: "Sandbox",
      region: "local-1",
      status: "healthy",
      grantedPermissions: [],
      createdAt: at,
    });
    store.save();

    const actor = { type: "user" as const, id: OWNER.subject, name: OWNER.name };
    const created = await runAction(
      "project.applyBlueprint",
      { workspaceId: WORKSPACE, actor },
      { name: "Acceptance App", blueprint: "api-worker" },
      { mode: "execute" }
    );
    projectId = String((created.result?.data as { projectId?: string })?.projectId ?? "");
    const environment = await runAction(
      "env.create",
      { workspaceId: WORKSPACE, projectId, actor },
      { name: "sandbox", class: "sandbox", connectionId: "conn-acceptance", region: "local-1" },
      { mode: "execute" }
    );
    environmentId = String((environment.result?.data as { environmentId?: string })?.environmentId ?? "");
    must(
      "workspace",
      Boolean(projectId && environmentId),
      `node ${process.version}, data ${DATA_DIR}, project ${projectId}, environment ${environmentId}`
    );
    check("origins", true, `app ${app.origin}, identity provider ${provider.origin}`);

    /* -------------------------------- 1. start ------------------------------- */

    const started = await call("POST", "/api/agent/link/start", {
      body: {
        clientName: "Claude Code",
        clientVersion: "2.1.4",
        label: "acceptance-laptop",
        requestedScopes: ["read", "plan", "write", "logs"],
        protocolVersion: 1,
      },
    });
    must("link start", started.status === 201, `HTTP ${started.status} ${started.status === 201 ? "" : started.text}`);
    const deviceCode = String(started.json.deviceCode ?? "");
    const userCode = String(started.json.userCode ?? "");
    must(
      "device flow shape",
      /^zl_[A-Za-z0-9_-]{43}$/.test(deviceCode) &&
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(userCode) &&
        started.json.verificationUriComplete === `${app.origin}/agent/link?code=${userCode}` &&
        Number(started.json.expiresIn) === 600 &&
        !("token" in started.json),
      `user code ${userCode}, expires in ${String(started.json.expiresIn)}s, no credential in the response`
    );

    /* ----------------------------- 2. still waiting -------------------------- */

    const pending = await call("POST", "/api/agent/link/token", {
      body: { deviceCode, protocolVersion: 1 },
    });
    must(
      "poll before approval",
      pending.status === 200 && pending.json.status === "authorization_pending" && !("token" in pending.json),
      `HTTP ${pending.status} ${String(pending.json.status)} — a polling client never has to guess`
    );

    /* ------------------------ 3. what the approver sees ---------------------- */

    const lookup = await browser("GET", `/api/integrations/agent/link?code=${userCode}`);
    must("approval screen data", lookup.status === 200, `HTTP ${lookup.status} ${lookup.status === 200 ? "" : lookup.text}`);
    const client = (lookup.json.client ?? {}) as Record<string, unknown>;
    must(
      "client is marked unverified",
      client.unverified === true && client.name === "Claude Code" && lookup.json.maxDays === 30,
      `"${String(client.name)}" v${String(client.version)}, unverified, ceiling ${String(lookup.json.maxDays)} days`
    );
    check(
      "the approver's own scope",
      (lookup.json.workspaces as { id: string }[] | undefined)?.some((w) => w.id === WORKSPACE) === true &&
        (lookup.json.projects as { id: string }[] | undefined)?.some((p) => p.id === projectId) === true,
      `${String((lookup.json.workspaces as unknown[] | undefined)?.length)} workspace(s), ` +
        `${String((lookup.json.projects as unknown[] | undefined)?.length)} project(s)`
    );

    const asAgentInstead = await call("GET", `/api/integrations/agent/link?code=${userCode}`, {
      headers: { authorization: "Bearer za_0000000000000000000000000000000000000000000", cookie },
    });
    must(
      "an agent cannot read the approval",
      asAgentInstead.status === 403 && asAgentInstead.text.includes("browser_required"),
      `HTTP ${asAgentInstead.status} browser_required — an agent may never stand in for the human`
    );

    const crossOrigin = await call("POST", "/api/integrations/agent/link/approve", {
      body: { userCode, approve: true, workspaceId: WORKSPACE, projectIds: [projectId], scopes: ["read"], days: 1 },
      headers: { cookie, origin: "https://evil.example" },
    });
    must(
      "cross-origin approval refused",
      crossOrigin.status === 403,
      `HTTP ${crossOrigin.status} — the CSRF check the review endpoint already uses`
    );

    /* ------------------------------- 4. approve ------------------------------ */

    const approval = {
      userCode,
      approve: true,
      workspaceId: WORKSPACE,
      projectIds: [projectId],
      scopes: ["read", "plan", "write"],
      // The integrator's decision: default lifetime 30 days, ceiling 30.
      days: 30,
      label: "acceptance-laptop",
    };
    const [first, second] = await Promise.all([
      browser("POST", "/api/integrations/agent/link/approve", approval),
      browser("POST", "/api/integrations/agent/link/approve", approval),
    ]);
    const approved = first.status === 200 ? first : second;
    const rejected = first.status === 200 ? second : first;
    must(
      "double-submitted approval issues one credential",
      approved.status === 200 && [404, 409].includes(rejected.status),
      `HTTP ${first.status} and ${second.status} — one approves, the other is already consumed`
    );
    credentialId = String(approved.json.credentialId ?? "");
    must(
      "nothing secret reaches the browser",
      credentialId.startsWith("cred_") && !("token" in approved.json),
      `${credentialId}, expiring ${String(approved.json.expiresAt)}`
    );

    const tooLong = await browser("POST", "/api/integrations/agent/link/approve", { ...approval, days: 31 });
    check(
      "31 days is refused",
      tooLong.status === 400 || tooLong.status === 404 || tooLong.status === 409,
      `HTTP ${tooLong.status} — the ceiling is 30 days and security.ts:38 enforces it a second time`
    );

    /* ------------------------------- 5. exchange ----------------------------- */

    const issued = await call("POST", "/api/agent/link/token", { body: { deviceCode, protocolVersion: 1 } });
    must("token exchange", issued.status === 200 && issued.json.status === "issued", `HTTP ${issued.status} ${issued.text.slice(0, 120)}`);
    bearer = String(issued.json.token ?? "");
    must(
      "the bearer has the shape three validators pin",
      /^za_[A-Za-z0-9_-]{43}$/.test(bearer) &&
        issued.json.credentialId === credentialId &&
        issued.json.workspaceId === WORKSPACE,
      `credential ${credentialId}, scopes ${JSON.stringify(issued.json.scopes)}, expires ${String(issued.json.expiresAt)}`
    );

    const replay = await call("POST", "/api/agent/link/token", { body: { deviceCode, protocolVersion: 1 } });
    must(
      "the exchange is single use",
      replay.status === 410 && replay.text.includes("expired_token"),
      `HTTP ${replay.status} expired_token — the secret was destroyed by the statement that returned it`
    );

    const records = await security.loadCredentials(CREDENTIAL_FILE);
    const credential = security.authenticate(`Bearer ${bearer}`, records);
    must(
      "the unmodified authenticate() accepts what the link flow wrote",
      credential.id === credentialId && credential.workspaceId === WORKSPACE,
      `version-1 file, ${records.length} record(s), sha256 digest ${createHash("sha256").update(bearer).digest("hex").slice(0, 12)}…`
    );
    check(
      "the lifetime is inside the ceiling",
      Date.parse(credential.expiresAt) - Date.parse(credential.issuedAt) <= 30 * 86_400_000,
      `${Math.round((Date.parse(credential.expiresAt) - Date.parse(credential.issuedAt)) / 86_400_000)} days`
    );

    /* ----------------------------- 6. capabilities --------------------------- */

    const capabilities = await agent("zenith_get_capabilities", {}, bearer);
    const catalog = data(capabilities);
    const toolNames = ((catalog.tools ?? []) as { name: string }[]).map((tool) => tool.name);
    must(
      "the catalog reflects the granted scopes",
      capabilities.status === 200 &&
        toolNames.includes("zenith_prepare_change") &&
        toolNames.includes("zenith_execute_operation"),
      `${toolNames.length} tools, writesEnabled=${String(catalog.writesEnabled)}, journal ${String(catalog.persistence).slice(0, 34)}…`
    );

    /* ------------------------------- 7. prepare ------------------------------ */

    const prepared = await agent(
      "zenith_prepare_change",
      {
        kind: "deployment.deploy",
        target: { workspaceId: WORKSPACE, projectId, environmentId },
        requestKey: `acceptance-${randomUUID().slice(0, 8)}`,
        message: "the agent's first deploy",
      },
      bearer
    );
    const operation = data(prepared);
    must(
      "prepare writes an intent and dispatches nothing",
      prepared.status === 200 && operation.phase === "prepared" && operation.requiresBrowserApproval === true,
      `operation ${String(operation.id)}, digest ${String(operation.digest).slice(0, 12)}…, review at ${String(operation.reviewUrl)}`
    );
    const operationId = String(operation.id);
    const digest = String(operation.digest);
    must(
      "nothing is deploying yet",
      (await activeDeployment()) === undefined,
      "GET /api/projects/:id shows no deployment on the environment"
    );

    /* -------------------------- 8. a yes in chat is not a yes ---------------- */

    const unapproved = await agent("zenith_execute_operation", { operationId }, bearer);
    must(
      "execute before approval is refused",
      /approval_required|isError|not approved/i.test(unapproved.text) && (await activeDeployment()) === undefined,
      "the server refuses; the agent cannot approve its own proposal"
    );

    const wrongDigest = await browser("POST", "/api/integrations/agent/review", {
      operationId,
      digest: "0".repeat(64),
      approve: true,
    });
    must(
      "the review binds the exact digest",
      wrongDigest.status >= 400,
      `HTTP ${wrongDigest.status} — approving a different digest approves nothing`
    );

    /* ------------------------ 9. the human approves, then it runs ------------ */

    const reviewed = await browser("POST", "/api/integrations/agent/review", { operationId, digest, approve: true });
    must("browser review", reviewed.status === 200 && reviewed.json.phase === "approved", `HTTP ${reviewed.status} ${reviewed.text.slice(0, 120)}`);

    const dispatchedAt = Date.now();
    const executed = await agent("zenith_execute_operation", { operationId }, bearer);
    const result = data(executed);
    must(
      "execute dispatches once",
      executed.status === 200 && result.phase === "succeeded",
      `operation ${operationId} is ${String(result.phase)} in ${Date.now() - dispatchedAt}ms`
    );
    deploymentId = String(
      (result.result as { data?: { deploymentId?: string } } | undefined)?.data?.deploymentId ?? ""
    );
    must(
      "the agent is told what to watch, and told not to claim success",
      Boolean(deploymentId) && JSON.stringify(result.result ?? {}).includes("dispatchOnly"),
      `deployment ${deploymentId}; the payload still says a dispatch may be awaiting execution`
    );

    /* --------------------------- 10. the canvas payload ---------------------- */

    const visibleAt = await waitFor(
      async () => (await activeDeployment()) === deploymentId,
      15_000,
      "the environment names the dispatched deployment"
    );
    check(
      "the canvas sees it",
      visibleAt >= 0,
      `GET /api/projects/:id showed the deployment ${visibleAt}ms after execute returned`
    );

    const finishedAt = await waitFor(
      async () => {
        const environments = await environmentsOf();
        const one = environments.find((e) => e.id === environmentId);
        return Boolean(one && !one.activeDeploymentId && one.deployedRevisionId);
      },
      90_000,
      "the environment released the deployment and recorded a revision"
    );
    must("the deployment reached a terminal state", finishedAt >= 0, `${finishedAt}ms of wall clock, watched through the project payload`);

    const detail = await call("GET", `/api/deployments/${deploymentId}`);
    const deployed = (detail.json.deployment ?? {}) as {
      status?: string;
      steps?: unknown[];
      outputs?: { kind: string; label: string; simulated?: boolean }[];
    };
    must(
      "it succeeded, with a timeline",
      detail.status === 200 && deployed.status === "succeeded" && (deployed.steps ?? []).length > 0,
      `${String(deployed.status)} after ${(deployed.steps ?? []).length} steps`
    );
    const urls = (deployed.outputs ?? []).filter((output) => output.kind === "url");
    must(
      "every URL is labelled simulated",
      urls.length > 0 && urls.every((output) => output.simulated === true),
      `${urls.length} URL output(s), all flagged simulated — phase 1 deploys nothing real`
    );

    const payload = await call("GET", `/api/projects/${projectId}`);
    check(
      "no credential leaks into the canvas payload",
      !/za_[A-Za-z0-9_-]{43}/.test(payload.text) && !/zl_[A-Za-z0-9_-]{43}/.test(payload.text),
      `${payload.text.length} bytes of project payload, no bearer and no device code in it`
    );

    /* ------------------------------- 11. revoke ------------------------------ */

    const before = await agent("zenith_get_context", {}, bearer);
    must("the credential still works", before.status === 200, `HTTP ${before.status}`);

    const revoked = await browser("POST", "/api/integrations/agent/link/revoke", { credentialId });
    must("revoke", revoked.status === 200 && revoked.json.revoked === true, `HTTP ${revoked.status} ${revoked.text.slice(0, 120)}`);

    const after = await agent("zenith_get_context", {}, bearer);
    must(
      "the next request is refused",
      after.status === 401,
      `HTTP ${after.status} — revocation is effective on the next request; there is no cache to invalidate`
    );
  } catch (error) {
    check("the journey ran to the end", false, error instanceof Error ? error.message : String(error));
  } finally {
    await app.close();
    await provider.close();
  }

  const failed = rows.filter((row) => !row.ok);
  process.stdout.write(
    `\nAgent acceptance journey — workspace ${WORKSPACE}, credential ${credentialId || "(none issued)"}\n\n${table()}\n\n`
  );
  process.stdout.write(
    failed.length === 0
      ? `PASS — ${rows.length} checks, link through revoke, one identity-provider double and no other.\n`
      : `FAIL — ${failed.length} of ${rows.length} checks failed: ${failed.map((row) => row.step).join(", ")}\n`
  );
  return failed.length === 0 ? 0 : 1;

  /* -------------------------------- helpers -------------------------------- */

  async function environmentsOf(): Promise<
    { id: string; activeDeploymentId?: string; deployedRevisionId?: string }[]
  > {
    const answer = await call("GET", `/api/projects/${projectId}`);
    if (answer.status !== 200) throw new Error(`GET /api/projects/:id answered ${answer.status}: ${answer.text.slice(0, 200)}`);
    return (answer.json.environments ?? []) as {
      id: string;
      activeDeploymentId?: string;
      deployedRevisionId?: string;
    }[];
  }

  async function activeDeployment(): Promise<string | undefined> {
    return (await environmentsOf()).find((one) => one.id === environmentId)?.activeDeploymentId;
  }

  /**
   * Poll until a condition holds, answering with how long it took.
   *
   * Polling the project payload is the mechanism and not an artefact: every
   * read calls `nudge()`, which is what advances a deployment on a host with no
   * ticker (CONTROL-PLANE-ON-POSTGRES.md §7.2).
   */
  async function waitFor(holds: () => Promise<boolean>, budgetMs: number, what: string): Promise<number> {
    const started = Date.now();
    for (;;) {
      if (await holds()) return Date.now() - started;
      if (Date.now() - started > budgetMs) throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/**
 * Load one of packet P1's route modules by path.
 *
 * By path rather than by import so that this file typechecks on a branch where
 * P1 has not landed: a static import would make `npm run typecheck` fail for a
 * file that is early rather than wrong. The failure it raises instead names the
 * packet that owns the missing route.
 */
async function routeModule(relative: string, packet: string): Promise<Record<string, unknown>> {
  const { pathToFileURL } = await import("node:url");
  const file = path.resolve(process.cwd(), relative);
  if (!fs.existsSync(file))
    throw new Error(
      `packet not integrated: ${relative} does not exist (owned by packet ${packet}, PLAN2/WORK-GRAPH-2.md). ` +
        "This script drives the journey across packets and cannot run until it has landed."
    );
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

/**
 * A real Supabase session cookie, minted by `@supabase/ssr` itself.
 *
 * Hand-rolling the cookie would mean hard-coding a storage key and an encoding
 * that the library owns and is free to change; letting the library write it
 * means the name and the format are whatever the application's own client will
 * look for.
 */
async function sessionCookie(origin: string, token: string): Promise<string> {
  const { createServerClient } = await import("@supabase/ssr");
  const jar = new Map<string, string>();
  const client = createServerClient(origin, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: token, refresh_token: "acceptance-refresh" });
  if (error) throw new Error(`the acceptance session could not be established: ${error.message}`);
  if (jar.size === 0) throw new Error("@supabase/ssr wrote no session cookie; the journey has no signed-in browser");
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(
      `agent-acceptance failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
