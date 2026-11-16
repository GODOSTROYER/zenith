/* eslint-disable @typescript-eslint/no-explicit-any */
/** Real kind/Docker runtime evaluation. Never runs on the Windows builder. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderTenancy, tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { readSubstrateConfig } from "@/lib/providers/zenith/substrate";
import { renderIsolationBundle } from "@/lib/providers/zenith/isolation-bundle";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import { Kube, eventually, randomSuffix, reach, restrictedPod, runPod, startPod } from "./support";

const enabled = process.env.ZENITH_TEST_GVISOR_RUNTIME === "1";
const image = process.env.ZENITH_TEST_K8S_IMAGE ?? "";
const runtimeClassName = "zenith-gvisor";
const timeout = 240_000;

describe.skipIf(!enabled)("J14 gVisor runtime on two real kind tenants (needs Docker/kind)", () => {
  const kube = new Kube(process.env.KUBECONFIG ?? "");
  const run = randomSuffix();
  const label = "zenith.dev/j14-runtime-run";
  const gw = `zenith-iso-gw-${run}`;
  const tenants: ZenithTenant[] = ["a", "b"].map((id) => ({ workspaceId: `ws-j14-${id}-${run}`, environmentId: `env-j14-${id}-${run}`, workspaceSlug: `j14${id}`, environmentSlug: "prod", planTier: "starter" }));
  const namespaces = tenants.map((t) => tenantNamespace(t.workspaceId, t.environmentId));
  const ips: string[] = [];
  let targetValidated = false;
  const receipt: Record<string, unknown> = { requirement: "PROD-MAN-04", startedAt: new Date().toISOString(), checks: {} };
  const checks = receipt.checks as Record<string, unknown>;
  const apply = (items: object[]) => { const r = kube.apply(items); expect(r.code, r.stderr).toBe(0); };
  const resources = { requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "32Mi" }, limits: { cpu: "200m", memory: "128Mi", "ephemeral-storage": "64Mi" } };
  const host = (node: string, args: string[]) => {
    expect(node).toMatch(/^zenith-life07-[a-z0-9]{1,20}-(control-plane|worker)[0-9]*$/);
    const r = spawnSync("docker", ["exec", node, ...args], { encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  beforeAll(async () => {
    expect(process.env.KUBECONFIG, "an explicit disposable kubeconfig is required").toBeTruthy();
    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
    const context = kube.contextName();
    expect(context).toMatch(/^kind-zenith-life07-[a-z0-9]{1,20}$/);
    targetValidated = true;
    receipt.context = context;
    expect(kube.json<any>(["get", "runtimeclass", runtimeClassName])?.handler).toBe("runsc");
    const ds = kube.json<any>(["get", "daemonsets", "-A"]);
    expect(ds?.items.some((d: any) => d.metadata.name === "cilium"), "the FQDN-enforcing CNI must exist").toBe(true);
    const cfg = readSubstrateConfig({ ZENITH_MANAGED_CLUSTER_SERVER: "https://kubernetes.invalid:6443", ZENITH_MANAGED_KUBECONFIG_REF: "vault:j14/contract", ZENITH_MANAGED_APP_DOMAIN: "apps.isolation.test", ZENITH_MANAGED_GATEWAY_NAMESPACE: gw, ZENITH_MANAGED_FQDN_ENGINE: "cilium", ZENITH_MANAGED_RUNTIME_CLASS: runtimeClassName });
    if (!cfg.configured) throw new Error(cfg.message);
    apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: gw, labels: { [label]: run } } }]);
    for (const tenant of tenants) {
      const baseline = renderTenancy(tenant, cfg.substrate);
      apply(baseline.objects.map((o) => ({ ...o, metadata: { ...o.metadata, labels: { ...o.metadata.labels, [label]: run } } })));
      apply(renderIsolationBundle(tenant, cfg.substrate).fqdnEgress);
      const pod = await startPod(kube, { name: "victim", namespace: baseline.namespace, image, runtimeClassName, resources, script: "mkdir -p /tmp/www; echo tenant > /tmp/www/index.html; exec httpd -f -p 8080 -h /tmp/www" });
      ips.push(pod.ip);
    }
  }, timeout);

  afterAll(() => {
    if (!targetValidated) return;
    // Cleanup only resources carrying this run's unique marker; even setup failure cannot delete another namespace.
    const cleanup = kube.run(["delete", "namespace", "-l", `${label}=${run}`, "--ignore-not-found", "--wait=true", "--timeout=120s"]);
    receipt.cleanup = { code: cleanup.code };
    receipt.finishedAt = new Date().toISOString();
    const out = process.env.ZENITH_TEST_GVISOR_EVIDENCE_OUT;
    if (out) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`); }
    expect(cleanup.code, cleanup.stderr).toBe(0);
  }, timeout);

  it("independently reads containerd's actual runsc runtime for BOTH tenant workloads", () => {
    checks.runtime = namespaces.map((ns) => {
      const pod = kube.json<any>(["-n", ns, "get", "pod", "victim"]);
      expect(pod.spec.runtimeClassName).toBe(runtimeClassName);
      const node = String(pod.spec.nodeName);
      expect(kube.json<any>(["get", "node", node])?.metadata.labels["zenith.dev/runtime"]).toBe("gvisor");
      const id = String(pod.status.containerStatuses[0].containerID).replace(/^containerd:\/\//, "");
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      const actual = JSON.parse(host(node, ["ctr", "--namespace", "k8s.io", "containers", "info", id]));
      expect(actual.Runtime.Name, "a RuntimeClass declaration alone is not sandbox evidence").toBe("io.containerd.runsc.v1");
      return { namespace: ns, node, runtime: actual.Runtime.Name, nodeKernel: host(node, ["uname", "-r"]) };
    });
  });

  it("the gateway reaches both sandboxes while cross-tenant traffic is blocked in both directions", async () => {
    for (let i = 0; i < 2; i++) {
      const control = await runPod(kube, { name: `gateway-${i}`, namespace: gw, image, script: reach(`http://${ips[i]}:8080/`) });
      expect(control.phase, control.log).toBe("Succeeded");
      expect(control.log).toBe("REACHED");
      const attack = await runPod(kube, { name: "cross-tenant", namespace: namespaces[i], image, runtimeClassName, resources, script: reach(`http://${ips[1 - i]}:8080/`) });
      expect(attack.phase, attack.log).toBe("Succeeded");
      expect(attack.log).toBe("BLOCKED");
    }
    checks.cni = { gateway: "reached both", crossTenant: "blocked both" };
  }, timeout);

  it("sandboxed workloads still obey restricted Pod Security admission", () => {
    const hostile = restrictedPod({ name: "privileged", namespace: namespaces[0], image, runtimeClassName, resources, script: "sleep 10", mutate: (p) => { p.spec.containers[0].securityContext.privileged = true; } });
    const r = kube.create(hostile);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/violates PodSecurity|privileged/i);
    checks.podSecurity = "privileged refused";
  });

  it("a sandboxed memory exhaustion is OOM-killed without restarting the other tenant", async () => {
    const pod = restrictedPod({ name: "memhog", namespace: namespaces[0], image, runtimeClassName, resources, script: 'awk \'BEGIN { while (1) { a[n++] = sprintf("%1048576s", "x") } }\'' });
    const r = kube.create(pod);
    expect(r.code, r.stderr).toBe(0);
    const terminated = await eventually("sandbox OOM readback", () => kube.json<any>(["-n", namespaces[0], "get", "pod", "memhog"])?.status?.containerStatuses?.[0]?.state?.terminated, { timeoutMs: 180_000 });
    expect(terminated.reason).toBe("OOMKilled");
    const victim = kube.json<any>(["-n", namespaces[1], "get", "pod", "victim"]);
    expect(victim.status.containerStatuses[0].restartCount).toBe(0);
    expect(victim.status.conditions.find((c: any) => c.type === "Ready")?.status).toBe("True");
    checks.memory = { reason: terminated.reason, otherTenantRestarts: 0 };
  }, timeout);
});
