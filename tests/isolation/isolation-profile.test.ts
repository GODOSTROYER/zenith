/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Static checks on the PROD-MAN-04/05 acceptance profile (scripts/isolation, deploy examples, docs). No cluster, no
 * network: they keep the pins honest, the safety rails in place and the gated suite gated, so the harness cannot
 * quietly drift into an unpinned image, a default CNI, a script that can aim a delete at someone else's cluster, or
 * a suite that runs against the wrong target.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { load as yamlLoad } from "js-yaml";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function envFile(rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of read(rel).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error(`unparseable line in ${rel}: ${line}`);
    out[m[1]] = m[2];
  }
  return out;
}

const pins = envFile("scripts/k8s/images.env");

describe("kind-isolation.config.yaml", () => {
  const config = yamlLoad(read("scripts/isolation/kind-isolation.config.yaml")) as {
    kind: string;
    networking: Record<string, unknown>;
    kubeadmConfigPatches: string[];
    nodes: { role: string; image: string }[];
  };

  it("disables the default CNI, so enforcement comes from the engine the script installs", () => {
    expect(config.kind).toBe("Cluster");
    expect(config.networking.disableDefaultCNI).toBe(true);
    expect(config.networking.podSubnet).toBe("192.168.0.0/16");
  });

  it("sets a kubelet pod PID limit, which the PID-exhaustion check depends on", () => {
    const kubelet = config.kubeadmConfigPatches.map((p) => yamlLoad(p) as Record<string, unknown>).find((p) => p.kind === "KubeletConfiguration");
    expect(kubelet).toBeDefined();
    expect(Number(kubelet!.podPidsLimit)).toBeGreaterThan(0);
    expect(Number(kubelet!.podPidsLimit)).toBeLessThanOrEqual(1024);
  });

  it("uses the node image pinned in scripts/k8s/images.env on every node, with a control plane and a worker", () => {
    expect(config.nodes.map((n) => n.role).sort()).toEqual(["control-plane", "worker"]);
    for (const n of config.nodes) expect(n.image).toBe(pins.KIND_NODE_IMAGE);
  });
});

describe("cilium.env", () => {
  const cilium = envFile("scripts/isolation/cilium.env");

  it("holds only the two pins, and either leaves them empty or fills both with well-formed values (never a guess)", () => {
    expect(Object.keys(cilium).sort()).toEqual(["ZENITH_CILIUM_CHART_SHA256", "ZENITH_CILIUM_CHART_VERSION"]);
    const v = cilium.ZENITH_CILIUM_CHART_VERSION;
    const s = cilium.ZENITH_CILIUM_CHART_SHA256;
    if (v !== "" || s !== "") {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
      expect(s).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("scripts", () => {
  const files = ["tenant-isolation-acceptance.sh", "kind-cilium-up.sh"].map((f) => [f, read(`scripts/isolation/${f}`)] as const);

  it.each(files)("%s starts with a bash shebang and stops on the first error and unset variable", (_f, text) => {
    expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(text).toContain("set -euo pipefail");
  });

  it("only ever creates or deletes a cluster through the zenith-life07 name guard", () => {
    for (const [f, text] of files) {
      expect(text, f).not.toMatch(/kind (create|delete) cluster --name [^"$]/);
      expect(text, f).not.toMatch(/--name zenith/);
    }
    expect(read("scripts/isolation/kind-cilium-up.sh")).toContain('name="$(k8s_cluster_name)"');
    expect(read("scripts/isolation/kind-cilium-up.sh")).toContain("never reuses a cluster");
    expect(read("scripts/isolation/kind-cilium-up.sh")).toContain("zenith-life07.marker");
  });

  it("refuses a Cilium chart without both pins, on a checksum mismatch, and on an image with no digest", () => {
    const up = read("scripts/isolation/kind-cilium-up.sh");
    expect(up).toContain("ZENITH_CILIUM_CHART_VERSION:?");
    expect(up).toContain("ZENITH_CILIUM_CHART_SHA256:?");
    expect(up).toContain('"$actual" != "$ZENITH_CILIUM_CHART_SHA256"');
    expect(up).toContain("still names an image without a digest");
    expect(up).toContain("--proto '=https'");
  });

  it("creates the cluster from the isolation config, with the pid limit, in both engine forms", () => {
    expect(read("scripts/isolation/kind-cilium-up.sh")).toContain("kind-isolation.config.yaml");
    const run = read("scripts/isolation/tenant-isolation-acceptance.sh");
    expect(run).toContain('ZENITH_KIND_CONFIG="$here/kind-isolation.config.yaml"');
    expect(read("scripts/k8s/kind-calico-up.sh")).toContain('"${ZENITH_KIND_CONFIG:-$here/kind-calico.config.yaml}"');
  });

  it("the runner refuses any context but a zenith-life07 kind cluster, pins the image and deletes the cluster on exit", () => {
    const run = read("scripts/isolation/tenant-isolation-acceptance.sh");
    expect(run).toContain("^kind-zenith-life07(-[a-z0-9]{1,20})?$");
    expect(run).toContain('ZENITH_TEST_K8S_IMAGE="$ACCEPTANCE_IMAGE"');
    expect(run).toContain("trap cleanup EXIT");
    expect(run).toContain("kind-calico-down.sh");
    expect(run).toContain("tests/isolation/tenant-isolation-acceptance.test.ts");
    expect(run).not.toMatch(/eksctl|gcloud container|az aks|oci ce/);
  });
});

describe("tenant-isolation-acceptance.test.ts gating", () => {
  const suite = read("tests/isolation/tenant-isolation-acceptance.test.ts");

  it("is skipped unless explicitly enabled, with a digest-pinned image and a known profile", () => {
    expect(suite).toContain('process.env.ZENITH_TEST_TENANT_ISOLATION === "1"');
    expect(suite).toContain("describe.skipIf(!enabled)");
    expect(suite).toContain("kind-(calico|cilium|existing)");
    expect(suite).toContain("DIGEST_PINNED.test(image)");
  });

  it("refuses a target that is not a zenith-life07 kind cluster, and only touches namespaces it labels and creates", () => {
    expect(suite).toContain("kind-zenith-life07");
    expect(suite).toContain("zenith.dev/acceptance-run");
    expect(suite).toContain("`zenith-iso-gw-${run}`");
    expect(suite).toContain("`zenith-iso-fx-${run}`");
  });

  it("covers every area the requirement names", () => {
    for (const needle of ["violates PodSecurity", "exceeded quota", "crossTenantByIp", "node's kubelet", "OOMKilled", "Evicted"]) expect(suite, needle).toContain(needle);
    for (const area of ["pod_security", "quota", "network", "hostname_egress", "secrets", "operator_separation", "storage", "runtime", "noisy_neighbour"]) expect(suite, area).toContain(`"${area}"`);
    for (const hog of ['"burn"', '"memhog"', '"diskhog"', '"pids"']) expect(suite, hog).toContain(hog);
  });

  it("never counts a skipped check as passed: the unreachable ones record a reason", () => {
    expect(suite).toContain('status: "skipped"');
    expect(suite).toContain("ctx.skip()");
  });
});

describe("deploy examples and docs", () => {
  it("ships RuntimeClass, bootstrap RBAC and kubelet examples that parse, outside the default kustomization", () => {
    const kustomization = read("deploy/zenith-managed/kustomization.yaml");
    expect(kustomization).not.toContain("optional");
    const rc = read("deploy/zenith-managed/optional/40-runtimeclass-examples.yaml")
      .split(/^---$/m)
      .map((d) => yamlLoad(d) as Record<string, any> | undefined)
      .filter((d): d is Record<string, any> => !!d);
    expect(rc.map((d) => d.kind)).toEqual(["RuntimeClass", "RuntimeClass"]);
    for (const d of rc) {
      expect(d.apiVersion).toBe("node.k8s.io/v1");
      expect(typeof d.handler).toBe("string");
      expect(d.overhead.podFixed.memory).toBeTruthy();
    }
    const kubelet = yamlLoad(read("deploy/zenith-managed/optional/kubelet-pids.yaml")) as Record<string, unknown>;
    expect(kubelet.kind).toBe("KubeletConfiguration");
    expect(Number(kubelet.podPidsLimit)).toBeGreaterThan(0);
  });

  it("the bootstrap role never reads Secret values and the per-tenant role never grants RBAC or exec", () => {
    const docs = read("deploy/zenith-managed/optional/41-tenant-bootstrap-rbac.yaml").split(/^---$/m).map((d) => yamlLoad(d) as Record<string, any> | undefined).filter((d): d is Record<string, any> => !!d);
    const role = docs.find((d) => d.kind === "ClusterRole")!;
    const resources = (role.rules as { resources: string[] }[]).flatMap((r) => r.resources);
    expect(resources).not.toContain("secrets");
    expect(resources).not.toContain("pods/exec");
    expect(resources).not.toContain("*");
  });

  it("the isolation document holds the threat model, the runtime evaluation, the joins and the deferrals", () => {
    const doc = read("docs/platform/TENANT-ISOLATION.md");
    for (const h of ["## 2. Threat model", "## 5. Sandboxed runtime, evaluated against the threat model", "## 6. Resource isolation, and what is not bounded", "## 7. Operator separation", "## 8. Joins"]) expect(doc, h).toContain(h);
    for (const runtime of ["gVisor", "Kata", "Firecracker", "runc"]) expect(doc, runtime).toContain(runtime);
    expect(doc).toContain("No live acceptance run");
    expect(doc).toContain("provisional");
  });
});
