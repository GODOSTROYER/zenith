/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-LIFE-07 acceptance against a REAL cluster. GATED: skipped unless
 *   ZENITH_TEST_K8S_LIFECYCLE=1
 *   KUBECONFIG                      a private kubeconfig for a disposable or approved cluster
 *   ZENITH_TEST_K8S_PROFILE         kind-calico | managed:eks | managed:gke | managed:aks | managed:oke
 *   ZENITH_TEST_K8S_IMAGE           a digest-pinned image with sh, httpd, wget, nc (busybox)
 * Run it through scripts/k8s/lifecycle-acceptance.sh (kind + Calico) or
 * scripts/k8s/managed-acceptance.sh (EKS, GKE, AKS, OKE); both set these and refuse
 * unsafe targets. Optional: ZENITH_TEST_K8S_STORAGE_CLASS, ZENITH_TEST_K8S_EXPECT_NETPOL
 * (default 1), ZENITH_TEST_K8S_EXPECT_SNAPSHOTS (1, 0 or unset), ZENITH_TEST_K8S_EVIDENCE_OUT.
 *
 * What this proves that the fake-API suites cannot:
 *   - an ordered StatefulSet rollout: ordinal 1 is created after ordinal 0 is Ready, and an
 *     update replaces the highest ordinal first
 *   - persistent data: a file written to a volume survives pod replacement, a template
 *     rollback and a scale down and up (retained claims), each ordinal on its own volume
 *   - CronJobs: the schedule fires, `Forbid` never lets two runs overlap, history limits prune
 *     finished Jobs, and a failing run reads back as unhealthy
 *   - CSI snapshot and restore where the cluster supports them, and the refusal where it does not
 *   - NetworkPolicy enforcement with REAL TRAFFIC: a control probe connects with no policy,
 *     then the generated default-deny + explicit allows admit exactly the declared path and
 *     block an undeclared client, an undeclared destination and egress to the API server
 *   - readback (observe, runtime, verify) for every kind, and a teardown that deletes only
 *     what this run created and leaves a foreign claim alone
 *
 * What it works on: two namespaces named `zenith-l7-<random>` and `zenith-l7n-<random>`,
 * created and deleted here, plus short-lived probe pods inside them. Nothing else on the
 * cluster is read or written, except read-only DaemonSet listings in kube-system and
 * calico-system to name the policy engine.
 *
 * Not proven, even when this passes: behaviour of cloud load balancers, ingress controllers,
 * cert-manager or external-dns; storage-class specific behaviour beyond what it exercises;
 * any other cluster than the one it ran on. The evidence file says which cluster and profile.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KubeConfig, VersionApi } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDriver } from "@/lib/drivers/types";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { createK8sClient, listObjects, readObject, type K8sClient } from "@/lib/providers/kubernetes/client";
import { detectPolicyEngine } from "@/lib/providers/kubernetes/cni";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import { renderGraph, renderNode } from "@/lib/providers/kubernetes/render";
import { waitForRollout } from "@/lib/providers/kubernetes/rollout";
import { sessionFromKubeConfig, type ScopedKubernetesSession } from "@/lib/providers/kubernetes/session";
import { teardownKubernetesEnvironment } from "@/lib/providers/kubernetes";
import { ANNOTATION, LABEL, type K8sObject } from "@/lib/providers/kubernetes/types";
import type { ResourceNode } from "@/lib/resources/types";
import { driverCtx, node, serviceNode } from "./helpers";
import { ctxForGraph, nativeCronNode, stsNode } from "./lifecycle-support";

const profile = process.env.ZENITH_TEST_K8S_PROFILE ?? "";
const image = process.env.ZENITH_TEST_K8S_IMAGE ?? "";
const DIGEST_PINNED = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*@sha256:[a-f0-9]{64}$/;
const enabled =
  process.env.ZENITH_TEST_K8S_LIFECYCLE === "1" &&
  !!process.env.KUBECONFIG &&
  /^(kind-calico|managed:(eks|gke|aks|oke))$/.test(profile) &&
  DIGEST_PINNED.test(image);

const isKind = profile === "kind-calico";
const expectNetpol = process.env.ZENITH_TEST_K8S_EXPECT_NETPOL !== "0";
const expectSnapshots = process.env.ZENITH_TEST_K8S_EXPECT_SNAPSHOTS ?? (isKind ? "0" : "auto");
const storageClass = process.env.ZENITH_TEST_K8S_STORAGE_CLASS;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function eventually<T>(what: string, attempt: () => Promise<T | undefined | false | null>, opts: { timeoutMs: number; intervalMs?: number }): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const got = await attempt();
      if (got !== undefined && got !== false && got !== null) return got;
    } catch (e) {
      last = e;
    }
    if (Date.now() >= deadline) throw new Error(`timed out after ${opts.timeoutMs} ms waiting for ${what}${last instanceof Error ? ` (last error: ${last.message.slice(0, 200)})` : ""}`);
    await sleep(opts.intervalMs ?? 2000);
  }
}

describe.skipIf(!enabled)(`Kubernetes full lifecycle on a real cluster (${profile})`, () => {
  const suffix = randomBytes(4).toString("hex");
  const nsMain = `zenith-l7-${suffix}`;
  const nsNet = `zenith-l7n-${suffix}`;
  const envMain = `env-l7-${suffix}`;
  const envNet = `env-l7n-${suffix}`;
  const workspaceId = "ws-lifecycle-acceptance";
  const evidence: { requirement: string; profile: string; startedAt: string; finishedAt?: string; cluster?: Record<string, unknown>; areas: Record<string, Record<string, unknown>> } = {
    requirement: "PROD-LIFE-07",
    profile,
    startedAt: new Date().toISOString(),
    areas: {},
  };
  const record = (area: string, data: Record<string, unknown>) => {
    evidence.areas[area] = { ...(evidence.areas[area] ?? {}), ...data };
  };

  let kc: KubeConfig;
  let session: ScopedKubernetesSession;
  let policySession: ScopedKubernetesSession;
  let client: K8sClient;
  let probes = 0;

  const signal = () => AbortSignal.timeout(600_000);
  const ctx = (environmentId: string, over: Record<string, unknown> = {}) => driverCtx(session, { environmentId, workspaceId, signal: signal(), ...over } as any);
  const drv = (nativeType: string) => getDriver("kubernetes", nativeType) as any;
  const op = (nativeType: string, name: string) => drv(nativeType).operations[name] as (c: any, n: ResourceNode, input: Record<string, unknown>) => Promise<any>;

  const apply = async (environmentId: string, objects: K8sObject[]) => {
    const report = await serverSideApply(objects, session, { environmentId, signal: AbortSignal.timeout(180_000) });
    expect(report.ok, JSON.stringify(report.results.filter((r) => !["created", "configured", "unchanged"].includes(r.status)))).toBe(true);
    return report;
  };
  const withoutPolicies = (objects: K8sObject[]) => objects.filter((o) => o.kind !== "NetworkPolicy");
  const rolled = (namespace: string, name: string, environmentId: string, kind: "StatefulSet" | "Deployment" = "StatefulSet", timeoutMs = 300_000) =>
    waitForRollout({ namespace, name }, session, { kind, environmentId, timeoutMs, signal: AbortSignal.timeout(timeoutMs + 30_000) });
  const pod = async (namespace: string, name: string): Promise<any> => client.core.readNamespacedPod({ name, namespace });
  const time = (t: unknown): number => new Date(t as string | Date).getTime();
  const readyAt = (p: any): number => time(p.status.conditions.find((c: any) => c.type === "Ready" && c.status === "True")?.lastTransitionTime);

  /** A short-lived pod that runs one script. Not a Zenith object: it carries no ownership marks. */
  async function probe(namespace: string, labels: Record<string, string>, script: string): Promise<{ ok: boolean; log: string }> {
    const name = `probe-${suffix}-${++probes}`;
    await client.core.createNamespacedPod({
      namespace,
      body: {
        metadata: { name, labels: { ...labels, "zenith-test": "probe" } },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 0,
          securityContext: { runAsNonRoot: true, runAsUser: 65534, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "probe",
              image,
              command: ["/bin/sh", "-c", script],
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            },
          ],
        },
      },
    });
    try {
      const phase = await eventually(`probe ${name} to finish`, async () => {
        const p = await pod(namespace, name);
        return p.status?.phase === "Succeeded" || p.status?.phase === "Failed" ? (p.status.phase as string) : undefined;
      }, { timeoutMs: 120_000, intervalMs: 1500 });
      let log = "";
      try {
        log = String(await client.core.readNamespacedPodLog({ name, namespace, limitBytes: 4096 }));
      } catch {
        // a probe that never started has no log
      }
      return { ok: phase === "Succeeded", log: log.trim() };
    } finally {
      await client.core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 }).catch(() => undefined);
    }
  }
  const fetchMarker = (namespace: string, host: string) => probe(namespace, {}, `wget -q -T 5 -O- http://${host}.${namespace}.svc.cluster.local:8080/marker`);

  beforeAll(async () => {
    registerKubernetesDrivers();
    kc = new KubeConfig();
    kc.loadFromFile(process.env.KUBECONFIG as string);
    const context = kc.getCurrentContext();
    // Refuse a target that was not chosen for this run.
    if (isKind) expect(context, "the kind-calico profile only runs against a kind cluster named zenith-life07*").toMatch(/^kind-zenith-life07(-[a-z0-9]{1,20})?$/);
    else {
      expect(process.env.ZENITH_MANAGED_K8S_CONTEXT, "managed runs need ZENITH_MANAGED_K8S_CONTEXT").toBeTruthy();
      expect(context).toBe(process.env.ZENITH_MANAGED_K8S_CONTEXT);
      expect(context).not.toMatch(/^(kind-|docker-desktop|minikube|rancher-desktop|colima)/);
    }
    // Zenith's own operations get an empty allowlist: every namespace they touch is one they created.
    session = sessionFromKubeConfig(kc, { namespaces: [], ttlSec: 3600 });
    // Only the policy-engine reading may look at the namespaces where CNI agents live.
    policySession = sessionFromKubeConfig(kc, { namespaces: ["kube-system", "calico-system", nsNet], ttlSec: 3600 });
    client = createK8sClient(session, { signal: AbortSignal.timeout(900_000) });
    const version = await kc.makeApiClient(VersionApi).getCode();
    evidence.cluster = { gitVersion: version.gitVersion, platform: version.platform };
  }, 60_000);

  afterAll(async () => {
    const failures: string[] = [];
    // Owned teardown first (it is part of what is being proved), then the namespaces themselves.
    for (const environmentId of [envMain, envNet]) {
      try {
        for (let i = 0; i < 40; i++) {
          const report = await teardownKubernetesEnvironment({ workspaceId, environmentId, session, retainStateful: false });
          if (report.uncertain.length === 0) break;
          await sleep(3000);
        }
      } catch (e) {
        failures.push(`teardown ${environmentId}: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`);
      }
    }
    for (const ns of [nsMain, nsNet]) {
      await client?.objects.delete({ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } }).catch(() => undefined);
    }
    evidence.finishedAt = new Date().toISOString();
    if (failures.length) record("cleanup", { failures });
    const out = process.env.ZENITH_TEST_K8S_EVIDENCE_OUT;
    if (out) {
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
    }
  }, 600_000);

  /* ---------------------------------- cluster ---------------------------------- */

  it("names the cluster and its NetworkPolicy engine", async () => {
    const reading = await detectPolicyEngine(createK8sClient(policySession, { signal: AbortSignal.timeout(60_000) }));
    record("cluster", { gitVersion: evidence.cluster?.gitVersion, policyEngine: reading.engine ?? null, policyEngineEvidence: reading.evidence, policyEngineReadable: reading.readable });
    if (isKind) {
      expect(reading.readable).toBe(true);
      expect(reading.engine).toContain("calico");
    }
  }, 90_000);

  /* ------------------------------ StatefulSet + data ---------------------------- */

  const SERVER_SCRIPT = [
    "set -e",
    "f=/data/marker",
    'if [ ! -f "$f" ]; then echo "boot-$(cat /proc/sys/kernel/random/uuid)-$(hostname)" > "$f"; fi',
    "exec httpd -f -p 8080 -h /data",
  ].join("\n");
  const serverConfig = (over: Record<string, unknown> = {}) => ({
    namespace: nsMain,
    image,
    command: ["/bin/sh", "-c", SERVER_SCRIPT],
    port: 8080,
    readinessCommand: ["/bin/sh", "-c", "wget -q -T 2 -O /dev/null http://127.0.0.1:8080/marker"],
    replicas: 2,
    vcpu: 0.1,
    memoryMb: 64,
    runAsUser: 1000,
    terminationGracePeriodSeconds: 5,
    volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 1, ...(storageClass ? { storageClass } : {}) }],
    ...over,
  });
  const network = (namespace: string, isolation?: "default-deny") =>
    node({ address: "network/main", kind: "network", spec: { zones: 1, namespace, ...(isolation ? { isolation: { egress: isolation } } : {}) } });
  const ledger = (over: Record<string, unknown> = {}) => stsNode(serverConfig(over));
  const statefulObjects = (over: Record<string, unknown> = {}) => withoutPolicies(renderGraph([network(nsMain), ledger(over)], { environmentId: envMain }).objects);

  const markers: Record<string, string> = {};

  it("rolls out ordered, binds a volume per ordinal and reads back healthy on every check", async () => {
    // The namespace is created by Zenith's own apply; a claim that is NOT Zenith's goes in next, and teardown must leave it alone.
    await apply(envMain, statefulObjects().filter((o) => o.kind === "Namespace"));
    await client.core.createNamespacedPersistentVolumeClaim({
      namespace: nsMain,
      body: { metadata: { name: "foreign-claim", labels: { "app.kubernetes.io/managed-by": "helm" } }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } }, ...(storageClass ? { storageClassName: storageClass } : {}) } },
    });

    await apply(envMain, statefulObjects());
    const r = await rolled(nsMain, "ledger", envMain);
    expect(r.state, r.reason).toBe("complete");

    // OrderedReady: ordinal 1 is created only after ordinal 0 is Ready.
    const p0 = await pod(nsMain, "ledger-0");
    const p1 = await pod(nsMain, "ledger-1");
    expect(time(p1.metadata.creationTimestamp)).toBeGreaterThanOrEqual(readyAt(p0) - 1000);

    const n = ledger();
    const c = ctx(envMain);
    const observation = await drv("k8s:StatefulSet").observe(c, n);
    const runtime = await drv("k8s:StatefulSet").runtime(c, n);
    const verify = await drv("k8s:StatefulSet").verify(c, n, observation, runtime);
    expect(runtime.health, JSON.stringify(runtime)).toBe("healthy");
    expect(runtime.counts).toMatchObject({ desired: 2, ready: 2, claims_expected: 2, claims_bound: 2, ordinals_ready_prefix: 2 });
    expect(runtime.signals).toEqual([]);
    expect(verify.status, JSON.stringify(verify.checks.filter((x: any) => x.passed !== true))).toBe("passed");
    record("statefulset", { ordered: true, readback: "healthy", checks: verify.checks.map((x: any) => x.id) });
  }, 420_000);

  it("keeps data across pod replacement, one volume per ordinal", async () => {
    const m0 = await fetchMarker(nsMain, "ledger-0.ledger");
    const m1 = await fetchMarker(nsMain, "ledger-1.ledger");
    expect(m0.ok, m0.log).toBe(true);
    expect(m1.ok, m1.log).toBe(true);
    expect(m0.log).toMatch(/^boot-.*-ledger-0$/);
    expect(m1.log).toMatch(/^boot-.*-ledger-1$/);
    expect(m0.log).not.toBe(m1.log);
    markers["ledger-0"] = m0.log;
    markers["ledger-1"] = m1.log;

    const oldUid = (await pod(nsMain, "ledger-0")).metadata.uid;
    await client.core.deleteNamespacedPod({ name: "ledger-0", namespace: nsMain });
    await eventually("ledger-0 to be replaced and Ready", async () => {
      const p = await pod(nsMain, "ledger-0").catch(() => undefined);
      return p && p.metadata.uid !== oldUid && p.status?.conditions?.some((x: any) => x.type === "Ready" && x.status === "True") ? p : undefined;
    }, { timeoutMs: 180_000 });
    const again = await fetchMarker(nsMain, "ledger-0.ledger");
    expect(again.log).toBe(markers["ledger-0"]);
    record("persistentData", { survivesPodReplacement: true, perOrdinalVolumes: true });
  }, 360_000);

  it("updates the highest ordinal first, then rolls back the template and leaves the data alone", async () => {
    await apply(envMain, statefulObjects({ env: [{ key: "GENERATION", value: "2" }] }));
    const done = await rolled(nsMain, "ledger", envMain);
    expect(done.state, done.reason).toBe("complete");
    const sts = (await readObject(client, { apiVersion: "apps/v1", kind: "StatefulSet", namespace: nsMain, name: "ledger" })) as any;
    const p0 = await pod(nsMain, "ledger-0");
    const p1 = await pod(nsMain, "ledger-1");
    expect(p0.metadata.labels["controller-revision-hash"]).toBe(sts.status.updateRevision);
    expect(p1.metadata.labels["controller-revision-hash"]).toBe(sts.status.updateRevision);
    // reverse ordinal: ledger-1 was recreated before ledger-0, and ledger-0 only after ledger-1 was Ready again
    expect(time(p1.metadata.creationTimestamp)).toBeLessThanOrEqual(time(p0.metadata.creationTimestamp));
    expect(time(p0.metadata.creationTimestamp)).toBeGreaterThanOrEqual(readyAt(p1) - 1000);

    const rollback = await op("k8s:StatefulSet", "deployment.rollback")(ctx(envMain, { operationId: `op-l7-rollback-${suffix}` }), ledger(), {});
    expect(rollback.ok, rollback.summary).toBe(true);
    expect(rollback.data).toMatchObject({ status: "rolled_back", fromRevision: 2, toRevision: 1 });
    const back = await rolled(nsMain, "ledger", envMain);
    expect(back.state, back.reason).toBe("complete");
    const live = (await readObject(client, { apiVersion: "apps/v1", kind: "StatefulSet", namespace: nsMain, name: "ledger" })) as any;
    const env: { name: string }[] = live.spec.template.spec.containers[0].env ?? [];
    expect(env.some((e) => e.name === "GENERATION")).toBe(false);
    const after = await fetchMarker(nsMain, "ledger-0.ledger");
    expect(after.log).toBe(markers["ledger-0"]);
    record("statefulset", { updateHighestOrdinalFirst: true, rollback: "template restored, volumes unchanged" });
  }, 900_000);

  it("scales through the scale subresource, retains the claims of removed ordinals and reuses them", async () => {
    const up = await op("k8s:StatefulSet", "service.scale")(ctx(envMain, { operationId: `op-l7-up-${suffix}` }), ledger(), { replicas: 3 });
    expect(up.ok, up.summary).toBe(true);
    const grown = await rolled(nsMain, "ledger", envMain);
    expect(grown.state, grown.reason).toBe("complete");
    const claim2 = (await readObject(client, { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: nsMain, name: "data-ledger-2" })) as any;
    expect(claim2.status.phase).toBe("Bound");

    const down = await op("k8s:StatefulSet", "service.scale")(ctx(envMain, { operationId: `op-l7-down-${suffix}` }), ledger(), { replicas: 1 });
    expect(down.ok, down.summary).toBe(true);
    await eventually("ledger-1 and ledger-2 to be gone", async () => (await pod(nsMain, "ledger-1").catch(() => undefined)) || (await pod(nsMain, "ledger-2").catch(() => undefined)) ? undefined : true, { timeoutMs: 180_000 });
    // whenScaled: Retain, so the claims outlive the pods
    for (const claim of ["data-ledger-1", "data-ledger-2"]) {
      expect(await readObject(client, { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: nsMain, name: claim }), claim).toBeDefined();
    }
    const regrown = await op("k8s:StatefulSet", "service.scale")(ctx(envMain, { operationId: `op-l7-regrow-${suffix}` }), ledger(), { replicas: 2 });
    expect(regrown.ok, regrown.summary).toBe(true);
    await eventually("ledger-1 to be Ready again", async () => {
      const p = await pod(nsMain, "ledger-1").catch(() => undefined);
      return p?.status?.conditions?.some((x: any) => x.type === "Ready" && x.status === "True") ? p : undefined;
    }, { timeoutMs: 180_000 });
    const m1 = await fetchMarker(nsMain, "ledger-1.ledger");
    expect(m1.log).toBe(markers["ledger-1"]);
    record("persistentData", { retainedClaimsReusedAfterScaleDown: true });
  }, 900_000);

  /* ------------------------------- snapshot / restore ------------------------------ */

  it("snapshots and restores where the cluster can, and refuses where it cannot", async () => {
    const result = await op("k8s:StatefulSet", "database.snapshot")(ctx(envMain, { operationId: `op-l7-snap-${suffix}` }), ledger(), { waitSeconds: 120 });
    if (result.ok) {
      expect(expectSnapshots, "snapshots worked on a cluster the run said cannot snapshot").not.toBe("0");
      expect(result.data.allReady).toBe(true);
      expect(result.data.consistency).toBe("crash-consistent");
      const snapshot = result.data.snapshots[0].name as string;
      const restored = await op("k8s:StatefulSet", "database.restore")(ctx(envMain, { operationId: `op-l7-restore-${suffix}` }), ledger(), { snapshot, ordinal: 7 });
      expect(restored.ok, restored.summary).toBe(true);
      const claim = (await readObject(client, { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: nsMain, name: "data-ledger-7" })) as any;
      expect(claim.spec.dataSource).toMatchObject({ kind: "VolumeSnapshot", name: snapshot });
      const running = await op("k8s:StatefulSet", "database.restore")(ctx(envMain, { operationId: `op-l7-restore-live-${suffix}` }), ledger(), { snapshot, ordinal: 0 });
      expect(running).toMatchObject({ ok: false, data: { code: "scale_down_first" } });
      record("snapshots", { supported: true, snapshotReady: true, restoredClaim: "data-ledger-7", refusedLiveOrdinal: true });
    } else {
      expect(expectSnapshots, `snapshots were required on this cluster but the operation refused: ${result.summary}`).not.toBe("1");
      expect(result.data.code).toBe("snapshots_unsupported");
      expect(result.data.reasons.length).toBeGreaterThan(0);
      // a refusal creates nothing
      const listing = await listObjects(client, "PersistentVolumeClaim", nsMain);
      expect(listing.items.some((i) => String((i.metadata as any).name).startsWith("data-ledger-7"))).toBe(false);
      record("snapshots", { supported: false, refused: true, reasons: result.data.reasons });
    }
  }, 420_000);

  /* ---------------------------------- CronJobs ------------------------------------ */

  const cronCommand = (script: string) => ["/bin/sh", "-c", script];
  const cron = (address: string, over: Record<string, unknown>) => nativeCronNode({ namespace: nsMain, image, vcpu: 0.1, memoryMb: 64, runAsUser: 1000, ...over }, address);
  const cronObjects = (nodes: ResourceNode[]) => renderGraph([network(nsMain), ...nodes], { environmentId: envMain }).objects.filter((o) => o.kind === "CronJob");

  it("fires on schedule, never overlaps under Forbid, prunes by history limit and reads a failing run as unhealthy", async () => {
    const quick = cron("provider_native/quick", { schedule: "* * * * *", concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 1, command: cronCommand("echo ran-$(hostname)") });
    const slow = cron("provider_native/slow", { schedule: "* * * * *", concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 1, command: cronCommand("sleep 100") });
    const broken = cron("provider_native/broken", { schedule: "* * * * *", concurrencyPolicy: "Forbid", backoffLimit: 0, failedJobsHistoryLimit: 2, command: cronCommand("exit 1") });
    await apply(envMain, cronObjects([quick, slow, broken]));

    const cronState = async (name: string) => (await readObject(client, { apiVersion: "batch/v1", kind: "CronJob", namespace: nsMain, name })) as any;
    const driver = drv("k8s:CronJob");
    const read = async (n: ResourceNode) => {
      const c = ctx(envMain);
      const observation = await driver.observe(c, n);
      const runtime = await driver.runtime(c, n);
      return { observation, runtime, verify: await driver.verify(c, n, observation, runtime) };
    };

    // the schedule fires and a success reads back healthy
    const first = await eventually("quick to succeed once", async () => {
      const s = await cronState("quick");
      return s.status?.lastSuccessfulTime ? s.status.lastSuccessfulTime : undefined;
    }, { timeoutMs: 180_000, intervalMs: 3000 });
    const healthy = await eventually("quick to read healthy", async () => {
      const r = await read(quick);
      return r.runtime.health === "healthy" ? r : undefined;
    }, { timeoutMs: 60_000 });
    expect(healthy.verify.status, JSON.stringify(healthy.verify.checks)).toBe("passed");
    expect(healthy.verify.checks.find((x: any) => x.id === "last_run")?.passed).toBe(true);

    // Forbid: sample the slow job's active runs across more than one scheduled minute
    let maxActive = 0;
    const sampleUntil = Date.now() + 150_000;
    while (Date.now() < sampleUntil) {
      const s = await cronState("slow");
      maxActive = Math.max(maxActive, Array.isArray(s.status?.active) ? s.status.active.length : 0);
      await sleep(5000);
    }
    expect(maxActive, "Forbid allowed two runs to overlap").toBe(1);
    const events = await op("k8s:CronJob", "events.read")(ctx(envMain), slow, { limit: 100 });
    const skipped = (events.data?.events ?? []).some((e: any) => e.reason === "JobAlreadyActive");

    // history limit: after a second success only one finished Job is kept
    await eventually("quick to succeed a second time", async () => {
      const s = await cronState("quick");
      return s.status?.lastSuccessfulTime && s.status.lastSuccessfulTime !== first ? true : undefined;
    }, { timeoutMs: 180_000, intervalMs: 3000 });
    const pruned = await eventually("successful history to be pruned to the limit", async () => {
      const r = await read(quick);
      return r.runtime.counts.jobs_succeeded <= 1 ? r.runtime.counts : undefined;
    }, { timeoutMs: 120_000 });

    // a failing run reads back as unhealthy, with the whitelisted reason
    const failing = await eventually("broken to read unhealthy", async () => {
      const r = await read(broken);
      return r.runtime.health === "unhealthy" ? r : undefined;
    }, { timeoutMs: 240_000, intervalMs: 3000 });
    expect(failing.runtime.signals).toEqual(expect.arrayContaining(["last_run_failed"]));
    expect(failing.verify.checks.find((x: any) => x.id === "last_run")?.passed).toBe(false);
    expect(failing.verify.status).toBe("failed");

    record("cronjob", { scheduleFired: true, forbidSkippedOverlap: skipped, maxConcurrentRuns: maxActive, historyLimitHeld: pruned.jobs_succeeded <= 1, failingRunUnhealthy: true });
    expect(skipped, "no JobAlreadyActive event was seen for the overlapping schedule").toBe(true);
  }, 900_000);

  /* ------------------------------ NetworkPolicy with traffic ----------------------- */

  it("admits exactly the declared path and blocks everything else, on real traffic", async () => {
    const net = network(nsNet, "default-deny");
    const web = serviceNode();
    const serverNode = (name: string) =>
      stsNode(serverConfig({ namespace: nsNet, replicas: 1, readinessCommand: serverConfig().readinessCommand }), `provider_native/${name}`);
    const ledgerNet = serverNode("ledger");
    const audit = serverNode("audit");
    const fw = node({
      address: "firewall/web-to-ledger",
      kind: "firewall",
      dependsOn: ["network/main"],
      spec: { direction: "ingress", protocol: "tcp", port: 8080, source: { address: "service/web" }, target: "provider_native/ledger", capability: "http", description: "web reaches the ledger" },
    });
    const graphCtx = ctxForGraph([net, web, ledgerNet, audit, fw], envNet);
    const netObjects = renderNode(net, graphCtx).objects;
    const workloadObjects = [...renderNode(ledgerNet, graphCtx).objects, ...renderNode(audit, graphCtx).objects];
    const policyObjects = [...netObjects.filter((o) => o.kind === "NetworkPolicy"), ...renderNode(fw, graphCtx).objects];
    expect(policyObjects.map((o) => o.metadata.name).sort()).toEqual([
      "fw-web-to-ledger",
      "fw-web-to-ledger-egress",
      "zenith-allow-dns-egress",
      "zenith-default-deny-egress",
      "zenith-default-deny-ingress",
    ]);

    // CONTROL: namespace and servers, no policy yet. Every client reaches every server and the API.
    await apply(envNet, [...netObjects.filter((o) => o.kind === "Namespace"), ...workloadObjects]);
    for (const name of ["ledger", "audit"]) {
      const r = await rolled(nsNet, name, envNet);
      expect(r.state, `${name}: ${r.reason}`).toBe("complete");
    }
    const as = (name: string): Record<string, string> => ({ [LABEL.name]: name, [LABEL.partOf]: envNet });
    const get = (labels: Record<string, string>, server: string) => probe(nsNet, labels, `wget -q -T 4 -O- http://${server}-0.${server}.${nsNet}.svc.cluster.local:8080/marker`);
    const api = (labels: Record<string, string>) => probe(nsNet, labels, "echo | nc -w 3 kubernetes.default.svc 443");
    const control = {
      webToLedger: (await get(as("web"), "ledger")).ok,
      otherToLedger: (await get(as("other"), "ledger")).ok,
      webToAudit: (await get(as("web"), "audit")).ok,
      webToApi: (await api(as("web"))).ok,
    };
    expect(control, "the control run must connect everywhere, or the later denials prove nothing").toEqual({ webToLedger: true, otherToLedger: true, webToAudit: true, webToApi: true });

    // THE POLICY SET: default-deny ingress and egress, DNS allow, and the declared web -> ledger rule pair.
    await apply(envNet, policyObjects);
    const allowed = await eventually("web -> ledger to connect under policy", async () => ((await get(as("web"), "ledger")).ok ? true : undefined), { timeoutMs: 120_000, intervalMs: 4000 });
    expect(allowed).toBe(true);

    if (!expectNetpol) {
      record("networkPolicy", { enforcement: "not_expected", policiesApplied: policyObjects.length, declaredPathConnects: true });
      return;
    }
    // Enforcement is proven by denial, so retry until the CNI has programmed the rules, and fail if it never does.
    const denied = async (what: string, attempt: () => Promise<{ ok: boolean }>) =>
      eventually(`${what} to be blocked (the CNI has not enforced the policy if this times out)`, async () => ((await attempt()).ok ? undefined : true), { timeoutMs: 180_000, intervalMs: 5000 });
    await denied("an undeclared client reaching ledger", () => get(as("other"), "ledger"));
    await denied("web reaching an undeclared destination (audit)", () => get(as("web"), "audit"));
    await denied("web reaching the API server (egress default-deny)", () => api(as("web")));
    // and the declared path still works after all of that
    expect((await get(as("web"), "ledger")).ok).toBe(true);

    // readback names the engine on a session that may read it
    const reading = await detectPolicyEngine(createK8sClient(policySession, { signal: AbortSignal.timeout(60_000) }));
    const fwDriver = drv("k8s:NetworkPolicy");
    const c = driverCtx(policySession, { environmentId: envNet, workspaceId, signal: signal() } as any);
    const fwNode = { ...fw, spec: { ...(fw.spec as object), namespace: nsNet } } as ResourceNode;
    const obs = await fwDriver.observe(c, fwNode);
    const rt = await fwDriver.runtime(c, fwNode);
    const verify = await fwDriver.verify(c, fwNode, obs, rt);
    expect(obs.presence).toBe("present");
    if (isKind) {
      expect(rt.signals).toEqual([`engine:${reading.engine}`]);
      expect(verify.checks.find((x: any) => x.id === "enforcing_cni")?.passed).toBe(true);
    }
    expect(verify.checks.filter((x: any) => x.passed === false)).toEqual([]);
    record("networkPolicy", {
      enforcement: "proven_by_traffic",
      engine: reading.engine ?? null,
      control,
      declaredPathConnects: true,
      undeclaredClientBlocked: true,
      undeclaredDestinationBlocked: true,
      apiServerEgressBlocked: true,
      policies: policyObjects.map((o) => o.metadata.name).sort(),
    });
  }, 1_200_000);

  /* ----------------------------------- teardown ----------------------------------- */

  it("tears down only what this run owns: retains data first, then deletes it, and leaves a foreign claim", async () => {
    const run = (retainStateful: boolean, dryRun = false) => teardownKubernetesEnvironment({ workspaceId, environmentId: envMain, session, retainStateful, dryRun, signal: AbortSignal.timeout(300_000) });
    const dry = await run(true, true);
    expect(dry.retained).toEqual(expect.arrayContaining([`StatefulSet/${nsMain}/ledger`, `PersistentVolumeClaim/${nsMain}/data-ledger-0`, `PersistentVolumeClaim/${nsMain}/data-ledger-1`]));
    expect(JSON.stringify(dry)).not.toContain("foreign-claim");

    const kept = await run(true);
    expect(kept.uncertain).toEqual([]);
    expect(kept.retained).toEqual(expect.arrayContaining([`StatefulSet/${nsMain}/ledger`, `PersistentVolumeClaim/${nsMain}/data-ledger-0`]));
    expect(await readObject(client, { apiVersion: "apps/v1", kind: "StatefulSet", namespace: nsMain, name: "ledger" })).toBeDefined();

    // Deleting stateful data: the StatefulSet goes, then its claims. PVC protection holds a claim until its
    // pod is gone, so the first call may report it uncertain; the review is repeated until it is clean.
    await run(false);
    const clean = await eventually("the environment to tear down completely", async () => {
      const report = await run(false);
      return report.uncertain.length === 0 && report.deleted.length === 0 ? report : undefined;
    }, { timeoutMs: 300_000, intervalMs: 5000 });
    expect(clean.retained).toEqual([`Namespace//${nsMain}`]);
    const claims = await listObjects(client, "PersistentVolumeClaim", nsMain);
    expect(claims.items.map((i) => (i.metadata as any).name)).toEqual(["foreign-claim"]);
    const survivor = (await readObject(client, { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: nsMain, name: "foreign-claim" })) as any;
    expect(survivor.metadata.annotations?.[ANNOTATION.environment]).toBeUndefined();
    record("teardown", { retainedDataFirst: true, deletedOnlyOwned: true, foreignClaimUntouched: true, namespaceRetainedByTeardown: true });
  }, 900_000);
});
