/**
 * Real-cluster acceptance for the Kubernetes provider. GATED: skipped unless
 *   ZENITH_TEST_KIND=1   and   KUBECONFIG points at a disposable cluster
 * (for example `kind create cluster`).
 *
 * Local disposable-kind acceptance ran on 2026-10-01. This suite supplies
 * `emulated` evidence for server-side apply, ownership, rollout, rollback,
 * restart and prune. Other provider suites use the fake API (`fake-api.ts`)
 * and supply `contract` evidence. No managed-cloud acceptance is implied.
 *
 * What it does to the cluster it is pointed at: creates ONE namespace named
 * `zenith-kind-<random>` labeled as Zenith's, works only inside it, and deletes
 * it afterwards. It never touches other namespaces. Do not point it at a
 * cluster you care about.
 *
 * Not proven even when this passes: NetworkPolicy ENFORCEMENT (kind's default
 * CNI does not enforce NetworkPolicy), ingress controller / cert-manager /
 * external-dns behavior (none are installed), or anything about a managed
 * cloud control plane.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import { getDriver } from "@/lib/drivers/types";
import { diff, pruneOrphans, rollback, serverSideApply, waitForRollout } from "@/lib/providers/kubernetes/apply";
import { createK8sClient } from "@/lib/providers/kubernetes/client";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { sessionFromKubeConfig, type ScopedKubernetesSession } from "@/lib/providers/kubernetes/session";
import type { K8sObject } from "@/lib/providers/kubernetes/types";
import type { ResourceNode } from "@/lib/resources/types";
import { driverCtx, inNs, node } from "./helpers";

const enabled = process.env.ZENITH_TEST_KIND === "1" && !!process.env.KUBECONFIG;

describe.skipIf(!enabled)("kubernetes provider against a real cluster (kind)", () => {
  const suffix = randomBytes(4).toString("hex");
  const ns = `zenith-kind-${suffix}`;
  const envId = `env-kind-${suffix}`;
  let session: ScopedKubernetesSession;
  let web: (tag: string, extra?: Record<string, unknown>) => ResourceNode;
  let network: ResourceNode;
  let controller: AbortController;

  // Individual budgets include every bounded operation and rollout below.
  // Cancel failed/timed-out tests before the next test mutates shared objects.
  beforeEach(() => { controller = new AbortController(); });
  afterEach(() => { controller.abort(); });

  const render = (nodes: ResourceNode[]): K8sObject[] => renderGraph(nodes, { environmentId: envId, readOnlyRootFilesystem: false }).objects;
  const apply = (objects: K8sObject[]) => serverSideApply(objects, session, { environmentId: envId, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
  const target = { namespace: ns, name: "web" };
  const rollout = () => waitForRollout(target, session, { environmentId: envId, timeoutMs: 180_000, signal: controller.signal });

  beforeAll(() => {
    registerKubernetesDrivers();
    const kc = new KubeConfig();
    kc.loadFromFile(process.env.KUBECONFIG as string);
    // the namespace is created by the first apply (Zenith-created), so the allowlist starts empty
    session = sessionFromKubeConfig(kc, { namespaces: [], ttlSec: 1800 });
    network = node({ address: "network/main", kind: "network", spec: { zones: 1, namespace: ns } });
    web = (tag, extra = {}) =>
      node({
        address: "service/web",
        kind: "container_service",
        dependsOn: ["network/main"],
        spec: {
          workload: "web",
          size: "nano",
          vcpu: 0.1,
          memoryMb: 128,
          artifact: { type: "image", ref: `nginxinc/nginx-unprivileged:${tag}` },
          env: [{ key: "GREETING", value: "hello" }],
          zones: 1,
          subnetTier: "private",
          replicas: 2,
          port: 8080,
          healthPath: "/",
          ...extra,
        },
      });
  });

  afterAll(async () => {
    // remove only the namespace this run created
    const client = createK8sClient(session, { environmentId: envId, signal: AbortSignal.timeout(30_000) });
    await client.objects.delete({ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } }).catch(() => undefined);
  }, 30_000);

  it("creates the namespace, policy and workload, then a second apply changes nothing", async () => {
    const objects = render([network, web("stable-alpine")]);
    const first = await apply(objects);
    expect(first.ok, JSON.stringify(first.results.filter((r) => r.status !== "created"))).toBe(true);
    const second = await apply(objects);
    const unchanged = await diff(objects, session, { environmentId: envId, signal: controller.signal });
    expect(second.results.every((r) => r.status === "unchanged"), JSON.stringify({ results: second.results, diff: unchanged })).toBe(true);
    expect(unchanged.every((d) => d.action === "none"), JSON.stringify(unchanged)).toBe(true);
  }, 300_000);

  it("rolls out, and the drivers observe, verify and report runtime", async () => {
    const r = await rollout();
    expect(r.state, r.reason).toBe("complete");
    const n = inNs(web("stable-alpine"), ns);
    const d = getDriver("kubernetes", "k8s:Deployment");
    const ctx = driverCtx(session, { environmentId: envId, signal: controller.signal });
    const obs = await d.observe!(ctx, n);
    expect(obs.presence).toBe("present");
    const rt = await d.runtime!(ctx, n);
    expect(rt.health).toBe("healthy");
    expect((await d.verify!(ctx, n, obs, rt)).status).toBe("passed");
  }, 240_000);

  it("refuses to touch a same-named object it does not own", async () => {
    const client = createK8sClient(session, { environmentId: envId, signal: controller.signal });
    await client.objects.delete({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: ns } });
    await client.objects.create({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: ns },
      spec: { replicas: 0, selector: { matchLabels: { a: "b" } }, template: { metadata: { labels: { a: "b" } }, spec: { containers: [{ name: "c", image: "nginxinc/nginx-unprivileged:stable-alpine" }] } } },
    } as never);
    const r = await apply(render([network, web("stable-alpine")]));
    expect(r.refused).toBe(true);
    expect(r.results.some((x) => x.status === "ownership_conflict")).toBe(true);
    await client.objects.delete({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: ns } });
    expect((await apply(render([network, web("stable-alpine")]))).ok).toBe(true);
    expect((await rollout()).state).toBe("complete");
  }, 480_000);

  it("restarts, scales and reads logs and events through the operations", async () => {
    const n = inNs(web("stable-alpine"), ns);
    const ops = getDriver("kubernetes", "k8s:Deployment").operations!;
    const ctx = driverCtx(session, { environmentId: envId, signal: controller.signal, operationId: `op-${suffix}-1` });
    expect((await ops["service.restart"](ctx, n, {})).ok).toBe(true);
    expect((await rollout()).state).toBe("complete");
    expect((await ops["service.scale"](ctx, n, { replicas: 3 })).ok).toBe(true);
    expect((await ops["container.logs"](ctx, n, { tailLines: 20 })).ok).toBe(true);
    expect((await ops["events.read"](ctx, n, {})).ok).toBe(true);
  }, 300_000);

  it("deploys a new image, rolls back to the previous revision, and the pods follow", async () => {
    // service.scale above took ownership of spec.replicas (an Update by zenith-ops); align the desired count first
    const v2 = render([network, web("stable", { replicas: 3 })]);
    expect((await apply(v2)).ok).toBe(true);
    expect((await rollout()).state).toBe("complete");
    const back = await rollback(target, session, { environmentId: envId, signal: controller.signal, operationId: `rb-${suffix}` });
    expect(back.status).toBe("rolled_back");
    expect((await rollout()).state).toBe("complete");
  }, 540_000);

  it("prunes what is no longer desired and never deletes the namespace", async () => {
    const keep = render([network]);
    const r = await pruneOrphans({ desired: keep, environmentId: envId, namespaces: [ns] }, session, { signal: controller.signal });
    expect(r.deleted.map((d) => d.kind)).toEqual(expect.arrayContaining(["Deployment", "Service"]));
    expect(r.retained.map((x) => x.ref.kind)).not.toContain("Deployment");
    const client = createK8sClient(session, { environmentId: envId, signal: controller.signal });
    await expect(client.objects.read({ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } })).resolves.toBeDefined();
  }, 120_000);
});
