/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-LIFE-07 rendering: native StatefulSet and CronJob, CronJob policy on the
 * portable job, and the default-deny NetworkPolicy set. Pure; no cluster.
 */
import { describe, expect, it } from "vitest";
import { renderGraph, renderNode } from "@/lib/providers/kubernetes/render";
import { ANNOTATION, LABEL, type K8sObject } from "@/lib/providers/kubernetes/types";
import { workloadExpectations } from "@/lib/providers/kubernetes/renderers/workload";
import { cronExpectations, statefulExpectations } from "@/lib/providers/kubernetes/renderers/stateful";
import { ENV_ID, NS, cronNode, ctxFor, dbNode, firewallToDb, networkNode, node, publicFirewall, serviceNode } from "./helpers";
import { PINNED_IMAGE, isolatedNetwork, nativeCronNode, stsNode } from "./lifecycle-support";

const of = (objects: K8sObject[], kind: string): K8sObject => objects.find((o) => o.kind === kind) as K8sObject;
const names = (objects: K8sObject[]) => objects.map((o) => `${o.kind}/${o.metadata.name}`).sort();

describe("native k8s:StatefulSet", () => {
  const sts = stsNode();
  const r = renderNode(sts, ctxFor([networkNode(), sts]));
  const set = of(r.objects, "StatefulSet");
  const spec = set.spec as any;
  const pod = spec.template.spec;

  it("renders a headless Service and the StatefulSet in the network's namespace, owned by the node", () => {
    expect(names(r.objects)).toEqual(["Service/ledger", "StatefulSet/ledger"]);
    for (const o of r.objects) {
      expect(o.metadata.namespace).toBe(NS);
      expect(o.metadata.labels?.[LABEL.managedBy]).toBe("zenith");
      expect(o.metadata.annotations?.[ANNOTATION.resource]).toBe("provider_native/ledger");
      expect(o.metadata.annotations?.[ANNOTATION.environment]).toBe(ENV_ID);
    }
    const svc = of(r.objects, "Service").spec as any;
    expect(svc.clusterIP).toBe("None");
    expect(svc.selector).toEqual(spec.selector.matchLabels);
    expect(spec.serviceName).toBe("ledger");
  });

  it("renders ordered rollout and out-loud retention instead of cluster defaults", () => {
    expect(spec.replicas).toBe(2);
    expect(spec.podManagementPolicy).toBe("OrderedReady");
    expect(spec.updateStrategy).toEqual({ type: "RollingUpdate", rollingUpdate: { partition: 0 } });
    expect(spec.revisionHistoryLimit).toBe(10);
    expect(spec.persistentVolumeClaimRetentionPolicy).toEqual({ whenDeleted: "Retain", whenScaled: "Retain" });
  });

  it("gives the claim template ownership marks (so the controller's PVCs are owned) but no spec digest (it is immutable)", () => {
    const [tpl] = spec.volumeClaimTemplates;
    expect(tpl.metadata.name).toBe("data");
    expect(tpl.spec).toEqual({ accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } });
    expect(tpl.metadata.labels[LABEL.managedBy]).toBe("zenith");
    expect(tpl.metadata.labels[LABEL.partOf]).toBe(ENV_ID);
    expect(tpl.metadata.annotations).toEqual({ [ANNOTATION.resource]: "provider_native/ledger", [ANNOTATION.environment]: ENV_ID });
    expect(tpl.metadata.annotations[ANNOTATION.specDigest]).toBeUndefined();
  });

  it("keeps the template stable when unrelated spec fields change", () => {
    const a = renderNode(stsNode({ replicas: 2 }), ctxFor([networkNode(), stsNode({ replicas: 2 })]));
    const bNode = stsNode({ replicas: 5, memoryMb: 512 });
    const b = renderNode(bNode, ctxFor([networkNode(), bNode]));
    expect((of(a.objects, "StatefulSet").spec as any).volumeClaimTemplates).toEqual((of(b.objects, "StatefulSet").spec as any).volumeClaimTemplates);
  });

  it("mounts every claim, hardens the pod and lets a non-root image write its volume", () => {
    const c = pod.containers[0];
    expect(c.volumeMounts).toEqual([{ name: "data", mountPath: "/data" }, { name: "tmp", mountPath: "/tmp" }]);
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } });
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, fsGroupChangePolicy: "OnRootMismatch", seccompProfile: { type: "RuntimeDefault" } });
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.terminationGracePeriodSeconds).toBe(30);
    expect(c.image).toBe(PINNED_IMAGE);
    expect(c.readinessProbe).toMatchObject({ tcpSocket: { port: "http" } });
  });

  it("is deterministic", () => {
    const again = renderNode(stsNode(), ctxFor([networkNode(), stsNode()]));
    expect(JSON.stringify(again.objects)).toBe(JSON.stringify(r.objects));
  });

  it("stages a rollout with a partition and says so", () => {
    const n = stsNode({ rollout: { partition: 1, minReadySeconds: 10 } });
    const staged = renderNode(n, ctxFor([networkNode(), n]));
    const s = of(staged.objects, "StatefulSet").spec as any;
    expect(s.updateStrategy.rollingUpdate.partition).toBe(1);
    expect(s.minReadySeconds).toBe(10);
    expect(staged.notes.join("\n")).toMatch(/stages the rollout/);
  });

  it("refuses a Delete retention policy unless data loss is acknowledged, and then says the cluster deletes the data", () => {
    const risky = stsNode({ retention: { whenDeleted: "Delete" } });
    expect(() => renderNode(risky, ctxFor([networkNode(), risky]))).toThrow(/acknowledgeDataLoss/);
    const scaled = stsNode({ retention: { whenScaled: "Delete" } });
    expect(() => renderNode(scaled, ctxFor([networkNode(), scaled]))).toThrow(/acknowledgeDataLoss/);
    const ok = stsNode({ retention: { whenDeleted: "Delete", whenScaled: "Retain", acknowledgeDataLoss: true } });
    const rr = renderNode(ok, ctxFor([networkNode(), ok]));
    expect((of(rr.objects, "StatefulSet").spec as any).persistentVolumeClaimRetentionPolicy).toEqual({ whenDeleted: "Delete", whenScaled: "Retain" });
    expect(rr.notes.join("\n")).toMatch(/removes the claims, and their data/);
  });

  it.each([
    ["an unknown key", { surprise: true }, /surprise|unrecognized/i],
    ["no claims", { volumeClaims: [] }, /volumeClaims/],
    ["a duplicate claim", { volumeClaims: [{ name: "data", mountPath: "/a", sizeGb: 1 }, { name: "data", mountPath: "/b", sizeGb: 1 }] }, /duplicate/],
    ["a shared mount path", { volumeClaims: [{ name: "a", mountPath: "/d", sizeGb: 1 }, { name: "b", mountPath: "/d", sizeGb: 1 }] }, /used twice/],
    ["the reserved /tmp", { volumeClaims: [{ name: "a", mountPath: "/tmp", sizeGb: 1 }] }, /mountPath/],
    ["a path escape", { volumeClaims: [{ name: "a", mountPath: "/data/../etc", sizeGb: 1 }] }, /mountPath/],
    ["healthPath without a port", { port: undefined, healthPath: "/healthz" }, /healthPath needs a port/],
    ["both probes", { healthPath: "/h", readinessCommand: ["true"] }, /not both/],
    ["running as root", { runAsUser: 0 }, /runAsUser/],
    ["a single revision kept", { rollout: { revisionHistoryLimit: 1 } }, /revisionHistoryLimit/],
    ["a tag containing a space", { image: "bad image" }, /image/],
  ])("refuses %s", (_label, over, pattern) => {
    const n = stsNode(over as Record<string, unknown>);
    expect(() => renderNode(n, ctxFor([networkNode(), n]))).toThrow(pattern);
  });

  it("is a customer-cluster type: the managed zenith provider has no registration and refuses it", () => {
    const managed = { ...stsNode(), provider: "zenith" as const };
    expect(() => renderNode(managed, ctxFor([managed]))).toThrow(/Unknown native type/);
  });

  it("refuses a native type it has no renderer for", () => {
    const hpa = node({ address: "provider_native/scaler", kind: "provider_native", nativeType: "k8s:HorizontalPodAutoscaler", spec: { type: "k8s:HorizontalPodAutoscaler", config: { target: "web", minReplicas: 1, maxReplicas: 2 } } });
    expect(() => renderNode(hpa, ctxFor([hpa]))).toThrow(/no Kubernetes renderer/);
  });

  it("renders alongside the rest of an environment in apply order, with no separate PVC objects", () => {
    const graph = renderGraph([networkNode(), stsNode(), serviceNode()], { environmentId: ENV_ID });
    expect(graph.objects.map((o) => o.kind)).toEqual(["Namespace", "NetworkPolicy", "Service", "Service", "StatefulSet", "Deployment"]);
    expect(graph.objects.some((o) => o.kind === "PersistentVolumeClaim")).toBe(false);
  });

  it("expresses what observe compares in the units the driver reads", () => {
    expect(statefulExpectations(sts)).toEqual({
      managedByZenith: true,
      replicas: 2,
      image: PINNED_IMAGE,
      pvcRetentionWhenDeleted: "Retain",
      pvcRetentionWhenScaled: "Retain",
      podManagementPolicy: "OrderedReady",
      partition: 0,
      volumeClaims: ["data:5Gi"],
    });
  });

  it("can be the target of a firewall (its pods carry the selector labels)", () => {
    const fw = node({
      address: "firewall/web-to-ledger",
      kind: "firewall",
      dependsOn: ["network/main"],
      spec: { direction: "ingress", protocol: "tcp", port: 5000, source: { address: "service/web" }, target: "provider_native/ledger", capability: "postgres", description: "web reaches the ledger" },
    });
    const nodes = [networkNode(), serviceNode(), sts, fw];
    const np = renderNode(fw, ctxFor(nodes)).objects[0];
    expect((np.spec as any).podSelector.matchLabels).toEqual({ [LABEL.name]: "ledger", [LABEL.partOf]: ENV_ID });
    expect((np.spec as any).ingress[0].ports).toEqual([{ protocol: "TCP", port: 5000 }]);
  });
});

describe("CronJob policy", () => {
  const render = (n: ReturnType<typeof cronNode>) => renderNode(n, ctxFor([networkNode(), n]));
  const cron = (r: { objects: K8sObject[] }) => of(r.objects, "CronJob").spec as any;

  it("keeps the defaults the portable job always had", () => {
    const s = cron(render(cronNode()));
    expect(s).toMatchObject({ concurrencyPolicy: "Forbid", startingDeadlineSeconds: 300, successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 3 });
    expect(s.jobTemplate.spec).toMatchObject({ backoffLimit: 2, ttlSecondsAfterFinished: 86400 });
    expect(s.timeZone).toBeUndefined();
  });

  it("renders an explicit concurrency policy, history limits, deadline and time zone for the portable job", () => {
    const s = cron(render(cronNode({ cronPolicy: { concurrencyPolicy: "Replace", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 5, startingDeadlineSeconds: 120, timeZone: "Europe/Paris" } })));
    expect(s).toMatchObject({ concurrencyPolicy: "Replace", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 5, startingDeadlineSeconds: 120, timeZone: "Europe/Paris" });
  });

  it("labels the Jobs it creates with the ownership selector, so readback can list exactly its runs", () => {
    const s = cron(render(cronNode()));
    expect(s.jobTemplate.metadata.labels).toEqual({ [LABEL.name]: "nightly", [LABEL.partOf]: ENV_ID, [LABEL.managedBy]: "zenith", [LABEL.component]: "job" });
  });

  it.each([
    ["a bad policy", { concurrencyPolicy: "Sometimes" }, /concurrencyPolicy/],
    ["a negative history", { successfulJobsHistoryLimit: -1 }, /successfulJobsHistoryLimit/],
    ["an unknown setting", { retries: 3 }, /not a recognised setting/],
    ["a bad zone", { timeZone: "not a zone" }, /time zone/],
    ["a non-integer deadline", { startingDeadlineSeconds: 12.5 }, /startingDeadlineSeconds/],
  ])("refuses %s", (_l, policy, pattern) => {
    expect(() => render(cronNode({ cronPolicy: policy }))).toThrow(pattern);
  });

  it("warns about overlapping and replacing runs", () => {
    expect(render(cronNode({ cronPolicy: { concurrencyPolicy: "Allow" } })).notes.join("\n")).toMatch(/overlap/);
    expect(render(cronNode({ cronPolicy: { concurrencyPolicy: "Replace" } })).notes.join("\n")).toMatch(/cancels/);
  });

  it("renders the native k8s:CronJob with every knob, suspended on request", () => {
    const n = nativeCronNode({ concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 2, failedJobsHistoryLimit: 4, activeDeadlineSeconds: 600, suspend: true, command: ["/bin/sh"], args: ["-c", "true"] });
    const r = renderNode(n, ctxFor([networkNode(), n]));
    const s = cron(r);
    expect(s).toMatchObject({ schedule: "*/5 * * * *", suspend: true, concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 2, failedJobsHistoryLimit: 4 });
    expect(s.jobTemplate.spec.activeDeadlineSeconds).toBe(600);
    expect(s.jobTemplate.spec.template.spec.containers[0]).toMatchObject({ name: "job", image: PINNED_IMAGE, command: ["/bin/sh"], args: ["-c", "true"] });
    expect(of(r.objects, "CronJob").metadata.name).toBe("sweeper");
    expect(cronExpectations(n)).toMatchObject({ schedule: "*/5 * * * *", suspend: true, concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 2, failedJobsHistoryLimit: 4 });
  });

  it("expects the policy it renders from the portable job too", () => {
    expect(workloadExpectations(cronNode({ cronPolicy: { concurrencyPolicy: "Allow", failedJobsHistoryLimit: 7 } }))).toMatchObject({ concurrencyPolicy: "Allow", successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 7 });
  });

  it("refuses a native schedule that is not cron and an unknown native key", () => {
    const bad = nativeCronNode({ schedule: "every tuesday" });
    expect(() => renderNode(bad, ctxFor([networkNode(), bad]))).toThrow(/not a cron expression/);
    const typo = nativeCronNode({ concurency: "Forbid" });
    expect(() => renderNode(typo, ctxFor([networkNode(), typo]))).toThrow(/concurency|unrecognized/i);
  });
});

describe("NetworkPolicy generation", () => {
  const web = serviceNode();
  const db = dbNode();

  it("keeps egress open and renders only the ingress default-deny when isolation is not asked for", () => {
    const r = renderNode(networkNode(), ctxFor([networkNode()]));
    expect(names(r.objects)).toEqual(["Namespace/shop", "NetworkPolicy/zenith-default-deny-ingress"]);
    expect(renderNode(firewallToDb(), ctxFor([networkNode(), web, db, firewallToDb()])).objects.map((o) => o.metadata.name)).toEqual(["fw-web-to-db"]);
  });

  it("adds default-deny egress and a DNS allow when the namespace asks for isolation", () => {
    const r = renderNode(isolatedNetwork(), ctxFor([isolatedNetwork()]));
    expect(names(r.objects)).toEqual([
      "Namespace/shop",
      "NetworkPolicy/zenith-allow-dns-egress",
      "NetworkPolicy/zenith-default-deny-egress",
      "NetworkPolicy/zenith-default-deny-ingress",
    ]);
    const deny = r.objects.find((o) => o.metadata.name === "zenith-default-deny-egress")!.spec as any;
    expect(deny).toEqual({ podSelector: {}, policyTypes: ["Egress"] });
    const dns = r.objects.find((o) => o.metadata.name === "zenith-allow-dns-egress")!.spec as any;
    expect(dns.policyTypes).toEqual(["Egress"]);
    expect(dns.egress).toEqual([
      {
        to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
        ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
      },
    ]);
    expect(r.notes.join("\n")).toMatch(/default-deny with DNS allowed/);
  });

  it("lets the DNS location be configured", () => {
    const r = renderNode(isolatedNetwork(), ctxFor([isolatedNetwork()], { dns: { namespace: "dns-system", podLabels: { app: "coredns" } } }));
    const dns = r.objects.find((o) => o.metadata.name === "zenith-allow-dns-egress")!.spec as any;
    expect(dns.egress[0].to[0]).toEqual({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "dns-system" } }, podSelector: { matchLabels: { app: "coredns" } } });
  });

  it("renders the matching egress allow for a declared dependency, and nothing wider", () => {
    const nodes = [isolatedNetwork(), web, db, firewallToDb()];
    const r = renderNode(firewallToDb(), ctxFor(nodes));
    expect(r.objects.map((o) => o.metadata.name)).toEqual(["fw-web-to-db", "fw-web-to-db-egress"]);
    const [ingress, egress] = r.objects;
    expect((ingress.spec as any).policyTypes).toEqual(["Ingress"]);
    expect(egress.metadata.namespace).toBe(NS);
    expect(egress.spec).toEqual({
      podSelector: { matchLabels: { [LABEL.name]: "web", [LABEL.partOf]: ENV_ID } },
      policyTypes: ["Egress"],
      egress: [{ to: [{ podSelector: { matchLabels: { [LABEL.name]: "db", [LABEL.partOf]: ENV_ID } } }], ports: [{ protocol: "TCP", port: 5432 }] }],
    });
    for (const o of r.objects) expect(o.metadata.annotations?.[ANNOTATION.resource]).toBe("firewall/web-to-db");
  });

  it("renders no egress policy for a public source (the controller is not governed by this namespace)", () => {
    const lb = node({ address: "load_balancer/public", kind: "load_balancer", dependsOn: ["network/main", "service/web"], spec: { scheme: "internet-facing", tier: "public", listeners: [], routes: [{ host: "a.example.com", pathPrefix: "/", tls: false, target: "service/web", port: 8080 }], ingressClass: "nginx" } });
    const r = renderNode(publicFirewall(), ctxFor([isolatedNetwork(), web, lb, publicFirewall()]));
    expect(r.objects).toHaveLength(1);
  });

  it("does not isolate another namespace's pods", () => {
    const other = node({ address: "network/other", kind: "network", spec: { zones: 1, namespace: "elsewhere" } });
    const w = { ...web, dependsOn: ["network/other"] };
    const d = { ...db, dependsOn: ["network/other"] };
    const fw = { ...firewallToDb(), dependsOn: ["network/other"] };
    const r = renderNode(fw, ctxFor([isolatedNetwork(), other, w, d, fw]));
    expect(r.objects.map((o) => o.metadata.name)).toEqual(["fw-web-to-db"]);
  });

  it("refuses an isolation value it does not know", () => {
    const bad = node({ address: "network/main", kind: "network", spec: { zones: 1, namespace: NS, isolation: { egress: "allow-some" } } });
    expect(() => renderNode(bad, ctxFor([bad]))).toThrow(/isolation\.egress/);
  });

  it("applies the whole set in dependency order, policies before workloads", () => {
    const g = renderGraph([isolatedNetwork(), web, db, firewallToDb()], { environmentId: ENV_ID });
    const kinds = g.objects.map((o) => o.kind);
    expect(kinds.lastIndexOf("NetworkPolicy")).toBeLessThan(kinds.indexOf("StatefulSet"));
    expect(g.objects.filter((o) => o.kind === "NetworkPolicy")).toHaveLength(5);
  });
});
