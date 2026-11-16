/** Product membership ports are modeled here; this is not live PostgREST/TLS evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/store";
import type { ResolvedAccess } from "@/lib/capabilities/ports";
import { currentProductRoleResolver } from "@/lib/capabilities/current-product-roles";

const model = vi.hoisted(() => ({
  postgres: true, configured: true, emptyAdmin: false,
  snapshot: { workspaces: [{ id: "ws_owned" }], members: [] as { id: string; workspaceId: string; role: string }[] },
  response: { data: null as unknown, error: null as unknown },
  read: undefined as undefined | (() => Promise<{ data: unknown; error: unknown }>),
  signal: undefined as AbortSignal | undefined,
  filters: [] as [string, string][],
  canonical: vi.fn<(...args: unknown[]) => Promise<ResolvedAccess>>(),
  credentials: [] as { id: string; workspaceId: string; subject: string; scopes: string[]; projectIds: string[]; environmentIds?: string[]; expiresAt: string; revokedAt?: string }[],
  credentialReads: vi.fn(),
  client: vi.fn(), select: vi.fn(),
}));
vi.mock("@/lib/db/store", () => ({ isPostgres: () => model.postgres, db: () => model.snapshot as unknown as Database }));
vi.mock("@/lib/auth/policy", () => ({ membershipPolicy: () => ({ emptyWorkspaceGrantsAdmin: model.emptyAdmin }) }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => model.configured }));
vi.mock("@/lib/capabilities/product-adapters", () => ({ productRoleResolver: () => ({ resolve: model.canonical }) }));
vi.mock("@/lib/db/postgres-store", () => ({ pgClient: model.client }));
// The credential directory is modeled; currentIntegrationGrant validates its
// actual subject/tenant/identity/lifetime contract without a canonical-role fallback.
vi.mock("@/lib/agent-access/authority", () => ({ credentialAuthority: () => ({ listCredentials: model.credentialReads }) }));

const user = { kind: "user", id: "alice", name: "Alice" } as const;
const navigator = { kind: "navigator", id: "nav", name: "Navigator", onBehalfOf: "alice" } as const;
const integration = { kind: "integration", id: "credential", name: "Integration", onBehalfOf: "alice", integrationId: "credential" } as const;
const member = (role: unknown = "admin") => ({ id: "alice", workspace_id: "ws_owned", role });
function defer<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("current product roles (modeled read contracts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    model.postgres = true; model.configured = true; model.emptyAdmin = false;
    model.snapshot = { workspaces: [{ id: "ws_owned" }], members: [] };
    model.response = { data: member(), error: null }; model.read = undefined;
    model.signal = undefined; model.filters = [];
    model.canonical.mockResolvedValue({ role: "admin" });
    model.credentials = [];
    model.credentialReads.mockImplementation(async (subject: string, workspaceId: string) =>
      model.credentials.filter(credential => credential.subject === subject && credential.workspaceId === workspaceId));
    const query = {
      select: model.select.mockImplementation(() => query),
      eq: (field: string, value: string) => { model.filters.push([field, value]); return query; },
      abortSignal: (signal: AbortSignal) => { model.signal = signal; return query; },
      maybeSingle: () => model.read ? model.read() : Promise.resolve(model.response),
    };
    model.client.mockReturnValue({ from: (table: string) => { expect(table).toBe("members"); return query; } });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([user, navigator])("reads the exact current human/tenant without a snapshot or auth claim", async principal => {
    expect(await currentProductRoleResolver().resolve(principal, "ws_owned")).toEqual({ role: "admin" });
    expect(model.select).toHaveBeenCalledWith("id,workspace_id,role");
    expect(model.filters).toEqual([["workspace_id", "ws_owned"], ["id", "alice"]]);
    expect(model.signal).toBeInstanceOf(AbortSignal);
    expect(model.canonical).not.toHaveBeenCalled();
  });

  it("rereads demotion on the same resolver and never caches the previous admin", async () => {
    const roles = currentProductRoleResolver();
    expect(await roles.resolve(user, "ws_owned")).toEqual({ role: "admin" });
    model.response.data = member("viewer");
    expect(await roles.resolve(user, "ws_owned")).toEqual({ role: "viewer" });
    expect(model.client).toHaveBeenCalledTimes(2);
  });

  it("observes demotion during a delayed membership read instead of the earlier bulk snapshot", async () => {
    const read = defer<{ data: unknown; error: unknown }>();
    model.read = () => read.promise;
    const pending = currentProductRoleResolver().resolve(user, "ws_owned");
    await Promise.resolve();
    read.resolve({ data: member("viewer"), error: null });
    expect(await pending).toEqual({ role: "viewer" });
  });

  it("missing PostgreSQL membership gets no empty-workspace/local fallback", async () => {
    model.emptyAdmin = true; model.configured = false; model.response.data = null;
    expect(await currentProductRoleResolver().resolve(user, "ws_owned")).toEqual({ role: "none" });
    expect(await currentProductRoleResolver().resolve({ ...user, id: "local" }, "ws_owned")).toEqual({ role: "none" });
  });

  it.each([
    { ...member(), workspace_id: "ws_foreign" }, { ...member(), id: "foreign" },
    member("owner"), { ...member(), role: undefined }, member(3), {}, undefined,
  ])("refuses malformed or foreign returned membership", async data => {
    model.response.data = data;
    await expect(currentProductRoleResolver().resolve(user, "ws_owned")).rejects.toMatchObject({ code: "current_product_role_unconfirmed" });
  });

  it.each(["response error", "thrown error"])("sanitizes %s without leaking the store error", async kind => {
    const secretError = new Error("private provider credential details");
    if (kind === "response error") model.response.error = secretError;
    else model.read = async () => { throw secretError; };
    await expect(currentProductRoleResolver().resolve(user, "ws_owned")).rejects.toThrow("Current workspace membership could not be confirmed.");
  });

  it("aborts promptly and refuses a late success from a client that ignores cancellation", async () => {
    const controller = new AbortController(), read = defer<{ data: unknown; error: unknown }>();
    model.read = () => read.promise;
    const pending = currentProductRoleResolver({ signal: controller.signal }).resolve(user, "ws_owned");
    const refusal = expect(pending).rejects.toMatchObject({ code: "current_product_role_unconfirmed" });
    await Promise.resolve(); controller.abort(); await refusal;
    expect(model.signal?.aborted).toBe(true);
    read.resolve({ data: member(), error: null });
    await Promise.resolve();
    await expect(pending).rejects.toThrow("Current workspace membership could not be confirmed.");
  });

  it("sets an eight-second independent deadline even without caller cancellation", async () => {
    const deadline = new AbortController(), read = defer<{ data: unknown; error: unknown }>();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    model.read = () => read.promise;
    const pending = currentProductRoleResolver().resolve(user, "ws_owned");
    const refusal = expect(pending).rejects.toMatchObject({ code: "current_product_role_unconfirmed" });
    await Promise.resolve(); deadline.abort(); await refusal;
    expect(timeout).toHaveBeenCalledWith(8_000);
    read.resolve({ data: member(), error: null });
  });

  it("never reads after an already-aborted signal", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(currentProductRoleResolver({ signal: controller.signal }).resolve(user, "ws_owned")).rejects.toMatchObject({ code: "current_product_role_unconfirmed" });
    expect(model.client).not.toHaveBeenCalled(); expect(model.canonical).not.toHaveBeenCalled();
  });

  it("retains integration scopes and target attenuation while reducing its current human role", async () => {
    const access = { role: "admin", integrationScopes: ["write"], allowedProjectIds: ["proj_owned"], allowedEnvironmentIds: ["env_owned"] } satisfies ResolvedAccess;
    model.credentials = [{ id: integration.integrationId, workspaceId: "ws_owned", subject: "alice", scopes: access.integrationScopes,
      projectIds: access.allowedProjectIds, environmentIds: access.allowedEnvironmentIds, expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    model.response.data = member("viewer");
    expect(await currentProductRoleResolver().resolve(integration, "ws_owned")).toEqual({ ...access, role: "viewer" });
    expect(model.credentialReads).toHaveBeenCalledExactlyOnceWith("alice", "ws_owned");
    expect(model.canonical).not.toHaveBeenCalled();
  });

  it("cannot restore a refused integration or exceed its canonical human role", async () => {
    // Retain the historical case identity; the ceiling is the current human,
    // and a fresh refused credential supplies no authority to restore.
    model.credentials = [{ id: integration.integrationId, workspaceId: "ws_owned", subject: "alice", scopes: ["write"],
      projectIds: ["proj_owned"], expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: new Date().toISOString() }];
    expect(await currentProductRoleResolver().resolve(integration, "ws_owned")).toEqual({ role: "none" });
    expect(model.client).toHaveBeenCalledTimes(1);
    expect(model.credentialReads).toHaveBeenCalledExactlyOnceWith("alice", "ws_owned");
    delete model.credentials[0].revokedAt; model.response.data = member("editor");
    expect(await currentProductRoleResolver().resolve(integration, "ws_owned")).toEqual({ role: "editor", integrationScopes: ["write"], allowedProjectIds: ["proj_owned"] });
    expect(model.client).toHaveBeenCalledTimes(2);
    expect(model.canonical).not.toHaveBeenCalled();
  });

  it("preserves nonhuman canonical restrictions without inventing a human membership", async () => {
    model.canonical.mockResolvedValue({ role: "none" });
    expect(await currentProductRoleResolver().resolve({ kind: "system", id: "system", name: "System" }, "ws_owned")).toEqual({ role: "none" });
    expect(model.client).not.toHaveBeenCalled();
  });

  it("reads the current file object at each validation", async () => {
    model.postgres = false; model.snapshot.members = [{ id: "alice", workspaceId: "ws_owned", role: "admin" }];
    const roles = currentProductRoleResolver();
    expect(await roles.resolve(user, "ws_owned")).toEqual({ role: "admin" });
    model.snapshot.members[0].role = "viewer";
    expect(await roles.resolve(user, "ws_owned")).toEqual({ role: "viewer" });
    expect(model.client).not.toHaveBeenCalled();
  });

  it("keeps explicit file demo/bootstrap rules and refuses a hosted empty workspace", async () => {
    model.postgres = false; model.configured = false;
    expect(await currentProductRoleResolver().resolve({ ...user, id: "local" }, "ws_owned")).toEqual({ role: "admin" });
    model.configured = true; model.emptyAdmin = true;
    expect(await currentProductRoleResolver().resolve(user, "ws_owned")).toEqual({ role: "admin" });
    model.emptyAdmin = false;
    expect(await currentProductRoleResolver().resolve(user, "ws_owned")).toEqual({ role: "none" });
    expect(await currentProductRoleResolver().resolve(user, "ws_foreign")).toEqual({ role: "none" });
  });

  it("refuses duplicate or malformed selected file membership without upgrading roles", async () => {
    model.postgres = false;
    model.snapshot.members = [{ id: "alice", workspaceId: "ws_owned", role: "owner" }];
    await expect(currentProductRoleResolver().resolve(user, "ws_owned")).rejects.toMatchObject({ code: "current_product_role_unconfirmed" });
    model.snapshot.members = [model.snapshot.members[0], { id: "alice", workspaceId: "ws_owned", role: "admin" }];
    await expect(currentProductRoleResolver().resolve(user, "ws_owned")).rejects.toMatchObject({ code: "current_product_role_unconfirmed" });
  });
});
