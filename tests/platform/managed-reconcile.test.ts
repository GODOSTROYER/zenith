/** Managed reconciliation contracts over the real platform store; provider/session ports are scripted, never live. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Broker } from "@/lib/capabilities/platform";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { CredentialBroker } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import { composeReconcilePorts } from "@/lib/platform/reconcile";
import { unavailableDatabaseProvider, type ManagedDatabaseProvider } from "@/lib/providers/zenith/database";
import { createManagedPostgresDriver } from "@/lib/providers/zenith/drivers/data/managed-postgres";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import { reconcileEnvironment } from "@/lib/reconcile";
import { loadGraphFromStore, registerEnvironment } from "@/lib/reconcile/platform";
import { RECONCILER_PRINCIPAL, type ObserveSessionRequest, type ReconcileEnvironment } from "@/lib/reconcile/types";
import { LANES, openLane, uid, type Lane } from "../controlplane/_support/harness";
import { mkNode, session, TENANT } from "../providers/zenith/support";

describe.each(LANES)("managed reconciliation composition [$name]", (lane: Lane) => {
  let db: PlatformDbHandle;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ db, close } = await openLane(lane)); }, 60_000);
  afterAll(async () => { await close?.(); });

  async function fixture(options: {
    duringAuthorization?: (request: ObserveSessionRequest) => void;
    duringOpen?: (request: ObserveSessionRequest, env: ReconcileEnvironment) => Promise<void>;
    claims?: Partial<CapabilityGrantClaims>;
    denied?: boolean;
    unavailable?: boolean;
    session?: (opened: ZenithSession) => ZenithSession;
  } = {}) {
    const workspaceId = uid("ws");
    const environmentId = uid("env");
    const connection = await repos.connections.create(db, { workspaceId, createdBy: "managed-fixture", config: { provider: "zenith", mode: "managed", region: "zenith-managed" } });
    await repos.connections.recordVerification(db, { workspaceId, id: connection.id, ok: true });
    const environment: ReconcileEnvironment = { workspaceId, projectId: "managed-project", environmentId, class: "production", provider: "zenith", region: "zenith-managed", connection: { id: connection.id, status: "verified" } };
    await registerEnvironment(db, { environment });
    const node = mkNode("postgres/main", "postgres", { version: "16", size: "nano", backup: "daily", highAvailability: false, deletionPolicy: "deny" }, { externalRef: "owned-managed-db" });
    await repos.resources.upsertDesired(db, { workspaceId, projectId: environment.projectId, environmentId, node, status: "active" });
    const request: ObserveSessionRequest = { workspaceId, projectId: environment.projectId, environmentId, provider: "zenith", region: environment.region, connectionId: connection.id, correlationId: "managed-read-contract", signal: new AbortController().signal };
    let observedVersion = 15;
    const databaseGet = vi.fn<ManagedDatabaseProvider["get"]>(async () => ({ ok: true, value: { provider: "contract", externalId: "owned-managed-db", name: "owned", regionId: "managed", engineVersion: observedVersion, computeState: "active", connectionSecretRef: "vault:managed/connection", settings: {} } }));
    const databaseCreate = vi.fn<ManagedDatabaseProvider["create"]>(async () => { throw new Error("Observation must never create a database."); });
    const databaseDelete = vi.fn<ManagedDatabaseProvider["delete"]>(async () => { throw new Error("Observation must never delete a database."); });
    const databases: ManagedDatabaseProvider = { ...unavailableDatabaseProvider("fixture"), get: databaseGet, create: databaseCreate, delete: databaseDelete };
    const databaseRuntime = vi.fn<ManagedSubstratePort["databaseRuntime"]>(() => ({ databases, resolveSecret: async () => { throw new Error("Observation must never resolve workload secrets."); } }));
    const opens = vi.fn();
    const managed = {
      databaseRuntime,
      async withSession<T>(input: Parameters<ManagedSubstratePort["withSession"]>[0], callback: (opened: ZenithSession) => Promise<T>): Promise<T> {
        opens(input);
        await options.duringOpen?.(request, environment);
        const opened = session(input.databases ?? unavailableDatabaseProvider("not scoped"), { tenant: { ...TENANT, workspaceId: input.workspaceId, environmentId: input.environmentId } });
        return callback(options.session?.(opened) ?? opened);
      },
    } as unknown as ManagedSubstratePort;
    const credentials = { withSession: vi.fn(async () => { throw new Error("Customer credentials must never open a managed read."); }), verifyConnection: vi.fn() } as unknown as CredentialBroker;
    const authorizeRead = vi.fn(async () => {
      options.duringAuthorization?.(request);
      return { decision: { outcome: options.denied ? "deny" : "allow" }, claims: { jti: uid("grant"), iss: "zenith-control", aud: "worker", sub: "reconciler", iat: 1, exp: 4_102_444_800, cap: "infrastructure.observe", op: "read-contract", digest: "a".repeat(64), ws: workspaceId, proj: environment.projectId, env: environmentId, ...options.claims } };
    });
    const propose = vi.fn(async () => { throw new Error("This observe-only fixture must never propose repairs."); });
    const broker = { authorizeRead, propose } as unknown as Broker;
    const ports = composeReconcilePorts(db, credentials, async () => broker, options.unavailable ? undefined : managed);
    const driver = createManagedPostgresDriver(node.nativeType);
    // The registry erases provider session types; the real driver validates the
    // managed session constructed by these composition contracts at its boundary.
    ports.driverFor = () => driver as unknown as ResourceDriver;
    return { environment, node, request, ports, authorizeRead, propose, opens, databaseRuntime, databaseGet, databaseCreate, databaseDelete, credentials, setObservedVersion: (version: number) => { observedVersion = version; } };
  }

  it("authorizes the managed read, scopes the database port and persists real drift detection and clearing", async () => {
    const h = await fixture();
    const graph = await loadGraphFromStore(db, h.environment);
    if (!graph) throw new Error("Fixture graph is missing.");
    const run = () => reconcileEnvironment({ environment: h.environment, graph, ports: h.ports, options: { autoRepair: false } });
    const first = await run();
    expect(first.observed).toBe(1);
    expect(first.report?.findings).toContainEqual(expect.objectContaining({ address: h.node.address, fields: expect.arrayContaining([expect.objectContaining({ attribute: "engineVersion", desired: 16, observed: 15 })]) }));
    expect((await repos.drift.latest(db, h.environment.workspaceId, h.environment.environmentId))?.findings).toEqual(first.report?.findings);
    expect(h.authorizeRead).toHaveBeenCalledWith({ capability: "infrastructure.observe", scope: { workspaceId: h.environment.workspaceId, projectId: h.environment.projectId, environmentId: h.environment.environmentId }, input: {} }, RECONCILER_PRINCIPAL, { audience: "worker", ctx: { origin: "reconciler", via: "reconciler" } });
    expect(h.databaseRuntime).toHaveBeenCalledWith({ workspaceId: h.environment.workspaceId, projectId: h.environment.projectId, environmentId: h.environment.environmentId, nodes: graph.nodes });
    expect(h.databaseGet).toHaveBeenCalledWith({ workspaceId: h.environment.workspaceId, environmentId: h.environment.environmentId, address: h.node.address, externalId: "owned-managed-db" }, { signal: expect.any(AbortSignal) });
    h.setObservedVersion(16);
    const second = await run();
    expect(second.observed).toBe(1);
    expect(second.cleared).toBe(1);
    expect(second.report?.findings).toEqual([]);
    expect(h.credentials.withSession).not.toHaveBeenCalled();
    expect(h.databaseCreate).not.toHaveBeenCalled();
    expect(h.databaseDelete).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
  });

  it.each(["denied", "unavailable"] as const)("refuses %s authorization or composition before opening any session", async mode => {
    const h = await fixture({ [mode]: true });
    const read = vi.fn(async () => undefined);
    await expect(h.ports.withObserveSession(h.request, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(h.opens).not.toHaveBeenCalled();
    expect(h.credentials.withSession).not.toHaveBeenCalled();
  });

  it.each(["ws", "proj", "env", "cap", "aud"] as const)("rejects a foreign %s grant before managed credential acquisition", async field => {
    const h = await fixture({ claims: { [field]: "foreign" } });
    await expect(h.ports.withObserveSession(h.request, async () => undefined)).rejects.toThrow();
    expect(h.opens).not.toHaveBeenCalled();
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid or expired read grant expiry %s before opening platform credentials", async exp => {
    const h = await fixture({ claims: { exp } });
    const read = vi.fn(async () => undefined);
    await expect(h.ports.withObserveSession(h.request, read)).rejects.toThrow(/authorization has expired/);
    expect(h.opens).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks read authorization expiry after managed credential acquisition", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30;
    const h = await fixture({ claims: { exp: expiresAt }, duringOpen: async () => { vi.spyOn(Date, "now").mockReturnValue(expiresAt * 1000); } });
    const read = vi.fn(async () => undefined);
    try {
      await expect(h.ports.withObserveSession(h.request, read)).rejects.toThrow(/authorization has expired/);
      expect(h.opens).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(h.databaseGet).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it("refuses concurrent and subsequent reuse of the same managed session object", async () => {
    let shared: ZenithSession | undefined;
    const h = await fixture({ session: opened => { shared ??= opened; return shared; } });
    const read = vi.fn(async () => undefined);
    await h.ports.withObserveSession(h.request, async () => {
      await expect(h.ports.withObserveSession({ ...h.request }, read)).rejects.toThrow(/read session changed/);
    });
    await expect(h.ports.withObserveSession({ ...h.request }, read)).rejects.toThrow(/read session changed/);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["workspaceId", "projectId", "environmentId", "provider", "region", "connectionId", "correlationId", "signal"] as const)("rejects request %s mutation during authorization", async field => {
    const h = await fixture({ duringAuthorization: request => { Object.assign(request, { [field]: field === "signal" ? new AbortController().signal : "foreign" }); } });
    await expect(h.ports.withObserveSession(h.request, async () => undefined)).rejects.toThrow();
    expect(h.opens).not.toHaveBeenCalled();
  });

  it.each(["workspaceId", "projectId", "environmentId", "provider", "region", "connectionId"] as const)("rejects a request with a mismatched registered %s", async field => {
    const h = await fixture();
    Object.assign(h.request, { [field]: field === "provider" ? "aws" : "foreign" });
    await expect(h.ports.withObserveSession(h.request, async () => undefined)).rejects.toThrow();
    expect(h.opens).not.toHaveBeenCalled();
  });

  it.each(["revocation", "configuration", "graph", "request", "abort"] as const)("refuses %s change while the managed session opens before the driver reads", async changed => {
    const h = await fixture({ duringOpen: async (request, environment) => {
      if (changed === "revocation") await repos.connections.revoke(db, environment.workspaceId, request.connectionId!);
      else if (changed === "configuration") await db.query("update platform.provider_connections set config=jsonb_set(config,'{region}', $3::text::jsonb) where workspace_id=$1 and id=$2", [environment.workspaceId, request.connectionId, JSON.stringify("different-region")]);
      else if (changed === "graph") await repos.resources.upsertDesired(db, { workspaceId: environment.workspaceId, projectId: environment.projectId, environmentId: environment.environmentId, node: mkNode("postgres/added", "postgres", { version: "16" }), status: "active" });
      else if (changed === "request") request.environmentId = "foreign-environment";
      else Object.assign(request, { signal: AbortSignal.abort() });
    } });
    const read = vi.fn(async () => undefined);
    await expect(h.ports.withObserveSession(h.request, read)).rejects.toThrow();
    expect(h.opens).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(h.databaseGet).not.toHaveBeenCalled();
  });

  it.each(["workspace", "environment", "expired"] as const)("refuses a managed session with foreign %s or stale lifetime", async changed => {
    const h = await fixture({ session: opened => ({ ...opened, ...(changed === "expired" ? { expiresAt: "2000-01-01T00:00:00.000Z" } : { tenant: { ...opened.tenant, [changed === "workspace" ? "workspaceId" : "environmentId"]: "foreign" } }) }) });
    const read = vi.fn(async () => undefined);
    await expect(h.ports.withObserveSession(h.request, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(h.databaseGet).not.toHaveBeenCalled();
  });

  it("reports a revoked managed connection as inaccessible without erasing earlier drift", async () => {
    const h = await fixture();
    const graph = await loadGraphFromStore(db, h.environment);
    if (!graph) throw new Error("Fixture graph is missing.");
    const run = () => reconcileEnvironment({ environment: h.environment, graph, ports: h.ports, options: { autoRepair: false } });
    expect((await run()).detected).toBe(1);
    const readCount = h.databaseGet.mock.calls.length;
    await repos.connections.revoke(db, h.environment.workspaceId, h.request.connectionId!);
    const unavailable = await run();
    expect(unavailable.observed).toBe(0);
    expect(unavailable.cleared).toBe(0);
    expect(unavailable.report?.findings).toContainEqual(expect.objectContaining({ address: h.node.address, class: "inaccessible", repairable: false }));
    expect(h.databaseGet).toHaveBeenCalledTimes(readCount);
    expect(h.propose).not.toHaveBeenCalled();
  });
});
