/** Scripted execution contracts only; no cloud or OpenTofu process is started. */
import { afterEach, expect, it, vi } from "vitest";
import type { CompileContext, DriverContext } from "@/lib/drivers/types";
import { awsBootstrapContextForConnection, trustedAwsBoundaryArn } from "@/lib/credentials/aws/naming";
import { compileGraph } from "@/lib/execution/compile";
import { buildDesiredState, findGraphProblems } from "@/lib/execution/graph";
import { MemoryReconcileBackend } from "@/lib/reconcile/memory";
import { wireReconcilePorts } from "@/lib/reconcile/ports";
import { createWorld, type World } from "./fakes/world";
import { ENV, OP, REVISION, WS, bucketManifest, makePlan, providerConnection } from "./fakes/fixtures";
import { presentObservation, passedVerification } from "./fakes/drivers";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";

const suffix = "-team-a";
const worlds: World[] = [];
const unexpectedProviderSend = vi.fn(() => { throw new Error("Unexpected provider SDK send in context-only regression."); });
afterEach(() => {
  wireReconcilePorts(null);
  worlds.splice(0).forEach((world) => world.dispose());
  expect(unexpectedProviderSend).not.toHaveBeenCalled();
  unexpectedProviderSend.mockClear();
});
const saved = () => {
  const connection = providerConnection();
  if (connection.config.provider === "aws") connection.config = { ...connection.config, bootstrapNameSuffix: suffix };
  return connection;
};
const contextWorld = (contexts: (CompileContext | DriverContext)[]) => {
  const w = createWorld({ script: {
    onCompile: (_node, ctx) => { contexts.push(ctx); },
    compileExtra: (_node, ctx) => ({ boundary: trustedAwsBoundaryArn(ctx.awsBootstrap, "app") }),
    observe: async (ctx, node) => { contexts.push(ctx); return presentObservation(ctx, node); },
    verify: async (ctx, node) => { contexts.push(ctx); return passedVerification(ctx, node); },
  } });
  worlds.push(w);
  const withSession = w.credentials.withSession.bind(w.credentials);
  w.credentials.withSession = (request, fn) => withSession(request, (session) => fn(session.provider === "aws" ? { ...session, client: <C>() => ({ send: unexpectedProviderSend } as C) } : session));
  w.connections.connections = [saved()];
  return w;
};

it("deployment and destroy workspaces bind the saved suffix into reviewed plan digests", async () => {
  const contexts: CompileContext[] = [];
  const w = contextWorld(contexts);
  w.product.setManifest(bucketManifest());
  await w.activities.validateDesiredState({ operationId: OP });
  const lease = await w.lease();
  const first = await w.activities.planInfrastructure({ operationId: OP, lease });
  const firstConfig = w.tofu.planCalls.at(-1)!.ws.configDigest;
  expect(contexts.length).toBeGreaterThan(0);
  expect(contexts.every((ctx) => ctx.awsBootstrap?.bootstrapNameSuffix === suffix)).toBe(true);
  expect(w.tofu.planCalls.at(-1)!.ws.files.some((file) => file.content.includes("ZenithAppBoundary-team-a"))).toBe(true);
  const config = w.connections.connections[0].config;
  if (config.provider !== "aws") throw new Error("fixture");
  config.bootstrapNameSuffix = "-team-b";
  const second = await w.activities.planInfrastructure({ operationId: OP, lease });
  expect(w.tofu.planCalls.at(-1)!.ws.configDigest).not.toBe(firstConfig);
  expect(second.planDigest).not.toBe(first.planDigest);
  const teardown = contextWorld([]);
  teardown.product.setManifest(bucketManifest());
  teardown.ops.ops.get(OP)!.capability = "infrastructure.plan";
  teardown.product.base.environment.deployedRevisionId = REVISION;
  teardown.tofu.planFactory = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, changes: [] });
  await teardown.activities.planDestroyInfrastructure({ operationId: OP, lease: await teardown.lease() });
  expect(teardown.tofu.planCalls.at(-1)!.opts.destroy).toBe(true);
  expect(teardown.tofu.planCalls.at(-1)!.ws.files.some((file) => file.content.includes("ZenithAppBoundary-team-a"))).toBe(true);
});

it("verify, drift and reconcile pass trusted suffix context to drivers and expectedAttributes", async () => {
  const contexts: DriverContext[] = [];
  const w = contextWorld(contexts);
  await w.activities.validateDesiredState({ operationId: OP });
  const expected: unknown[] = [];
  for (const driver of w.drivers.cache.values()) driver.expectedAttributes = (_node, ctx) => { expected.push(ctx?.awsBootstrap); return {}; };
  const assertNewContexts = (observedBefore: number, expectedBefore?: number) => {
    expect(contexts.length).toBeGreaterThan(observedBefore);
    expect(contexts.slice(observedBefore).every((ctx) => ctx.awsBootstrap?.bootstrapNameSuffix === suffix)).toBe(true);
    if (expectedBefore !== undefined) {
      expect(expected.length).toBeGreaterThan(expectedBefore);
      expect(expected.slice(expectedBefore).every((ctx) => (ctx as { bootstrapNameSuffix?: string } | undefined)?.bootstrapNameSuffix === suffix)).toBe(true);
    }
  };
  await w.activities.verifyInfrastructure({ operationId: OP });
  assertNewContexts(0); // verification checks drivers; expected-value comparisons belong to drift/reconcile
  let observedBefore = contexts.length;
  let expectedBefore = expected.length;
  await w.activities.observeEnvironment({ operationId: OP });
  assertNewContexts(observedBefore, expectedBefore);
  w.product.base.environment.deployedRevisionId = REVISION;
  const product = await w.product.loadContext({ workspaceId: WS, environmentId: ENV });
  const desired = buildDesiredState(product).graph;
  if (!desired) throw new Error("fixture desired graph is missing");
  const connection = saved();
  const backend = new MemoryReconcileBackend({ now: w.deps.clock });
  backend.addEnvironment({ workspaceId: WS, projectId: product.project.id, environmentId: ENV, class: product.environment.class, provider: "aws", region: product.environment.region, connection: { id: connection.id, status: "verified" } }, desired);
  const ports = backend.passPorts({
    driverFor: (node) => w.drivers(node.provider, node.nativeType),
    withObserveSession: async (request, callback) => {
      expect(request).toMatchObject({ workspaceId: WS, projectId: product.project.id, environmentId: ENV, provider: "aws", connectionId: connection.id, region: product.environment.region });
      return callback({ provider: "aws", accountId: "123456789012", region: product.environment.region, client: <C>() => ({ send: unexpectedProviderSend } as C) });
    },
  });
  ports.resolveAwsBootstrap = async (request, session) => {
    if (!request.connectionId) throw new Error("fixture requires its selected connection");
    const selected = await w.connections.resolve({ workspaceId: request.workspaceId, connectionId: request.connectionId });
    expect(selected).toMatchObject({ id: connection.id, workspaceId: WS, status: "verified" });
    if (!selected || selected.config.provider !== "aws") throw new Error("fixture requires its saved AWS connection");
    expect(session).toMatchObject({ provider: "aws", accountId: selected.config.accountId, region: request.region });
    return awsBootstrapContextForConnection(selected.config, request.region);
  };
  wireReconcilePorts(() => ports);
  const passId = `reconcile-${ENV}`;
  const lease = await w.activities.acquireLease({ operationId: passId, scope: `reconcile:${ENV}`, ttlMs: 60_000 });
  observedBefore = contexts.length;
  expectedBefore = expected.length;
  await w.activities.reconcileObserve({ passId, workspaceId: WS, environmentId: ENV, lease });
  assertNewContexts(observedBefore, expectedBefore);
  expect(backend.observations.length).toBeGreaterThan(0);
  expect(backend.reportsOf(ENV)).toHaveLength(1);
  expect(contexts.length).toBeGreaterThan(0);
  expect(contexts.every((ctx) => ctx.awsBootstrap?.bootstrapNameSuffix === suffix)).toBe(true);
  expect(expected.length).toBeGreaterThan(0);
  expect(expected.every((ctx) => (ctx as { bootstrapNameSuffix: string }).bootstrapNameSuffix === suffix)).toBe(true);
});

it("graph overrides cannot select a foreign policy, while mixed provider graph guard remains enforced", () => {
  const connection = saved();
  const node: ResourceNode = { address: "identity/app", kind: "identity", provider: "aws", nativeType: "aws:iam_role", region: "us-east-1", ownership: "managed", spec: { bootstrapNameSuffix: "-foreign", permissionsBoundaryArn: "arn:aws:iam::210987654321:policy/AdministratorAccess", awsBootstrap: { accountId: "210987654321", partition: "aws", bootstrapNameSuffix: "-foreign" } }, specDigest: "x", labels: {}, origin: [], dependsOn: [] };
  const graph: ResourceGraph = { version: 1, environmentId: ENV, manifestDigest: "m", graphDigest: "g", nodes: [node], notes: [], edges: [] };
  const w = contextWorld([]);
  const result = compileGraph({ graph, environmentId: ENV, region: "us-east-1", tags: {}, connection, drivers: w.drivers });
  expect(JSON.stringify(result.fragments.get(node.address))).toContain("arn:aws:iam::123456789012:policy/ZenithAppBoundary-team-a");
  expect(JSON.stringify(result.fragments.get(node.address))).not.toContain("210987654321");
  expect(findGraphProblems({ ...graph, nodes: [{ ...node, provider: "gcp" }] }, "aws", w.drivers).join(" ")).toContain("multi-provider graphs are not executable");
  expect(() => compileGraph({ graph, environmentId: ENV, region: "us-east-1", tags: {}, connection: { ...connection, status: "revoked" }, drivers: w.drivers })).toThrow();
});

it("external AWS documentation nodes do not require AWS context in a non-AWS graph", () => {
  const external: ResourceNode = { address: "network/external-aws", kind: "network", provider: "aws", nativeType: "aws:vpc", region: "us-east-1", ownership: "external", spec: {}, specDigest: "x", labels: {}, origin: [], dependsOn: [] };
  const managed: ResourceNode = { ...external, address: "network/main", provider: "gcp", nativeType: "gcp:compute_network", region: "us-central1", ownership: "managed" };
  const graph: ResourceGraph = { version: 1, environmentId: ENV, manifestDigest: "m", graphDigest: "g", nodes: [managed, external], notes: [], edges: [] };
  const w = contextWorld([]);
  const connection = providerConnection({ config: { provider: "gcp", mode: "oidc_web_identity", projectId: "test-project", region: "us-central1", observeServiceAccount: "observe@test-project.iam.gserviceaccount.com", deployServiceAccount: "deploy@test-project.iam.gserviceaccount.com", workloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/test/providers/test" } });
  expect(findGraphProblems(graph, "gcp", w.drivers)).toEqual([]);
  const result = compileGraph({ graph, environmentId: ENV, region: "us-central1", tags: {}, connection, drivers: w.drivers });
  expect([...result.fragments.keys()]).toEqual([managed.address]);
});
