/**
 * The whole linked-agent journey, on the file store, through the HTTP
 * handlers — the one test that fails when the *sequence* breaks rather than
 * when a module does.
 *
 *   link start → the approval screen's own lookup → approve → token exchange →
 *   the issued bearer through /api/agent/v2/tools → prepare → browser review →
 *   execute → the simulated deployment read back through GET /api/projects/:id
 *   → revoke → 401
 *
 * ## Three rules this file keeps
 *
 * 1. **Every step goes through the handler the product uses.** The approval is
 *    the POST handler the page submits to, the review is the POST handler
 *    `/integrations` submits to, and the deployment is read back through the
 *    project payload — the same object the canvas renders. Reading `db()` at
 *    the end would prove the engine ran; it would prove nothing about what a
 *    user sees.
 * 2. **No credential is faked.** The bearer that drives the control surface is
 *    the one the browser approval minted, verified by the *unmodified*
 *    `authenticate()` (`src/lib/agent-access/security.ts:63`) against the file
 *    the authority wrote. If P1's file authority ever writes a record that the
 *    shipping validator rejects, this is where it shows.
 * 3. **The identity is the shipping one over a fake provider.** The session is
 *    stubbed at `@/lib/supabase/route` — the repository's own pattern
 *    (`tests/api/slug-scoping.test.ts:31`) — and the live identity check is the
 *    real `supabaseSessionAuthority` over a fake client, so the classification
 *    from "the provider said no" to "this request is refused" is the shipping
 *    one.
 *
 * ## What it needs, and what it says when it does not have it
 *
 * The routes under `src/app/api/agent/link/**` and
 * `src/app/api/integrations/agent/link/**` belong to packet P1 and the
 * capability probe to P2. They are loaded by path at run time rather than
 * imported, so that on a branch where they are absent this suite fails with
 * *packet not integrated* and names the file, instead of a module-resolution
 * error that reads like a typo.
 *
 * `loadCredentials()` refuses on Windows by design (`security.ts:52`), so the
 * file-store journey cannot run there at all. The suite skips with that
 * sentence rather than pretending: linking against a hosted Zenith from
 * Windows works, and is a different lane (the Postgres authority).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import { tempDataDir } from "./_support/data-dir";

const DATA = tempDataDir("zenith-agent-journey-", { fast: true });

/** The one origin this journey speaks; `controlOrigin()` accepts literal loopback. */
const ORIGIN = "http://localhost:3400";

/* Environment before any application import: `@/lib/env` reads it on first use. */
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.ZENITH_AGENT_CONTROL = "1";
process.env.ZENITH_AGENT_WRITES = "1";
process.env.ZENITH_AGENT_ORIGIN = ORIGIN;
process.env.ZENITH_SECRET_KEY = "5".repeat(64);
process.env.ZENITH_AGENT_CREDENTIAL_FILE = path.join(DATA, "agent-authority", "credentials.json");
delete process.env.ZENITH_STORE;

const WINDOWS = process.platform === "win32";
if (WINDOWS)
  console.log(
    "[agent-journey] skipped on win32: loadCredentials() refuses a credential file on Windows " +
      "(src/lib/agent-access/security.ts:52), so the file-store link flow has nothing to write into. " +
      "Nothing about the journey has been verified by this run."
  );

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/supabase/route", () => ({
  sessionUserFromRequest: async () => session.user,
}));

/* ---------------------------- what exists today ---------------------------- */

const { db, resetDb, save } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
const { registerAllActions } = await import("@/lib/actions/defs");
const identity = await import("@/lib/hosted/access/identity");
const security = await import("@/lib/agent-access/security");
const { POST: toolsPost } = await import("@/app/api/agent/v2/tools/route");
const { POST: reviewPost } = await import("@/app/api/integrations/agent/review/route");
const { GET: projectGet } = await import("@/app/api/projects/[id]/route");
const { GET: deploymentGet } = await import("@/app/api/deployments/[id]/route");

/* --------------------------- what P1 and P2 bring -------------------------- */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load a module by path, or fail with the packet that owns it.
 *
 * The specifier is a variable so that TypeScript does not try to resolve it:
 * this file must typecheck on a branch where P1's routes do not exist yet, and
 * a static import would make `npm run typecheck` fail with TS2307 for a file
 * that is not late — it is early.
 */
async function fromPacket(relative: string, packet: string): Promise<Record<string, unknown>> {
  const file = path.join(REPO_ROOT, relative);
  if (!fs.existsSync(file))
    throw new Error(
      `packet not integrated: ${relative} does not exist. It is owned by packet ${packet} ` +
        "(PLAN2/WORK-GRAPH-2.md). This suite asserts the journey across packets and cannot run until it has landed."
    );
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
}

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;

interface Packets {
  linkStart: Handler;
  linkToken: Handler;
  linkLookup: Handler;
  linkApprove: Handler;
  linkRevoke: Handler;
}

let routes: Packets;

/* -------------------------------- the actors ------------------------------- */

const ADA: SessionUser = { id: "u-ada", email: "ada@zenith.test", name: "Ada" };
const WORKSPACE = "ws-journey";

const provider = {
  user: null as { id: string; email: string; email_confirmed_at: string | null } | null,
};

const signIn = (user: SessionUser | null, verified = true): void => {
  session.user = user;
  provider.user = user
    ? { id: user.id, email: user.email, email_confirmed_at: verified ? "2026-01-01T00:00:00.000Z" : null }
    : null;
};

/* ------------------------------- the plumbing ------------------------------ */

const call = (
  handler: unknown,
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string> } = {}
): Promise<Response> =>
  (handler as Handler)(
    new NextRequest(`${ORIGIN}${url}`, {
      method: init.method ?? "GET",
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {}),
      },
    }),
    { params: Promise.resolve((init.params ?? {}) as never) }
  );

/* ------------------------------ secret hygiene ----------------------------- */

/**
 * Anything shaped like an issued bearer (`za_`) or a device code (`zl_`).
 *
 * ACCEPTANCE L5 forbids either in any log line of the journey, and a vitest
 * assertion message *is* a log line — it is printed, in full, on failure, into
 * CI output that is kept. So `read()` hands back a redacted `text`: every
 * assertion message below is derived from it, and the raw body survives only
 * inside `json`, which nothing prints.
 */
const SECRET = /(za|zl)_[A-Za-z0-9_-]{43}/g;

/** Keep the three-character prefix — the shape is not the secret. */
const redact = (text: string): string =>
  text.replace(SECRET, (found) => `${found.slice(0, 3)}<redacted>`);

/** Every body this suite read, as it would be printed. Asserted clean at the end. */
const printable: string[] = [];
let redactions = 0;

/**
 * Read a response once.
 *
 * A `Response` body is a stream and can only be consumed once, so an assertion
 * message that reads `await res.text()` would eat the body the next line is
 * about to parse. Everything below goes through this.
 *
 * `text` is the redacted form and `json` is parsed from the raw one, so a
 * caller can still assert on `json.token` while nothing it can print carries a
 * secret.
 */
async function read(res: Response): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    /* a non-JSON body is reported through `text` */
  }
  const text = redact(raw);
  if (text !== raw) redactions++;
  printable.push(text);
  return { status: res.status, text, json: parsed };
}

/** What the terminal sends: a bearer, a workspace selection, no cookie. */
const asAgent = (handler: unknown, url: string, token: string, payload?: unknown): Promise<Response> =>
  call(handler, url, {
    method: payload === undefined ? "GET" : "POST",
    body: payload,
    headers: { authorization: `Bearer ${token}`, "x-zenith-workspace": WORKSPACE },
  });

/** The `{content, structuredContent}` envelope the gateway wraps every result in. */
function toolData(payload: Record<string, unknown>): Record<string, unknown> {
  const envelope = payload as { structuredContent?: { data?: Record<string, unknown> } };
  return envelope.structuredContent?.data ?? payload;
}

let projectId = "";
let environmentId = "";

/* --------------------------------- the seed -------------------------------- */

function seed(): void {
  resetDb();
  const at = new Date().toISOString();
  const data = db();
  data.workspaces.push({ id: WORKSPACE, name: "Journey", slug: "journey", createdAt: at });
  data.members.push({ id: ADA.id, workspaceId: WORKSPACE, name: ADA.name, email: ADA.email, role: "admin" });
  data.connections.push({
    id: "conn-journey",
    workspaceId: WORKSPACE,
    provider: "sandbox",
    label: "Sandbox",
    region: "local-1",
    status: "healthy",
    grantedPermissions: [],
    createdAt: at,
  });
  save();
}

beforeAll(async () => {
  if (WINDOWS) return;
  fs.mkdirSync(path.dirname(process.env.ZENITH_AGENT_CREDENTIAL_FILE!), { recursive: true, mode: 0o700 });

  routes = {
    linkStart: (await fromPacket("src/app/api/agent/link/start/route.ts", "P1")).POST as Handler,
    linkToken: (await fromPacket("src/app/api/agent/link/token/route.ts", "P1")).POST as Handler,
    linkLookup: (await fromPacket("src/app/api/integrations/agent/link/route.ts", "P1")).GET as Handler,
    linkApprove: (await fromPacket("src/app/api/integrations/agent/link/approve/route.ts", "P1")).POST as Handler,
    linkRevoke: (await fromPacket("src/app/api/integrations/agent/link/revoke/route.ts", "P1")).POST as Handler,
  };

  // The shipping authority over a fake provider: the mapping from a provider
  // answer to a refusal is the code under test, not something this file
  // re-implements.
  identity.setSessionAuthorityForTests(
    identity.supabaseSessionAuthority({
      createClient: () => ({
        auth: {
          async getUser() {
            return { data: { user: provider.user }, error: provider.user ? null : { status: 401 } };
          },
        },
      }),
    })
  );

  registerAllActions();
  seed();
  signIn(ADA);

  const actor = { type: "user" as const, id: ADA.id, name: ADA.name };
  const created = await runAction(
    "project.applyBlueprint",
    { workspaceId: WORKSPACE, actor },
    { name: "Journey App", blueprint: "api-worker" },
    { mode: "execute" }
  );
  projectId = String((created.result?.data as { projectId?: string })?.projectId ?? "");
  expect(projectId, "the journey needs a project to deploy").not.toBe("");

  const env = await runAction(
    "env.create",
    { workspaceId: WORKSPACE, projectId, actor },
    { name: "sandbox", class: "sandbox", connectionId: "conn-journey", region: "local-1" },
    { mode: "execute" }
  );
  environmentId = String((env.result?.data as { environmentId?: string })?.environmentId ?? "");
  expect(environmentId, "the journey needs an environment to deploy into").not.toBe("");
}, 60_000);

afterAll(() => {
  identity.setSessionAuthorityForTests(null);
});
/* ================================ the journey =============================== */

describe.skipIf(WINDOWS)("the linked-agent journey on the file store", () => {
  /* The device flow's secrets, carried between steps. None of them is printed
     and none of them reaches an assertion message — `read()` redacts every
     body on the way out, and the last case in this file greps what is left. */
  const flow = { deviceCode: "", userCode: "", token: "", credentialId: "" };
  let operationId = "";
  let operationDigest = "";
  let deploymentId = "";

  it("starts a link from a terminal with no credential at all", async () => {
    const res = await read(
      await call(routes.linkStart, "/api/agent/link/start", {
        method: "POST",
        body: {
          clientName: "Claude Code",
          clientVersion: "2.1.4",
          label: "journey-laptop",
          requestedScopes: ["read", "plan", "write", "logs"],
          protocolVersion: 1,
        },
      })
    );
    expect(res.status, res.text).toBe(201);

    // Asserted as a boolean, not with `toMatch`: a `toMatch` failure prints
    // the received value, and the received value is the device code.
    expect(
      /^zl_[A-Za-z0-9_-]{43}$/.test(String(res.json.deviceCode)),
      "the device code is the real secret, and has the shape the token route pins"
    ).toBe(true);
    expect(String(res.json.userCode), "8 characters from a 28-symbol alphabet, grouped 4-4").toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
    );
    expect(res.json.verificationUri).toBe(`${ORIGIN}/agent/link`);
    expect(String(res.json.verificationUriComplete)).toBe(
      `${ORIGIN}/agent/link?code=${String(res.json.userCode)}`
    );
    expect(Number(res.json.interval)).toBeGreaterThanOrEqual(1);
    expect(Number(res.json.expiresIn), "ten minutes, fixed").toBe(600);
    expect(res.json.protocolVersion).toBe(1);
    expect(Object.keys(res.json), "no credential exists yet, so none may be here").not.toContain("token");

    flow.deviceCode = String(res.json.deviceCode);
    flow.userCode = String(res.json.userCode);
  });

  it("answers the terminal's first poll with authorization_pending, not an error", async () => {
    const res = await read(
      await call(routes.linkToken, "/api/agent/link/token", {
        method: "POST",
        body: { deviceCode: flow.deviceCode, protocolVersion: 1 },
      })
    );
    // 200 so a polling client never has to tell "not yet" from a transport
    // failure (LINK-PROTOCOL.md §2.5).
    expect(res.status, res.text).toBe(200);
    expect(res.json.status).toBe("authorization_pending");
    expect(res.json.token, "nothing is issued before a human approves").toBeUndefined();
  });

  it("shows the signed-in approver the code, the unverified client name, and their own projects", async () => {
    const res = await read(
      await call(routes.linkLookup, `/api/integrations/agent/link?code=${flow.userCode}`)
    );
    expect(res.status, res.text).toBe(200);

    expect(res.json.userCode, "the page echoes the code so the human can compare it").toBe(flow.userCode);
    const client = res.json.client as Record<string, unknown>;
    expect(client.name).toBe("Claude Code");
    expect(client.unverified, "the client name is a string a program supplied, and says so").toBe(true);
    expect(res.json.status).toBe("pending");
    expect(res.json.subject).toBe(ADA.id);
    expect(res.json.maxDays, "the ceiling security.ts:38 already enforces").toBe(30);
    expect((res.json.workspaces as { id: string }[]).map((w) => w.id)).toEqual([WORKSPACE]);
    expect((res.json.projects as { id: string }[]).map((p) => p.id)).toContain(projectId);
  });

  it("refuses the lookup to a request carrying an agent credential", async () => {
    const res = await read(
      await call(routes.linkLookup, `/api/integrations/agent/link?code=${flow.userCode}`, {
        headers: { authorization: "Bearer za_0000000000000000000000000000000000000000000" },
      })
    );
    // browser.ts:15 — an agent can never stand in for the human it is asking.
    expect(res.status, res.text).toBe(403);
    expect(res.text).toContain("browser_required");
  });

  it("issues one credential for a double-submitted approval", async () => {
    const approval = {
      userCode: flow.userCode,
      approve: true,
      workspaceId: WORKSPACE,
      projectIds: [projectId],
      scopes: ["read", "plan", "write"],
      // The integrator's decision: default lifetime 30 days, ceiling 30.
      // PLAN2/WORK-GRAPH-2.md F11 still writes "default 7"; the value is sent
      // explicitly here, and the screen's own default is asserted by
      // scripts/agent-browser.ts, which is where the two get reconciled.
      days: 30,
      label: "journey-laptop",
    };
    const submit = () =>
      call(routes.linkApprove, "/api/integrations/agent/link/approve", {
        method: "POST",
        body: approval,
        headers: { origin: ORIGIN },
      });

    const [first, second] = await Promise.all([submit(), submit()]);
    const a = await read(first);
    const b = await read(second);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0], `${a.text} / ${b.text}`).toBe(200);
    expect(
      [404, 409].includes(statuses[1]),
      `the second submission must be link_code_not_found or link_code_consumed, got ${statuses[1]}`
    ).toBe(true);

    const approved = a.status === 200 ? a.json : b.json;
    expect(approved.status).toBe("approved");
    expect(String(approved.credentialId)).toMatch(/^cred_/);
    expect(approved.token, "the secret is never returned to the browser tab").toBeUndefined();
    flow.credentialId = String(approved.credentialId);
  });

  it("refuses a mutation that did not come from the Zenith origin", async () => {
    const res = await read(
      await call(routes.linkApprove, "/api/integrations/agent/link/approve", {
        method: "POST",
        body: {
          userCode: flow.userCode,
          approve: true,
          workspaceId: WORKSPACE,
          projectIds: [projectId],
          scopes: ["read"],
          days: 1,
        },
        headers: { origin: "https://evil.example" },
      })
    );
    expect(res.status, res.text).toBe(403);
  });

  it("hands the terminal its bearer exactly once", async () => {
    const res = await read(
      await call(routes.linkToken, "/api/agent/link/token", {
        method: "POST",
        body: { deviceCode: flow.deviceCode, protocolVersion: 1 },
      })
    );
    expect(res.status, res.text).toBe(200);
    expect(res.json.status).toBe("issued");
    // A boolean for the same reason as the device code above: this is the one
    // response in the journey that carries the bearer.
    expect(
      /^za_[A-Za-z0-9_-]{43}$/.test(String(res.json.token)),
      "the shape three validators already pin"
    ).toBe(true);
    expect(res.json.credentialId).toBe(flow.credentialId);
    expect(res.json.workspaceId).toBe(WORKSPACE);
    expect(res.json.projectIds).toEqual([projectId]);
    expect(res.json.scopes).toEqual(["read", "plan", "write"]);
    flow.token = String(res.json.token);

    const again = await read(
      await call(routes.linkToken, "/api/agent/link/token", {
        method: "POST",
        body: { deviceCode: flow.deviceCode, protocolVersion: 1 },
      })
    );
    expect(again.status, "410 expired_token — the exchange is single use").toBe(410);
    expect(again.text).toContain("expired_token");
  });

  it("mints a record the unmodified authenticate() accepts", async () => {
    // Not the authority's own `verify()`: the point is that the file the link
    // flow wrote is a version-1 credential file the *shipping* validator
    // reads, so the v1 reader and every other consumer keep working.
    const records = await security.loadCredentials(process.env.ZENITH_AGENT_CREDENTIAL_FILE!);
    const credential = security.authenticate(`Bearer ${flow.token}`, records);
    expect(credential.id).toBe(flow.credentialId);
    expect(credential.workspaceId).toBe(WORKSPACE);
    expect(credential.projectIds).toEqual([projectId]);
    expect(
      Date.parse(credential.expiresAt) - Date.parse(credential.issuedAt),
      "30 days is the ceiling parseCredentials enforces"
    ).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it("lists the write tools for the bearer, and refuses a request with no credential", async () => {
    const anonymous = await read(
      await call(toolsPost, "/api/agent/v2/tools", {
        method: "POST",
        body: { name: "zenith_get_capabilities", arguments: {} },
        headers: { "x-zenith-workspace": WORKSPACE },
      })
    );
    expect(anonymous.status).toBe(401);

    const res = await read(
      await asAgent(toolsPost, "/api/agent/v2/tools", flow.token, {
        name: "zenith_get_capabilities",
        arguments: {},
      })
    );
    expect(res.status, res.text).toBe(200);
    const data = toolData(res.json);
    expect(data.contractVersion).toBe(2);
    expect(data.writesEnabled, "a long-lived file store with writes enabled says so").toBe(true);
    const names = (data.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("zenith_prepare_change");
    expect(names).toContain("zenith_execute_operation");
  });

  it("prepares a change that dispatches nothing", async () => {
    const res = await read(
      await asAgent(toolsPost, "/api/agent/v2/tools", flow.token, {
        name: "zenith_prepare_change",
        arguments: {
          kind: "deployment.deploy",
          target: { workspaceId: WORKSPACE, projectId, environmentId },
          requestKey: "journey-deploy-0001",
          message: "the agent's first deploy",
        },
      })
    );
    expect(res.status, res.text).toBe(200);
    const op = toolData(res.json);
    expect(op.phase, res.text).toBe("prepared");
    expect(op.requiresBrowserApproval).toBe(true);
    expect(String(op.digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(op.reviewUrl)).toContain("/integrations?operation=");
    operationId = String(op.id);
    operationDigest = String(op.digest);

    const environments = await projectEnvironments();
    expect(
      environments.find((e) => e.id === environmentId)?.activeDeploymentId,
      "preparing a change deploys nothing"
    ).toBeUndefined();
  });

  it("refuses to execute what the browser has not approved", async () => {
    const res = await read(
      await asAgent(toolsPost, "/api/agent/v2/tools", flow.token, {
        name: "zenith_execute_operation",
        arguments: { operationId },
      })
    );
    // The gateway reports a tool failure in band; either way nothing ran.
    expect(res.text).toMatch(/approval_required|not approved|isError/i);

    const environments = await projectEnvironments();
    expect(environments.find((e) => e.id === environmentId)?.activeDeploymentId).toBeUndefined();
  });

  it("dispatches only after a human approved that exact digest", async () => {
    const wrong = await read(await browserReview({ operationId, digest: "0".repeat(64), approve: true }));
    expect(wrong.status, "the digest is what was reviewed, not a formality").toBeGreaterThanOrEqual(400);

    const review = await read(await browserReview({ operationId, digest: operationDigest, approve: true }));
    expect(review.status, review.text).toBe(200);
    expect(review.json.phase).toBe("approved");

    const res = await read(
      await asAgent(toolsPost, "/api/agent/v2/tools", flow.token, {
        name: "zenith_execute_operation",
        arguments: { operationId },
      })
    );
    expect(res.status, res.text).toBe(200);
    const result = toolData(res.json);
    expect(result.phase, res.text).toBe("succeeded");
    expect(
      JSON.stringify(result.result ?? {}),
      "a dispatch is a dispatch, and the payload keeps saying so"
    ).toContain("dispatchOnly");

    deploymentId = String(
      (result.result as { data?: { deploymentId?: string } } | undefined)?.data?.deploymentId ?? ""
    );
    expect(deploymentId, "the agent is told which deployment to watch").not.toBe("");
  });

  it("shows the deployment on the canvas payload, and runs it to a terminal status", async () => {
    // The project payload is what /p/<slug> renders. While a deploy is in
    // flight the environment holds its lease (`activeDeploymentId`), which is
    // how the canvas knows to show it; when it finishes the lease clears and
    // the revision it deployed is recorded. Reading `db()` here would prove the
    // engine ran and nothing about what a user sees.
    //
    // One watch, not two. `zenith_execute_operation` spends up to
    // `ENGINE_ADVANCE_BUDGET_MS` (6 s, control/advance.ts) advancing what it
    // dispatched, and on the file store a simulated deploy of this fixture
    // finishes inside that budget — four ticks, about a second. So the lease is
    // usually already released by the time this line runs, and waiting for it
    // *first* was waiting for something that had been and gone: the poll ran
    // out its 20 s budget and the suite failed on a deployment that had in fact
    // succeeded. The lease is recorded when it is visible and required never;
    // what is required is the settled payload, bound below to the revision this
    // deployment published, which is what makes it this deployment's payload
    // and not merely a finished one.
    let sawLease = false;
    const settled = await pollProject((environments) => {
      const environment = environments.find((e) => e.id === environmentId);
      if (!environment) return false;
      if (environment.activeDeploymentId === deploymentId) sawLease = true;
      return !environment.activeDeploymentId && Boolean(environment.deployedRevisionId);
    });
    expect(
      settled,
      "GET /api/projects/:id released the lease and recorded a revision for the dispatched deployment"
    ).toBe(true);

    const detail = await read(
      await call(deploymentGet, `/api/deployments/${deploymentId}`, { params: { id: deploymentId } })
    );
    expect(detail.status, detail.text).toBe(200);
    const deployment = detail.json.deployment as {
      status: string;
      environmentId: string;
      revisionId: string;
      steps: unknown[];
      outputs: { kind: string; simulated?: boolean }[];
    };

    // The binding: the revision the canvas now says this environment runs is
    // the revision *this* deployment published. Without it "something
    // finished" would pass.
    const environments = await projectEnvironments();
    const environment = environments.find((e) => e.id === environmentId);
    expect(deployment.environmentId).toBe(environmentId);
    expect(
      environment?.deployedRevisionId,
      sawLease
        ? "the canvas held the lease, then named the revision the deployment published"
        : "the in-request advance finished the deploy, and the canvas names the revision it published"
    ).toBe(deployment.revisionId);
    expect(deployment.status, `the deployment ended ${deployment.status}`).toBe("succeeded");
    expect(deployment.steps.length, "the timeline the canvas draws").toBeGreaterThan(0);
    expect(
      deployment.outputs.some((output) => output.kind === "url"),
      "a simulated deploy still produces the activation moment"
    ).toBe(true);
    expect(
      deployment.outputs.filter((output) => output.kind === "url").every((output) => output.simulated === true),
      "and every URL it produced is labelled simulated — phase 1 deploys nothing real"
    ).toBe(true);
  }, 90_000);

  it("stops the credential the moment it is revoked in the browser", async () => {
    const before = await read(
      await asAgent(toolsPost, "/api/agent/v2/tools", flow.token, { name: "zenith_get_context", arguments: {} })
    );
    expect(before.status, before.text).toBe(200);

    const revoked = await read(
      await call(routes.linkRevoke, "/api/integrations/agent/link/revoke", {
        method: "POST",
        body: { credentialId: flow.credentialId },
        headers: { origin: ORIGIN },
      })
    );
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.json.revoked).toBe(true);

    const after = await read(
      await asAgent(toolsPost, "/api/agent/v2/tools", flow.token, { name: "zenith_get_context", arguments: {} })
    );
    expect(after.status, "effective on the next request — there is no cache to invalidate").toBe(401);
  });

  it("printed no token and no device code anywhere in the journey", () => {
    // ACCEPTANCE L5, asserted rather than assumed. `read()` is the only way a
    // body reaches this file, and everything it returned is here; a `toMatch`
    // or a `res.text` that got its secret past the redactor would show up as a
    // hit. The counter is the other half: it fails if `read()` were bypassed
    // and this check had nothing to be clean about — the start and the token
    // exchange always carry one.
    const written = printable.join("\n");
    // The count, never the matches: a failure message that quotes the leak it
    // found has published it a second time.
    expect(
      (written.match(SECRET) ?? []).length,
      "no za_ or zl_ value in anything this suite can print"
    ).toBe(0);
    expect(redactions, "the start response and the token exchange both carry one").toBeGreaterThanOrEqual(2);
  });

  /* -------------------------------- helpers -------------------------------- */

  function browserReview(payload: unknown): Promise<Response> {
    return call(reviewPost, "/api/integrations/agent/review", {
      method: "POST",
      body: payload,
      headers: { origin: ORIGIN },
    });
  }

  async function projectEnvironments(): Promise<
    { id: string; activeDeploymentId?: string; deployedRevisionId?: string }[]
  > {
    const res = await read(
      await call(projectGet, `/api/projects/${projectId}`, { params: { id: projectId } })
    );
    expect(res.status, "the canvas payload must answer").toBe(200);
    return res.json.environments as {
      id: string;
      activeDeploymentId?: string;
      deployedRevisionId?: string;
    }[];
  }

  /**
   * Poll the project payload until a condition holds.
   *
   * What advances the deployment here is the file store's own 250 ms engine
   * ticker (`ensureEngine`, engine.ts:346), plus the bounded advance that
   * `zenith_execute_operation` already spent inside the dispatching request.
   * `nudge()` on the payload read is the mechanism on the two hosts that have
   * no ticker — serverless and Postgres — and returns immediately here
   * (cron.ts:501); CONTROL-PLANE-ON-POSTGRES.md §7.2 is about those. So this
   * poll is an observation, not a pump: it must not be the thing that makes
   * the deployment move, or the suite would be testing itself.
   */
  async function pollProject(
    holds: (environments: { id: string; activeDeploymentId?: string; deployedRevisionId?: string }[]) => boolean,
    budgetMs = 20_000
  ): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (holds(await projectEnvironments())) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});
