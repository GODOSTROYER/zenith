/**
 * Gated disposable-cluster acceptance for release SSA and one-off Jobs.
 * Local disposable-kind acceptance ran on 2026-10-01 (emulated evidence).
 * Requires ZENITH_TEST_KIND=1, KUBECONFIG and a
 * ZENITH_TEST_KIND_RELEASE_IMAGE digest for a non-root image with /bin/sh.
 * Works only in its random namespace and deletes it afterwards.
 */
import { randomBytes } from "node:crypto";
import { KubeConfig, PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReleasePorts } from "@/lib/platform/release";
import { createK8sClient, listByKind } from "@/lib/providers/kubernetes/client";
import { dig } from "@/lib/providers/kubernetes/util";
import { FIELD_MANAGER, ANNOTATION } from "@/lib/providers/kubernetes/types";
import { sessionFromKubeConfig, type ScopedKubernetesSession } from "@/lib/providers/kubernetes/session";
import { driverCtx, inNs, serviceNode } from "./helpers";

const image = process.env.ZENITH_TEST_KIND_RELEASE_IMAGE;
const enabled = process.env.ZENITH_TEST_KIND === "1" && !!process.env.KUBECONFIG && !!image;
describe.skipIf(!enabled)("Kubernetes release ports against a disposable kind cluster", () => {
  const suffix = randomBytes(4).toString("hex");
  const namespace = `zenith-release-${suffix}`;
  const environmentId = `env-release-${suffix}`;
  const node = inNs(serviceNode({ env: [], artifact: { type: "image", ref: image } }), namespace);
  let session: ScopedKubernetesSession | undefined;
  let namespaceCreated = false;
  let controller: AbortController;
  beforeEach(() => { controller = new AbortController(); });
  afterEach(() => { controller.abort(); });
  beforeAll(async () => {
    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
    const config = new KubeConfig(); config.loadFromFile(process.env.KUBECONFIG as string);
    session = sessionFromKubeConfig(config, { namespaces: [namespace], ttlSec: 1800 });
    const client = createK8sClient(session, { environmentId, signal: AbortSignal.timeout(120_000) });
    await client.objects.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
    namespaceCreated = true;
    // A deliberately unavailable image starts the owned workload; release supplies the real digest.
    await client.objects.patch({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace, labels: { "app.kubernetes.io/managed-by": "zenith" }, annotations: { [ANNOTATION.environment]: environmentId, [ANNOTATION.resource]: node.address } }, spec: { replicas: 1, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: 65532 }, containers: [{ name: "app", image: "registry.invalid/zenith/bootstrap:unavailable", command: ["/bin/sh", "-c", "while true; do sleep 60; done"], securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } } }] } } } } as KubernetesObject, undefined, undefined, FIELD_MANAGER, false, PatchStrategy.ServerSideApply);
  }, 120_000);
  afterAll(async () => {
    if (session && namespaceCreated) await createK8sClient(session, { signal: AbortSignal.timeout(30_000) }).objects.delete({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
  }, 30_000);
  it("rolls out a pre-built digest, observes readiness and runs exactly one migration Job across retries", async () => {
    // Cover the 180s rollout and both 120s Job calls; cancellation precedes
    // the test runner deadline, and failed tests cancel outstanding requests.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(480_000)]);
    const ctx = driverCtx(session!, { environmentId, signal });
    const ports = createReleasePorts();
    const digest = image!.split("@")[1];
    await ports.workloads.deployImage(ctx, node, { uri: image!, digest }, { idempotencyKey: `deploy-${suffix}` });
    expect(await ports.workloads.waitSteady(ctx, node, { timeoutMs: 180_000 })).toMatchObject({ steady: true });
    const opts = { timeoutMs: 120_000, idempotencyKey: `migrate-${suffix}` };
    const first = await ports.migrations.runOneOffTask(ctx, node, ["/bin/sh", "-c", "exit 0"], opts);
    expect(first.exitCode).toBe(0);
    const client = createK8sClient(session!, { environmentId, signal });
    const jobKind = { apiVersion: "batch/v1", kind: "Job", namespaced: true };
    const jobs = await listByKind(client, jobKind, namespace);
    expect(jobs.items).toHaveLength(1);
    expect(await ports.migrations.runOneOffTask(ctx, node, ["/bin/sh", "-c", "exit 0"], opts)).toEqual(first);
    const retried = await listByKind(client, jobKind, namespace);
    expect(retried.items).toHaveLength(1);
    expect(dig(retried.items[0], "metadata", "uid")).toBe(dig(jobs.items[0], "metadata", "uid"));
  }, 510_000);
});
