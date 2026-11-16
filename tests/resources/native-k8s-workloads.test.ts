/**
 * PROD-LIFE-07 manifest surface: the native k8s:StatefulSet and k8s:CronJob types,
 * Kubernetes egress isolation and CronJob policy in providerConfig. Pure
 * expansion; the rendering and cluster behaviour are in tests/providers/kubernetes.
 */
import { describe, expect, it } from "vitest";
import {
  expandManifest,
  findNativeType,
  listNativeTypes,
  ManifestExpansionError,
  parseManifest,
  parseNativeConfig,
  upgradeManifest,
  type ExpandEnv,
  type ManifestV2,
  type ResourceGraph,
  type ResourceNode,
} from "@/lib/resources";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { PROD, graphProblems, manifest, svc, webDb } from "./_fixtures";

const K8S: ExpandEnv = { ...PROD, provider: "kubernetes", region: "kind-local" };
const IMAGE = `registry.example.com/acme/store@sha256:${"c".repeat(64)}`;
const node = (g: ResourceGraph, address: string): ResourceNode => {
  const n = g.nodes.find((x) => x.address === address);
  if (!n) throw new Error(`no node ${address}; have ${g.nodes.map((x) => x.address).join(", ")}`);
  return n;
};
const v2 = (m: ReturnType<typeof webDb>, extra: Partial<ManifestV2> = {}): ManifestV2 => ({ ...upgradeManifest(m, { provider: "kubernetes", region: "kind-local" }), ...extra });
interface NativeEntry {
  id: string;
  provider: "kubernetes";
  type: string;
  config: Record<string, unknown>;
}
const stsEntry = (config: Record<string, unknown> = {}): NativeEntry => ({
  id: "ledger",
  provider: "kubernetes",
  type: "k8s:StatefulSet",
  config: { namespace: "acme", image: IMAGE, vcpu: 0.25, memoryMb: 256, replicas: 3, port: 5000, runAsUser: 1000, volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 20 }], ...config },
});
const cronEntry = (config: Record<string, unknown> = {}): NativeEntry => ({
  id: "sweeper",
  provider: "kubernetes",
  type: "k8s:CronJob",
  config: { namespace: "acme", image: IMAGE, vcpu: 0.1, memoryMb: 64, schedule: "*/10 * * * *", runAsUser: 1000, ...config },
});

describe("native k8s:StatefulSet and k8s:CronJob registration", () => {
  it("are registered for customer clusters only, with strict schemas", () => {
    expect(listNativeTypes("kubernetes").map((e) => e.type)).toEqual(expect.arrayContaining(["k8s:StatefulSet", "k8s:CronJob", "k8s:HorizontalPodAutoscaler"]));
    const managed = listNativeTypes("zenith").map((e) => e.type);
    expect(managed).not.toContain("k8s:StatefulSet");
    expect(managed).not.toContain("k8s:CronJob");
    expect(findNativeType("kubernetes", "k8s:StatefulSet")?.description).toMatch(/ordered rollout/);
  });

  it("applies the defaults the renderer relies on", () => {
    const parsed = parseNativeConfig("kubernetes", "k8s:StatefulSet", stsEntry().config);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config).toMatchObject({
      replicas: 3,
      retention: { whenDeleted: "Retain", whenScaled: "Retain" },
      rollout: { partition: 0, minReadySeconds: 0, podManagementPolicy: "OrderedReady", revisionHistoryLimit: 10 },
      terminationGracePeriodSeconds: 30,
    });
  });

  it.each([
    ["no claims", { volumeClaims: [] }, /volumeClaims/],
    ["data-destroying retention without acknowledgement", { retention: { whenScaled: "Delete" } }, /acknowledgeDataLoss/],
    ["an unknown key", { nodeSelector: { disk: "ssd" } }, /nodeSelector|Unrecognized/i],
    ["a claim that is not a DNS label", { volumeClaims: [{ name: "Data_1", mountPath: "/d", sizeGb: 1 }] }, /volumeClaims/],
    ["a claim larger than the cap", { volumeClaims: [{ name: "data", mountPath: "/d", sizeGb: 99999 }] }, /sizeGb/],
    ["root", { runAsUser: 0 }, /runAsUser/],
  ])("refuses %s", (_label, over, pattern) => {
    const parsed = parseNativeConfig("kubernetes", "k8s:StatefulSet", stsEntry(over as Record<string, unknown>).config);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.message).join("\n") + parsed.issues.map((i) => i.path.join(".")).join("\n")).toMatch(pattern);
  });

  it("refuses a CronJob with an out-of-range policy or an unknown key", () => {
    expect(parseNativeConfig("kubernetes", "k8s:CronJob", cronEntry({ concurrencyPolicy: "Sometimes" }).config).ok).toBe(false);
    expect(parseNativeConfig("kubernetes", "k8s:CronJob", cronEntry({ failedJobsHistoryLimit: 1000 }).config).ok).toBe(false);
    expect(parseNativeConfig("kubernetes", "k8s:CronJob", cronEntry({ retries: 3 }).config).ok).toBe(false);
    expect(parseNativeConfig("kubernetes", "k8s:CronJob", cronEntry({ concurrencyPolicy: "Replace", timeZone: "Europe/Paris" }).config).ok).toBe(true);
  });
});

describe("native entries in a manifest", () => {
  const withNatives = (...natives: NativeEntry[]) => expandManifest(v2(webDb(), { native: natives, providerConfig: { kubernetes: { namespace: "acme" } } }), K8S);

  it("expand into provider_native nodes whose config carries the parsed defaults", () => {
    const g = withNatives(stsEntry(), cronEntry());
    const sts = node(g, "provider_native/ledger");
    expect(sts).toMatchObject({ kind: "provider_native", nativeType: "k8s:StatefulSet", provider: "kubernetes" });
    expect((sts.spec as { config: Record<string, unknown> }).config).toMatchObject({ replicas: 3, retention: { whenDeleted: "Retain" } });
    expect(node(g, "provider_native/sweeper").nativeType).toBe("k8s:CronJob");
    expect(graphProblems(g)).toEqual([]);
  });

  it("render through the Kubernetes provider into a StatefulSet, a headless Service and a CronJob", () => {
    const g = withNatives(stsEntry(), cronEntry());
    const nodes = [node(g, "network/main"), node(g, "provider_native/ledger"), node(g, "provider_native/sweeper")];
    const { objects } = renderGraph(nodes, { environmentId: PROD.id });
    expect(objects.map((o) => `${o.kind}/${o.metadata.name}`)).toEqual([
      "Namespace/acme",
      "NetworkPolicy/zenith-default-deny-ingress",
      "Service/ledger",
      "StatefulSet/ledger",
      "CronJob/sweeper",
    ]);
    const sts = objects.find((o) => o.kind === "StatefulSet")!;
    expect((sts.spec as { volumeClaimTemplates: { spec: { resources: { requests: { storage: string } } } }[] }).volumeClaimTemplates[0].spec.resources.requests.storage).toBe("20Gi");
  });

  it("are refused at expansion, with the reason, when the config is wrong", () => {
    expect(() => withNatives(stsEntry({ retention: { whenDeleted: "Delete" } }))).toThrow(ManifestExpansionError);
    expect(() => withNatives(stsEntry({ retention: { whenDeleted: "Delete" } }))).toThrow(/acknowledgeDataLoss/);
    expect(() => withNatives(stsEntry({ surprise: 1 }))).toThrow(/native "ledger"/);
  });

  it("are not available on the managed zenith provider", () => {
    const managed: ExpandEnv = { ...PROD, provider: "zenith", region: "zenith-1" };
    const entry = { ...stsEntry(), provider: "zenith" as const };
    expect(() => expandManifest({ ...upgradeManifest(webDb(), { provider: "zenith", region: "zenith-1" }), native: [entry] }, managed)).toThrow(/Unknown native type/);
  });
});

describe("providerConfig.kubernetes", () => {
  it("accepts egress isolation and a CronJob policy, and rejects anything else", () => {
    const ok = parseManifest({ version: 2, providerConfig: { kubernetes: { egress: "default-deny", cronJob: { concurrencyPolicy: "Forbid", failedJobsHistoryLimit: 5, timeZone: "Asia/Kolkata" } } } });
    expect(ok.ok).toBe(true);
    for (const bad of [{ egress: "some" }, { cronJob: { concurrencyPolicy: "Maybe" } }, { cronJob: { retries: 1 } }, { cronJob: { timeZone: "not a zone" } }, { cronJob: { successfulJobsHistoryLimit: -1 } }]) {
      expect(parseManifest({ version: 2, providerConfig: { kubernetes: bad } }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("puts egress isolation on the namespace node, and nothing when it is not asked for", () => {
    const isolated = expandManifest(v2(webDb(), { providerConfig: { kubernetes: { namespace: "acme", egress: "default-deny" } } }), K8S);
    expect(node(isolated, "network/main").spec).toEqual({ namespace: "acme", zones: 2, isolation: { egress: "default-deny" } });
    const plain = expandManifest(v2(webDb(), { providerConfig: { kubernetes: { namespace: "acme" } } }), K8S);
    expect(node(plain, "network/main").spec).toEqual({ namespace: "acme", zones: 2 });
    const open = expandManifest(v2(webDb(), { providerConfig: { kubernetes: { namespace: "acme", egress: "open" } } }), K8S);
    expect(node(open, "network/main").spec).toEqual({ namespace: "acme", zones: 2, isolation: { egress: "open" } });
  });

  it("does not put isolation on the managed provider's namespace, which has its own baseline", () => {
    const managed: ExpandEnv = { ...PROD, provider: "zenith", region: "zenith-1" };
    const g = expandManifest({ ...upgradeManifest(webDb(), { provider: "zenith", region: "zenith-1" }), providerConfig: { kubernetes: { egress: "default-deny" } } }, managed);
    expect((node(g, "network/main").spec as { isolation?: unknown }).isolation).toBeUndefined();
  });

  it("carries the CronJob policy onto every scheduled job, and leaves jobs alone when it is absent", () => {
    const m = manifest({ services: [svc({ id: "svc-n", name: "nightly", kind: "cron", schedule: "0 3 * * *" })] });
    const policy = { concurrencyPolicy: "Replace" as const, successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 5, timeZone: "Europe/Paris" };
    const withPolicy = expandManifest(v2(m, { providerConfig: { kubernetes: { cronJob: policy } } }), K8S);
    expect((node(withPolicy, "scheduled_job/nightly").spec as { cronPolicy?: unknown }).cronPolicy).toEqual(policy);
    const without = expandManifest(v2(m), K8S);
    expect((node(without, "scheduled_job/nightly").spec as { cronPolicy?: unknown }).cronPolicy).toBeUndefined();
    const { objects } = renderGraph([node(withPolicy, "network/main"), node(withPolicy, "scheduled_job/nightly")], { environmentId: PROD.id });
    expect(objects.find((o) => o.kind === "CronJob")?.spec).toMatchObject({ concurrencyPolicy: "Replace", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 5, timeZone: "Europe/Paris" });
  });
});
