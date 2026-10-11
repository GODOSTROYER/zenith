import { beforeEach, describe, expect, it, vi } from "vitest";

type FixtureBody = { name?: string; workspaceId?: string; email?: string; role?: string };
type FixtureReply = {
  status: number;
  data: {
    ok?: boolean;
    workspace?: { id: string };
    invite?: { id: string };
    member?: { id: string; role: string };
    workspaces?: unknown[];
    projects?: unknown[];
    error?: { code: string };
  };
};
type AuthResponse = {
  url(): string;
  ok(): boolean;
  json(): Promise<{ user?: { id?: string } }>;
};
type FakePage = {
  email: string;
  goto(url: string): Promise<void>;
  getByLabel(label: string): { fill(value: string): Promise<void> };
  waitForResponse(predicate: (response: AuthResponse) => boolean): Promise<AuthResponse>;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): { click(): Promise<void> };
  waitForURL(predicate: (url: URL) => boolean): Promise<void>;
  evaluate(fn: unknown, args: { endpoint: string; body?: FixtureBody; method?: string; workspaceId?: string }): Promise<FixtureReply>;
};

const fixture = vi.hoisted(() => ({
  events: [] as string[],
  users: new Map<string, string>(),
  memberships: new Map<string, string>(),
  aal2: new Set<string>(),
  invite: undefined as { id: string; email: string; workspaceId: string; role: string } | undefined,
  nextUser: 0,
}));

vi.mock("../../../tests/e2e/default/support.mjs", async (importOriginal) => {
  const support = await importOriginal<typeof import("../../../tests/e2e/default/support.mjs")>();
  return {
    ...support,
    operator: vi.fn(async (_stack: unknown, _mailpit: string, label: string, users: string[]) => {
      const id = `user-${++fixture.nextUser}`;
      const email = `${label}@example.test`;
      fixture.users.set(email, id);
      users.push(id);
      fixture.events.push(`auth:${email}`);
      return { id, email, password: "test-only-password" };
    }),
    action: vi.fn(async () => ({ projectId: "project-owner", slug: "tenant-project" })),
    nonce: () => "nonce-12345678",
  };
});

vi.mock("../../../tests/e2e/default/mfa.mjs", () => ({
  enrollOperator: vi.fn(async (page: { email?: string }) => {
    fixture.events.push(`mfa-proof:${page.email}`);
    fixture.aal2.add(page.email ?? "");
  }),
}));

import { createTenant, type OperatedContext } from "../../../scripts/release/drivers/operated";

function fakePage(): FakePage {
  const route = (page: Pick<FakePage, "email">, endpoint: string, body?: FixtureBody): FixtureReply => {
    const actorId = fixture.users.get(page.email);
    if (endpoint === "/api/bootstrap") {
      fixture.events.push(`bootstrap:${page.email}`);
      return actorId && fixture.memberships.has(actorId)
        ? { status: 200, data: { ok: true, workspace: { id: fixture.memberships.get(actorId)! }, workspaces: [], projects: [] } }
        : { status: 403, data: { error: { code: "workspace_denied" } } };
    }
    if (endpoint === "/api/workspace") {
      fixture.events.push(`workspace:${page.email}`);
      if (!actorId) return { status: 401, data: {} };
      const workspaceId = "workspace-owner";
      fixture.memberships.set(actorId, workspaceId);
      return { status: 201, data: { workspace: { id: workspaceId } } };
    }
    if (endpoint === "/api/workspace/invites") {
      fixture.events.push(`invite:${page.email}`);
      if (!actorId || fixture.memberships.get(actorId) !== body?.workspaceId || !fixture.aal2.has(page.email))
        return { status: 403, data: { error: { code: "mfa_required" } } };
      fixture.invite = { id: "invite-1", email: body?.email ?? "", workspaceId: body?.workspaceId ?? "", role: body?.role ?? "" };
      return { status: 201, data: { invite: { id: fixture.invite.id } } };
    }
    if (endpoint === "/api/workspace/invites/invite-1/accept") {
      fixture.events.push(`accept:${page.email}`);
      if (!actorId || !fixture.invite || fixture.invite.email !== page.email || !fixture.aal2.has(page.email))
        return { status: 403, data: { error: { code: "mfa_required_or_invite_denied" } } };
      fixture.memberships.set(actorId, fixture.invite.workspaceId);
      return { status: 200, data: { member: { id: actorId, role: "admin" } } };
    }
    throw new Error(`fixture:unexpected-browser-path:${endpoint}`);
  };
  const page: FakePage = {
    email: "",
    goto: async () => undefined,
    getByLabel: (label) => ({ fill: async (value) => { if (label === "Email") page.email = value; } }),
    waitForResponse: async (predicate) => {
      fixture.events.push(`session:${page.email}`);
      const response: AuthResponse = {
        url: () => "https://supabase.localhost:54321/auth/v1/token?grant_type=password",
        ok: () => true,
        json: async () => ({ user: { id: fixture.users.get(page.email) } }),
      };
      expect(predicate(response)).toBe(true);
      return response;
    },
    getByRole: () => ({ click: async () => undefined }),
    waitForURL: async (predicate) => {
      expect(predicate(new URL("http://127.0.0.1:36400/overview"))).toBe(true);
    },
    // Keep the real support.mjs login/browserRequest helpers, but model their route result here.
    evaluate: async (_fn, args) => route(page, args.endpoint, args.body),
  };
  return page;
}

beforeEach(() => {
  fixture.events.length = 0;
  fixture.users.clear();
  fixture.memberships.clear();
  fixture.aal2.clear();
  fixture.invite = undefined;
  fixture.nextUser = 0;
});

describe("DRV-4 tenant bootstrap sequencing", () => {
  it("requires owner membership and AAL2 before invite, then accepts before approver bootstrap", async () => {
    const owner = fakePage(), approver = fakePage();
    const cleanup = { add: vi.fn(() => { fixture.events.push("cleanup-registered"); }) };
    let pageIndex = 0;
    const pages = [owner, approver];
    const ctx = {
      stack: { apiUrl: "http://127.0.0.1:36400", supabaseUrl: "https://supabase.localhost:54321", adminKey: "test-only" },
      browser: { newContext: async () => ({ newPage: async () => pages[pageIndex++] }) },
      config: { mailpitUrl: "http://127.0.0.1:8025" }, cleanup,
      input: { runId: "drv4-test" },
    } as OperatedContext;

    const tenant = await createTenant(ctx, "a");

    expect(tenant).toMatchObject({ workspaceId: "workspace-owner", ownerId: "user-1", approverId: "user-2" });
    expect(fixture.events).toEqual([
      "cleanup-registered",
      "auth:drv4-a-owner@example.test",
      "auth:drv4-a-approver@example.test",
      "session:drv4-a-owner@example.test",
      "workspace:drv4-a-owner@example.test",
      "bootstrap:drv4-a-owner@example.test",
      "mfa-proof:drv4-a-owner@example.test",
      "invite:drv4-a-owner@example.test",
      "session:drv4-a-approver@example.test",
      "mfa-proof:drv4-a-approver@example.test",
      "accept:drv4-a-approver@example.test",
      "bootstrap:drv4-a-approver@example.test",
    ]);
    expect(fixture.memberships.get("user-2")).toBe("workspace-owner");
    expect(fixture.aal2).toEqual(new Set(["drv4-a-owner@example.test", "drv4-a-approver@example.test"]));
  });
});
