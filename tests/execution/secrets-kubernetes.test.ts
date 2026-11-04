/** Local fake API contract; real KubeConfig/client transport and encrypted store. */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "./fakes/world";
import { ENV, PROJECT, WS, OP } from "./fakes/fixtures";
import { createRuntime } from "@/lib/execution/runtime";
import { loadExecContext } from "@/lib/execution/context";
import { syncEnvironmentSecrets } from "@/lib/execution/secrets";
import { renderObjects } from "@/lib/providers/kubernetes/render";
import { ANNOTATION } from "@/lib/providers/kubernetes/types";
import { createSecretResolver } from "@/lib/secrets/resolver";
import { putSecretAsync } from "@/lib/secrets";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { node, networkNode, dbNode, secretNode, sessionFor } from "../providers/kubernetes/helpers";
import type { ResourceGraph } from "@/lib/resources/types";
let world: World | undefined;
let fake: FakeK8s | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; world?.dispose(); world = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture() {
  fake = await startFakeK8s();
  const session = await sessionFor(fake);
  const w = createWorld(); world = w;
  vi.stubEnv("ZENITH_DATA", w.planDir); vi.stubEnv("ZENITH_STORE", "file"); vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("base64"));
  w.product.base.environment.provider = "kubernetes";
  const connection = { ...w.connections.connections[0], config: { provider: "kubernetes" as const, mode: "kubeconfig_ref" as const, server: fake.url, namespaces: ["shop"] } };
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease(); const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP);
  const secret = secretNode(`vault:${PROJECT}/svc-web/API_KEY`);
  const database = dbNode();
  const nodes = [networkNode(), secret, database];
  const graph: ResourceGraph = { version: 1, nodes, edges: [], environmentId: ENV, manifestDigest: "m", graphDigest: "g", notes: [] };
  const rendered = nodes.flatMap((n) => renderObjects(n, { environmentId: ENV, nodes: () => nodes, node: (a) => nodes.find((n) => n.address === a) }));
  fake.seed(rendered.find((o) => o.kind === "Namespace")!);
  const targets = rendered.filter((o) => o.kind === "Secret");
  await putSecretAsync(WS, secret.spec.secretRef as string, "KUBE-CANARY-VALUE-ONLY-IN-MEMORY", "test");
  const issue = w.broker.issueGrant.bind(w.broker);
  vi.spyOn(w.broker, "issueGrant").mockImplementation(async (...args) => {
    const r = await issue(...args);
    r.claims.constraints = { secretResources: targets.map((o) => `kubernetes:${o.metadata.namespace}/${o.metadata.name}`) };
    return r;
  });
  vi.spyOn(w.deps.credentials, "withSession").mockImplementation(async (_req, fn) => fn(session));
  return { w, graph, targets, database, sync: () => syncEnvironmentSecrets(rt, ec, graph, connection, lease, new AbortController().signal) };
}
describe("Kubernetes secret delivery", () => {
  it("wires the resolver, creates stable generated credentials and skips unchanged API writes", async () => {
    const { w, database, sync } = await fixture();
    expect(await sync()).toMatchObject({ status: "done", total: 2, completed: 2, changed: 2 });
    const firstWrites = fake!.requests.filter((r) => r.method === "PATCH");
    expect(firstWrites.map((r) => r.body.kind)).toEqual(["Secret", "Secret"]);
    expect(await sync()).toMatchObject({ status: "done", changed: 0 });
    expect(fake!.requests.filter((r) => r.method === "PATCH")).toHaveLength(2);
    const resolve = createSecretResolver({ workspaceId: WS, projectId: PROJECT, environmentId: ENV, resourceAddresses: [database.address] });
    const password = await resolve(`vault:generated/${ENV}/${database.address}/password`);
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(w.stored()).not.toContain(password); expect(w.stored()).not.toContain("KUBE-CANARY-VALUE-ONLY-IN-MEMORY");
  });
  it("refuses a foreign live secret before resolving or modifying it", async () => {
    const { targets, sync } = await fixture();
    const object = targets[0];
    fake!.seed({ ...object, metadata: { ...object.metadata, annotations: { ...object.metadata.annotations, [ANNOTATION.environment]: "foreign" } } });
    await expect(sync()).rejects.toThrow("denied");
    expect(fake!.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });
  it("refuses OCI before obtaining credentials or secrets", async () => {
    const { w, graph } = await fixture();
    const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP); ec.product.environment.provider = "oci";
    const secret = node({ ...graph.nodes.find((n) => n.kind === "secret")!, provider: "oci", nativeType: "oci:vault_secret" });
    const connection = { ...w.connections.connections[0], config: { provider: "oci" as const, mode: "runner" as const, tenancyOcid: "t", compartmentOcid: "c", runnerId: "r", region: "r" } };
    const error = await syncEnvironmentSecrets(rt, ec, { ...graph, nodes: [secret] }, connection, await w.lease(), new AbortController().signal).catch((e: unknown) => e);
    expect(String(error)).toContain("sealed secret request bodies");
    expect(w.broker.grants).toHaveLength(0);
  });
});
