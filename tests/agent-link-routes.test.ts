/**
 * The link endpoints as wire contracts: the exact JSON, the exact status codes
 * and the exact error codes LINK-PROTOCOL §2 and §10 specify, because a plugin
 * in another repository is written against them and cannot be changed by
 * editing this one.
 *
 * The authority is a fake in-memory one here, deliberately. What these tests
 * are about is the transport: validation, ordering of the rechecks, which
 * refusal carries which status, and the two promises that are easy to break by
 * accident — that no secret ever reaches a URL, and that an agent's own
 * credential cannot approve anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ZENITH_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
process.env.ZENITH_AGENT_CONTROL = "1";
process.env.ZENITH_AGENT_ORIGIN = "https://zenith.test";
const ORIGIN = "https://zenith.test";

const state = vi.hoisted(() => ({
  /** what the fake authority answers, per test */
  ready: true as boolean | string,
  started: [] as Record<string, unknown>[],
  link: undefined as Record<string, unknown> | undefined,
  exchange: { status: "authorization_pending", interval: 5 } as Record<string, unknown>,
  approved: undefined as Record<string, unknown> | undefined,
  denied: true,
  revoked: true,
  credentials: [] as Record<string, unknown>[],
  limited: false,
  /** every rate-limit scope asked about, in order */
  limits: [] as string[],
  approveInput: undefined as Record<string, unknown> | undefined,
  revokeInput: undefined as unknown[] | undefined,
  /** the signed-in browser */
  identity: { subject: "member_1", emailVerified: true },
  role: "editor" as "admin" | "editor" | "viewer",
  /** the product store; rebuilt before every test so a created workspace does not leak */
  data: undefined as unknown as {
    workspaces: Record<string, unknown>[];
    members: Record<string, unknown>[];
    projects: Record<string, unknown>[];
    environments: Record<string, unknown>[];
    connections: Record<string, unknown>[];
  },
  /** the workspace the browser cookie selects */
  cookieWorkspace: "ws_1",
}));

const freshData = () => ({
  workspaces: [
    { id: "ws_1", name: "Acme", slug: "acme" },
    { id: "ws_2", name: "Other", slug: "other" },
    { id: "ws_3", name: "Private", slug: "private" },
  ],
  members: [
    {
      id: "member_1",
      workspaceId: "ws_1",
      name: "Mika",
      email: "m@example.com",
      get role() {
        return state.role;
      },
    },
    { id: "member_1", workspaceId: "ws_2", name: "Mika", email: "m@example.com", role: "admin" },
    { id: "member_2", workspaceId: "ws_1", name: "Ola", email: "o@example.com", role: "admin" },
    { id: "member_2", workspaceId: "ws_3", name: "Ola", email: "o@example.com", role: "admin" },
  ],
  projects: [
    { id: "prj_a", workspaceId: "ws_1", name: "Storefront" },
    { id: "prj_z", workspaceId: "ws_2", name: "Elsewhere" },
  ],
  environments: [{ id: "env_x", projectId: "prj_a", name: "prod" }],
  connections: [],
});

vi.mock("@/lib/agent-access/authority", async () => {
  const { AgentError } = await import("../src/lib/agent-access/security");
  const authority = {
    kind: "file" as const,
    ready: async () => {},
    verify: async () => {
      throw new AgentError("unauthorized", "no", 401);
    },
    touch: async () => {},
    startLink: async (start: Record<string, unknown>) => {
      state.started.push(start);
    },
    linkByUserCode: async () => state.link,
    approveLink: async (input: Record<string, unknown>) => {
      state.approveInput = input;
      if (!state.approved) throw new AgentError("link_code_not_found", "gone", 404);
      return state.approved;
    },
    denyLink: async () => state.denied,
    exchange: async () => state.exchange,
    listCredentials: async () => state.credentials,
    revokeCredential: async (...args: unknown[]) => {
      state.revokeInput = args;
      return state.revoked;
    },
    expireLinks: async () => 0,
  };
  const require = async () => {
    if (state.ready !== true)
      throw new AgentError("link_unavailable", typeof state.ready === "string" ? state.ready : "off", 503);
    return authority;
  };
  return {
    credentialAuthority: () => authority,
    requireLinkAuthority: require,
    requireCredentialAuthority: require,
    linkRateLimit: async (scope: string) => {
      state.limits.push(scope);
      if (state.limited) throw new AgentError("rate_limited", "Request limit reached; retry later.", 429);
    },
  };
});

vi.mock("@/lib/server/request", () => ({
  route: (a: unknown, b?: unknown) => (typeof a === "function" ? a : b),
  currentRequest: () => ({
    user: { id: state.identity.subject, name: "Mika", email: "m@example.com" },
    workspace: state.data.workspaces.find((w) => w.id === state.cookieWorkspace),
  }),
  intParam: () => 0,
}));

// POST /api/workspace imports the request barrel; give it the same fake request
// state, and the real ApiError/json, without loading the whole server layer.
vi.mock("@/lib/server/context", async () => {
  const errors = await import("../src/lib/server/errors");
  return {
    ApiError: errors.ApiError,
    json: errors.json,
    WORKSPACE_COOKIE: "zenith-workspace",
    route: (a: unknown, b?: unknown) => (typeof a === "function" ? a : b),
    currentRequest: () => ({
      user: { id: state.identity.subject, name: "Mika", email: "m@example.com" },
      workspace: state.data.workspaces.find((w) => w.id === state.cookieWorkspace),
    }),
  };
});

vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));

vi.mock("@/lib/hosted/access/identity", () => ({
  verifyRequestIdentity: async () => state.identity,
}));

vi.mock("@/lib/db/store", () => ({
  isPostgres: () => false,
  db: () => state.data,
  save: () => {},
}));

vi.mock("@/lib/agent-access/control/runtime", () => ({
  control: () => ({ journal: { grants: () => [], reviewQueue: () => [] } }),
  requireControl: () => {},
  operationView: (op: unknown) => op,
  reviewOperation: async () => ({}),
  inAgentScope: async (_who: unknown, fn: () => Promise<unknown>) => fn(),
  resolveTarget: () => ({}),
}));

const { POST: start } = await import("../src/app/api/agent/link/start/route");
const { POST: token } = await import("../src/app/api/agent/link/token/route");
const { POST: createWorkspace } = await import("../src/app/api/workspace/route");
const handlers = await import("../src/lib/agent-access/control/browser");

/**
 * `route()` hands Next.js a `(request, context)` pair; the handlers under test
 * read only the request. One wrapper, so every call site below reads as the
 * HTTP call it is.
 */
const call =
  (handler: (req: never, ctx: never) => Promise<Response>) =>
  (request: Request): Promise<Response> =>
    handler(request as never, { params: Promise.resolve({}) } as never);
const browserGet = call(handlers.browserGet);
const browserLinkGet = call(handlers.browserLinkGet);
const browserLinkApprove = call(handlers.browserLinkApprove);
const browserLinkRevoke = call(handlers.browserLinkRevoke);

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** A signed-in browser request from the configured origin. */
const browserPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  post(url, body, { origin: ORIGIN, ...headers });

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

const body = async (response: Response) => (await response.json()) as Record<string, never>;

const pending = {
  userCode: "",
  state: "pending",
  clientName: "Claude Code",
  clientVersion: "2.1.4",
  label: "laptop",
  requestedScopes: ["read", "plan", "write"],
  createdAt: "2026-09-16T09:12:03.114Z",
  expiresAt: "2026-09-16T09:22:03.114Z",
};

beforeEach(() => {
  state.ready = true;
  state.started = [];
  state.link = { ...pending };
  state.exchange = { status: "authorization_pending", interval: 5 };
  state.approved = { credentialId: "cred_1", expiresAt: "2026-10-16T09:14:40.000Z" };
  state.denied = true;
  state.revoked = true;
  state.credentials = [];
  state.limited = false;
  state.limits = [];
  state.approveInput = undefined;
  state.revokeInput = undefined;
  state.identity = { subject: "member_1", emailVerified: true };
  state.role = "editor";
  state.data = freshData();
  state.cookieWorkspace = "ws_1";
});

describe("POST /api/agent/link/start", () => {
  it("answers the documented 201 and keeps every secret out of the URL", async () => {
    const response = await start(post(`${ORIGIN}/api/agent/link/start`, { clientName: "Claude Code", clientVersion: "2.1.4", label: "laptop", requestedScopes: ["read", "plan", "write"], protocolVersion: 1 }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("set-cookie")).toBe(false);
    const data = await body(response);
    expect(data).toMatchObject({
      verificationUri: `${ORIGIN}/agent/link`,
      interval: 5,
      expiresIn: 600,
      protocolVersion: 1,
    });
    expect(String(data.deviceCode)).toMatch(/^zl_[A-Za-z0-9_-]{43}$/);
    expect(String(data.userCode)).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    // The user code may be in the verification URL; the device code may not.
    expect(String(data.verificationUriComplete)).toContain(encodeURIComponent(String(data.userCode)));
    expect(String(data.verificationUriComplete)).not.toContain(String(data.deviceCode));
    // What was stored is the digest of each, never either code.
    const stored = JSON.stringify(state.started[0]);
    expect(stored).not.toContain(String(data.deviceCode));
    expect(stored).not.toContain(String(data.userCode).replace("-", ""));
    expect(state.started[0]).toMatchObject({ clientName: "Claude Code", label: "laptop" });
  });

  it("refuses a body that is not JSON, is malformed, or names an impossible client", async () => {
    const wrongType = await start(
      new Request(`${ORIGIN}/api/agent/link/start`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      })
    );
    expect(wrongType.status).toBe(415);
    expect((await body(wrongType)).error).toMatchObject({ code: "media_type" });
    for (const bad of [{}, { clientName: "" }, { clientName: "x".repeat(61) }, { clientName: "ok", protocolVersion: 3 }]) {
      const response = await start(post(`${ORIGIN}/api/agent/link/start`, bad));
      expect(response.status).toBe(400);
      expect((await body(response)).error).toMatchObject({ code: "invalid_request" });
    }
  });

  it("answers 503 link_unavailable when nothing can issue a credential", async () => {
    state.ready = "Agent linking is not enabled on this server.";
    const response = await start(post(`${ORIGIN}/api/agent/link/start`, { clientName: "Codex" }));
    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: "link_unavailable" });
  });

  it("throttles per client address, on two windows, with retry-after", async () => {
    state.limited = true;
    const response = await start(post(`${ORIGIN}/api/agent/link/start`, { clientName: "Codex" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect((await body(response)).error).toMatchObject({ code: "rate_limited" });
    state.limited = false;
    await start(post(`${ORIGIN}/api/agent/link/start`, { clientName: "Codex" }));
    expect(state.limits).toContain("link.start");
    expect(state.limits).toContain("link.start.hour");
  });
});

describe("POST /api/agent/link/token", () => {
  const deviceCode = `zl_${"A".repeat(43)}`;

  it("keeps waiting and pacing inside a 200, so a poller never guesses", async () => {
    for (const status of ["authorization_pending", "slow_down"]) {
      state.exchange = { status, interval: status === "slow_down" ? 10 : 5 };
      const response = await token(post(`${ORIGIN}/api/agent/link/token`, { deviceCode, protocolVersion: 1 }));
      expect(response.status).toBe(200);
      expect(await body(response)).toEqual({ status, interval: status === "slow_down" ? 10 : 5 });
    }
  });

  it("hands the bearer over exactly once, with its whole scope", async () => {
    state.exchange = {
      status: "issued",
      token: `za_${"B".repeat(43)}`,
      credential: {
        id: "cred_1",
        workspaceId: "ws_1",
        projectIds: ["prj_a"],
        environmentIds: undefined,
        scopes: ["read", "plan", "write"],
        expiresAt: "2026-10-16T09:14:40.000Z",
        label: "laptop",
      },
    };
    const response = await token(post(`${ORIGIN}/api/agent/link/token`, { deviceCode }));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      status: "issued",
      token: `za_${"B".repeat(43)}`,
      credentialId: "cred_1",
      origin: ORIGIN,
      workspaceId: "ws_1",
      projectIds: ["prj_a"],
      environmentIds: null,
      scopes: ["read", "plan", "write"],
      expiresAt: "2026-10-16T09:14:40.000Z",
      label: "laptop",
      // Additive in protocol 2; a protocol-1 poller ignores both.
      allProjects: false,
      protocolVersion: 1,
    });
  });

  it("gives denial, expiry and an unknown code their real statuses", async () => {
    for (const [status, code, http] of [
      ["denied", "access_denied", 403],
      ["expired", "expired_token", 410],
      ["unknown", "invalid_device_code", 404],
    ] as const) {
      state.exchange = { status };
      const response = await token(post(`${ORIGIN}/api/agent/link/token`, { deviceCode }));
      expect(response.status).toBe(http);
      expect((await body(response)).error).toMatchObject({ code });
    }
  });

  it("refuses anything that is not a device code this server issued", async () => {
    for (const bad of [{}, { deviceCode: "nope" }, { deviceCode }, { deviceCode, protocolVersion: 9 }]) {
      const response = await token(post(`${ORIGIN}/api/agent/link/token`, bad));
      if ("protocolVersion" in bad || !("deviceCode" in bad) || bad.deviceCode !== deviceCode)
        expect(response.status).toBe(400);
      else expect(response.status).toBe(200);
    }
  });
});

describe("GET /api/integrations/agent/link", () => {
  it("describes the request, marks the client's own words unverified, and lists what can be chosen", async () => {
    const response = await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`));
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(data).toMatchObject({
      userCode: "AAAA-2222",
      status: "pending",
      subject: "member_1",
      startedAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      maxDays: 30,
    });
    expect(data.client).toEqual({ name: "Claude Code", version: "2.1.4", label: "laptop", unverified: true });
    // Every workspace this person is a live member of, the browser's own first.
    expect(data.workspaces).toEqual([
      { id: "ws_1", name: "Acme", role: "editor" },
      { id: "ws_2", name: "Other", role: "admin" },
    ]);
    expect(data.projects).toHaveLength(2);
    expect(state.limits).toContain("link.lookup");
  });

  it("answers the same 404 for a malformed, unknown, expired or consumed code", async () => {
    for (const setup of [
      () => undefined,
      () => ({ ...pending, state: "expired" }),
      () => ({ ...pending, state: "consumed" }),
      () => ({ ...pending, state: "denied" }),
    ]) {
      state.link = setup();
      const response = await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`));
      expect(response.status).toBe(404);
      expect((await body(response)).error).toMatchObject({ code: "link_code_not_found" });
    }
    const malformed = await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=nope`));
    expect(malformed.status).toBe(404);
  });

  it("refuses an agent credential outright, before anything else", async () => {
    const response = await browserLinkGet(
      get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`, { authorization: `Bearer za_${"C".repeat(43)}` })
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatchObject({ code: "browser_required" });
  });

  it("requires a verified signed-in account", async () => {
    state.identity = { subject: "member_1", emailVerified: false };
    const response = await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/integrations/agent/link/approve", () => {
  const approval = {
    userCode: "AAAA-2222",
    approve: true,
    workspaceId: "ws_1",
    projectIds: ["prj_a"],
    scopes: ["read", "plan", "write"],
    days: 30,
    label: "laptop",
  };

  it("issues on approval and says nothing about the secret", async () => {
    const response = await browserLinkApprove(browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, approval));
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(data).toEqual({
      status: "approved",
      credentialId: "cred_1",
      expiresAt: "2026-10-16T09:14:40.000Z",
      workspaceId: "ws_1",
      projectIds: ["prj_a"],
      allProjects: false,
      scopes: ["read", "plan", "write"],
    });
    // The bearer lives in the /token response and nowhere else.
    expect(JSON.stringify(data)).not.toMatch(/za_[A-Za-z0-9_-]{43}/);
    expect(state.approveInput).toMatchObject({ subject: "member_1", workspaceId: "ws_1", days: 30, label: "laptop" });
    // The hash travels, never the code.
    expect(String(state.approveInput?.userCodeHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("denies without issuing anything", async () => {
    const response = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { userCode: "AAAA-2222", approve: false })
    );
    expect(await body(response)).toEqual({ status: "denied" });
    state.denied = false;
    const gone = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { userCode: "AAAA-2222", approve: false })
    );
    expect(gone.status).toBe(404);
  });

  it("rechecks every decision the page made against live state", async () => {
    // A workspace this account is not a member of.
    const foreign = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, workspaceId: "ws_9" })
    );
    expect(foreign.status).toBe(403);
    expect((await body(foreign)).error).toMatchObject({ code: "membership_denied" });

    // A project of another workspace.
    const project = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, projectIds: ["prj_z"] })
    );
    expect((await body(project)).error).toMatchObject({ code: "scope_denied" });

    // An environment that is not in the chosen projects.
    const environment = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, environmentIds: ["env_9"] })
    );
    expect((await body(environment)).error).toMatchObject({ code: "scope_denied" });

    // Beyond the ceiling, and without read.
    for (const bad of [{ ...approval, days: 31 }, { ...approval, scopes: ["plan"] }]) {
      const response = await browserLinkApprove(browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, bad));
      expect(response.status).toBe(400);
      expect((await body(response)).error).toMatchObject({ code: "invalid_request" });
    }
  });

  it("does not let a viewer grant write or publish", async () => {
    state.role = "viewer";
    for (const scope of ["write", "publish"]) {
      const response = await browserLinkApprove(
        browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, scopes: ["read", scope] })
      );
      expect(response.status).toBe(403);
      expect((await body(response)).error).toMatchObject({ code: "scope_denied" });
    }
    // …and can still link a read-only agent.
    const allowed = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, scopes: ["read", "plan"] })
    );
    expect(allowed.status).toBe(200);
  });

  it("refuses a cross-origin submission and an agent credential", async () => {
    const csrf = await browserLinkApprove(
      post(`${ORIGIN}/api/integrations/agent/link/approve`, approval, { origin: "https://evil.test" })
    );
    expect(csrf.status).toBe(403);
    expect((await body(csrf)).error).toMatchObject({ code: "csrf_denied" });

    const agent = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, approval, {
        authorization: `Bearer za_${"D".repeat(43)}`,
      })
    );
    expect(agent.status).toBe(403);
    expect((await body(agent)).error).toMatchObject({ code: "browser_required" });
  });

  it("passes a second approval's refusal through unchanged", async () => {
    state.approved = undefined;
    const response = await browserLinkApprove(browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, approval));
    expect(response.status).toBe(404);
    expect((await body(response)).error).toMatchObject({ code: "link_code_not_found" });
  });
});

describe("POST /api/integrations/agent/link/revoke", () => {
  it("revokes the caller's own credential and says when it takes effect", async () => {
    const response = await browserLinkRevoke(
      browserPost(`${ORIGIN}/api/integrations/agent/link/revoke`, { credentialId: "cred_1" })
    );
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(data).toMatchObject({ revoked: true, credentialId: "cred_1" });
    expect(String(data.effect)).toMatch(/next request/);
    // An editor is held to their own credentials.
    expect(state.revokeInput).toEqual(["member_1", "ws_1", "cred_1"]);
  });

  it("lets an admin withdraw another member's credential in the same workspace", async () => {
    state.role = "admin";
    await browserLinkRevoke(browserPost(`${ORIGIN}/api/integrations/agent/link/revoke`, { credentialId: "cred_2" }));
    expect(state.revokeInput).toEqual([null, "ws_1", "cred_2"]);
  });

  it("answers 404 for a credential this workspace cannot revoke", async () => {
    state.revoked = false;
    const response = await browserLinkRevoke(
      browserPost(`${ORIGIN}/api/integrations/agent/link/revoke`, { credentialId: "cred_9" })
    );
    expect(response.status).toBe(404);
    expect((await body(response)).error).toMatchObject({ code: "credential_not_found" });
  });

  it("refuses a body that names nothing", async () => {
    for (const bad of [{}, { credentialId: "" }, { credentialId: "cred_1", extra: 1 }]) {
      const response = await browserLinkRevoke(browserPost(`${ORIGIN}/api/integrations/agent/link/revoke`, bad));
      expect(response.status).toBe(400);
    }
  });
});

describe("GET /api/integrations/agent", () => {
  it("gains linkedAgents without losing a field, and never carries a hash", async () => {
    state.credentials = [
      {
        id: "cred_1",
        tokenHash: "",
        subject: "member_1",
        workspaceId: "ws_1",
        projectIds: ["prj_a"],
        scopes: ["read", "plan"],
        issuedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
        label: "laptop",
        clientName: "Claude Code",
      },
    ];
    const response = await browserGet(get(`${ORIGIN}/api/integrations/agent`));
    const data = await body(response);
    // Everything the screen already relied on is still there.
    for (const key of ["workspaceId", "subject", "role", "grants", "operations", "projects", "oauthConfigured", "resource"])
      expect(data).toHaveProperty(key);
    expect(data.linkedAgents).toEqual([
      {
        id: "cred_1",
        label: "laptop",
        clientName: "Claude Code",
        clientVersion: null,
        scopes: ["read", "plan"],
        projectIds: ["prj_a"],
        environmentIds: null,
        issuedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("tokenHash");
  });

  it("says so rather than showing an empty list when the authority cannot be read", async () => {
    state.ready = "The agent credential file must live in a directory this server owns.";
    const response = await browserGet(get(`${ORIGIN}/api/integrations/agent`));
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(data.linkedAgents).toEqual([]);
    expect(String(data.linkedAgentsUnavailable)).toMatch(/directory this server owns/);
  });
});

/* ------------------------ link protocol 2 (PLAN3 P2) ------------------------ */

describe("link protocol 2 over the wire", () => {
  const deviceCode = `zl_${"E".repeat(43)}`;
  const approval = {
    userCode: "AAAA-2222",
    approve: true,
    workspaceId: "ws_1",
    scopes: ["read", "plan", "write"],
    days: 30,
  };
  const v2 = { ...pending, protocolVersion: 2 };

  it("keeps a protocol-1 start exactly as it was: version 1 back, no hints stored", async () => {
    for (const request of [{ clientName: "Codex" }, { clientName: "Codex", protocolVersion: 1 }]) {
      state.started = [];
      const response = await start(post(`${ORIGIN}/api/agent/link/start`, request));
      expect(response.status).toBe(201);
      expect((await body(response)).protocolVersion).toBe(1);
      expect(state.started[0]).toMatchObject({ protocolVersion: 1 });
      expect(state.started[0]).not.toHaveProperty("workspaceHint");
      expect(state.started[0]).not.toHaveProperty("workspaceNameHint");
    }
    // A protocol-1 client cannot smuggle a hint in.
    const hinted = await start(post(`${ORIGIN}/api/agent/link/start`, { clientName: "Codex", workspaceHint: "ws_2" }));
    expect(hinted.status).toBe(400);
    expect((await body(hinted)).error).toMatchObject({ code: "invalid_request" });
  });

  it("answers a protocol-2 start with version 2 and stores its hint", async () => {
    const response = await start(
      post(`${ORIGIN}/api/agent/link/start`, { clientName: "Codex", protocolVersion: 2, workspaceNameHint: "Side project" })
    );
    expect(response.status).toBe(201);
    const data = await body(response);
    expect(data.protocolVersion).toBe(2);
    expect(Object.keys(data).sort()).toEqual(
      ["deviceCode", "expiresIn", "interval", "protocolVersion", "userCode", "verificationUri", "verificationUriComplete"].sort()
    );
    // The hint never reaches a URL.
    expect(String(data.verificationUriComplete)).not.toContain("Side");
    expect(state.started[0]).toMatchObject({ protocolVersion: 2, workspaceNameHint: "Side project" });
    for (const bad of [
      { clientName: "Codex", protocolVersion: 2, workspaceHint: "ws 2" },
      { clientName: "Codex", protocolVersion: 2, workspaceNameHint: "<script>" },
      { clientName: "Codex", protocolVersion: 2, workspaceHint: "ws_2", workspaceNameHint: "Side" },
    ]) {
      const refused = await start(post(`${ORIGIN}/api/agent/link/start`, bad));
      expect(refused.status).toBe(400);
      expect((await body(refused)).error).toMatchObject({ code: "invalid_request" });
    }
  });

  it("hands a whole-workspace credential over with allProjects and the poller's version", async () => {
    state.exchange = {
      status: "issued",
      token: `za_${"G".repeat(43)}`,
      credential: {
        id: "cred_ws",
        subject: "member_1",
        workspaceId: "ws_1",
        projectIds: [],
        allProjects: true,
        scopes: ["read", "plan", "write"],
        expiresAt: "2026-10-16T09:14:40.000Z",
      },
    };
    const response = await token(post(`${ORIGIN}/api/agent/link/token`, { deviceCode, protocolVersion: 2 }));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      status: "issued",
      token: `za_${"G".repeat(43)}`,
      credentialId: "cred_ws",
      origin: ORIGIN,
      workspaceId: "ws_1",
      projectIds: [],
      allProjects: true,
      environmentIds: null,
      scopes: ["read", "plan", "write"],
      expiresAt: "2026-10-16T09:14:40.000Z",
      label: null,
      protocolVersion: 2,
      // Protocol 2 only: what the plugin names its local profile after.
      workspaceSlug: "acme",
      workspaceName: "Acme",
    });
    // A subject that is no longer a member gets the credential, without the labels.
    (state.exchange.credential as Record<string, unknown>).workspaceId = "ws_3";
    const stale = await body(await token(post(`${ORIGIN}/api/agent/link/token`, { deviceCode, protocolVersion: 2 })));
    expect(stale.status).toBe("issued");
    expect(stale).not.toHaveProperty("workspaceSlug");
    // A protocol-1 poller never sees them.
    (state.exchange.credential as Record<string, unknown>).workspaceId = "ws_1";
    const v1 = await body(await token(post(`${ORIGIN}/api/agent/link/token`, { deviceCode, protocolVersion: 1 })));
    expect(v1).not.toHaveProperty("workspaceSlug");
    expect(v1).not.toHaveProperty("workspaceName");
    expect(v1.protocolVersion).toBe(1);
    const pendingPoll = await token(post(`${ORIGIN}/api/agent/link/token`, { deviceCode, protocolVersion: 2 }));
    expect(pendingPoll.status).toBe(200);
  });

  it("never offers the whole workspace to a protocol-1 request", async () => {
    const response = await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`));
    const data = await body(response);
    expect(data).toMatchObject({ protocolVersion: 1, wholeWorkspace: false, hint: null });
  });

  it("preselects a hinted workspace only for a member, and shows the hint as unverified", async () => {
    state.link = { ...v2, workspaceHint: "ws_2" };
    const member = await body(await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`)));
    expect(member).toMatchObject({
      protocolVersion: 2,
      wholeWorkspace: true,
      canCreateWorkspace: true,
      hint: { workspaceId: "ws_2", member: true, unverified: true },
    });
    expect((member.workspaces as { id: string }[]).map((w) => w.id)).toEqual(["ws_2", "ws_1"]);

    // ws_3 exists, but this person is not in it: the default is untouched and
    // nothing about ws_3 (its name, its projects) is disclosed.
    state.link = { ...v2, workspaceHint: "ws_3" };
    const stranger = await body(await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`)));
    expect(stranger.hint).toEqual({ workspaceId: "ws_3", member: false, unverified: true });
    expect(JSON.stringify(stranger)).not.toContain("Private");
    expect((stranger.workspaces as { id: string }[]).map((w) => w.id)).toEqual(["ws_1", "ws_2"]);
    expect((stranger.projects as { workspaceId: string }[]).some((p) => p.workspaceId === "ws_3")).toBe(false);

    state.link = { ...v2, workspaceNameHint: "Side project" };
    const named = await body(await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`)));
    expect(named.hint).toEqual({ workspaceName: "Side project", unverified: true });
  });

  it("approves the whole workspace with no projects, and passes the flag to the authority", async () => {
    const response = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, projectIds: [], allProjects: true })
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ status: "approved", projectIds: [], allProjects: true });
    expect(state.approveInput).toMatchObject({ workspaceId: "ws_1", projectIds: [], allProjects: true });
    expect(state.approveInput).not.toHaveProperty("environmentIds");
  });

  it("refuses a whole-workspace approval that also narrows, names projects, or crosses workspaces", async () => {
    for (const bad of [
      { ...approval, projectIds: [], allProjects: true, environmentIds: ["env_x"] },
      { ...approval, projectIds: ["prj_a"], allProjects: true },
      { ...approval, allProjects: true },
    ]) {
      const response = await browserLinkApprove(browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, bad));
      expect(response.status).toBe(400);
      expect((await body(response)).error).toMatchObject({ code: "invalid_request" });
    }
    const foreign = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, workspaceId: "ws_3", projectIds: [], allProjects: true })
    );
    expect(foreign.status).toBe(403);
    expect((await body(foreign)).error).toMatchObject({ code: "membership_denied" });
    expect(state.approveInput).toBeUndefined();
  });

  it("still holds a viewer to read-only under the whole workspace", async () => {
    state.role = "viewer";
    const write = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, projectIds: [], allProjects: true })
    );
    expect(write.status).toBe(403);
    expect((await body(write)).error).toMatchObject({ code: "scope_denied" });
    const read = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, {
        ...approval,
        projectIds: [],
        allProjects: true,
        scopes: ["read", "plan"],
      })
    );
    expect(read.status).toBe(200);
  });

  it("passes the authority's protocol refusal through, typed", async () => {
    const { AgentError } = await import("../src/lib/agent-access/security");
    // The fake authority refuses with whatever the real one would.
    const authority = (await import("@/lib/agent-access/authority")).credentialAuthority();
    const approveLink = authority.approveLink;
    authority.approveLink = async () => {
      throw new AgentError("protocol_upgrade_required", "old terminal", 409);
    };
    try {
      const response = await browserLinkApprove(
        browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, { ...approval, projectIds: [], allProjects: true })
      );
      expect(response.status).toBe(409);
      expect((await body(response)).error).toMatchObject({ code: "protocol_upgrade_required" });
    } finally {
      authority.approveLink = approveLink;
    }
  });

  it("creates a workspace mid-approval through POST /api/workspace and links it whole", async () => {
    state.link = { ...v2, workspaceNameHint: "Side project" };
    // The person presses Create: the same same-origin call onboarding makes.
    const created = await createWorkspace(
      new Request(`${ORIGIN}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ name: "Side project" }),
      }) as never,
      { params: Promise.resolve({}) } as never
    );
    expect(created.status).toBe(201);
    const { workspace } = (await created.json()) as { workspace: { id: string; name: string } };
    expect(workspace.name).toBe("Side project");
    // The route selects the new workspace for the browser, as onboarding does.
    expect(created.headers.get("set-cookie")).toContain(workspace.id);
    state.cookieWorkspace = workspace.id;
    expect(state.data.members).toContainEqual(expect.objectContaining({ id: "member_1", workspaceId: workspace.id, role: "admin" }));

    // The page refetches: the new workspace is first, is the person's as admin, and has no projects.
    const refreshed = await body(await browserLinkGet(get(`${ORIGIN}/api/integrations/agent/link?code=AAAA-2222`)));
    expect((refreshed.workspaces as { id: string; role: string }[])[0]).toMatchObject({ id: workspace.id, role: "admin" });
    expect((refreshed.projects as { workspaceId: string }[]).some((p) => p.workspaceId === workspace.id)).toBe(false);

    // A workspace with zero projects is approvable — as the whole workspace.
    const approved = await browserLinkApprove(
      browserPost(`${ORIGIN}/api/integrations/agent/link/approve`, {
        ...approval,
        workspaceId: workspace.id,
        projectIds: [],
        allProjects: true,
      })
    );
    expect(approved.status).toBe(200);
    expect(state.approveInput).toMatchObject({ workspaceId: workspace.id, projectIds: [], allProjects: true, subject: "member_1" });
  });

  it("lists a whole-workspace linked agent as such", async () => {
    state.credentials = [
      {
        id: "cred_ws",
        tokenHash: "",
        subject: "member_1",
        workspaceId: "ws_1",
        projectIds: [],
        allProjects: true,
        scopes: ["read"],
        issuedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
        clientName: "Codex",
      },
    ];
    const data = await body(await browserGet(get(`${ORIGIN}/api/integrations/agent`)));
    expect(data.linkedAgents).toEqual([expect.objectContaining({ id: "cred_ws", projectIds: [], allProjects: true })]);
  });
});
