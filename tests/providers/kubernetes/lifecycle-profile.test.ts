/**
 * Static checks on the PROD-LIFE-07 acceptance profile (scripts/k8s). No cluster,
 * no network: they keep the pins honest and the safety rails in place, so the
 * harness cannot quietly drift into an unpinned image, a default CNI or a script
 * that can aim a delete at someone else's cluster.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { load as yamlLoad } from "js-yaml";

const root = path.resolve(__dirname, "../../..");
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

const DIGEST = /@sha256:[a-f0-9]{64}$/;
const pins = envFile("scripts/k8s/images.env");

describe("images.env", () => {
  it("pins every container image by sha256 digest", () => {
    const images = Object.entries(pins).filter(([k]) => k.endsWith("_IMAGE"));
    expect(images.map(([k]) => k).sort()).toEqual(["ACCEPTANCE_IMAGE", "CALICO_CNI_IMAGE", "CALICO_KUBE_CONTROLLERS_IMAGE", "CALICO_NODE_IMAGE", "KIND_NODE_IMAGE"]);
    for (const [key, value] of images) expect(value, key).toMatch(DIGEST);
  });

  it("pins the Calico manifest by release tag and checksum, and every Calico image to the same version", () => {
    expect(pins.CALICO_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(pins.CALICO_MANIFEST_URL).toBe(`https://raw.githubusercontent.com/projectcalico/calico/${pins.CALICO_VERSION}/manifests/calico.yaml`);
    for (const key of ["CALICO_CNI_IMAGE", "CALICO_NODE_IMAGE", "CALICO_KUBE_CONTROLLERS_IMAGE"]) {
      expect(pins[key], key).toContain(`:${pins.CALICO_VERSION}@sha256:`);
      expect(pins[key], key).toMatch(/^quay\.io\/calico\//);
    }
  });

  it("names the node image and acceptance image the way the tests and scripts expect", () => {
    expect(pins.KIND_NODE_IMAGE).toMatch(/^kindest\/node:v\d+\.\d+\.\d+@sha256:/);
    expect(pins.ACCEPTANCE_IMAGE).toMatch(/^docker\.io\/library\/busybox:\d+\.\d+\.\d+@sha256:/);
    expect(pins.KIND_MIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("kind-calico.config.yaml", () => {
  const config = yamlLoad(read("scripts/k8s/kind-calico.config.yaml")) as { kind: string; networking: Record<string, unknown>; nodes: { role: string; image: string }[] };

  it("disables the default CNI, so enforcement comes from Calico and nothing else", () => {
    expect(config.kind).toBe("Cluster");
    expect(config.networking.disableDefaultCNI).toBe(true);
    expect(config.networking.podSubnet).toBe("192.168.0.0/16");
  });

  it("uses the pinned node image on every node, with a control plane and a worker", () => {
    expect(config.nodes.map((n) => n.role).sort()).toEqual(["control-plane", "worker"]);
    for (const n of config.nodes) expect(n.image).toBe(pins.KIND_NODE_IMAGE);
  });
});

describe("scripts", () => {
  const scripts = ["lib.sh", "kind-calico-up.sh", "kind-calico-down.sh", "lifecycle-acceptance.sh", "managed-acceptance.sh"].map((f) => [f, read(`scripts/k8s/${f}`)] as const);

  it.each(scripts.filter(([f]) => f !== "lib.sh"))("%s stops on the first error and unset variable", (_f, text) => {
    expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(text).toContain("set -euo pipefail");
  });

  it("only ever creates or deletes a cluster named zenith-life07", () => {
    const lib = read("scripts/k8s/lib.sh");
    expect(lib).toContain("^zenith-life07(-[a-z0-9]{1,20})?$");
    for (const f of ["kind-calico-up.sh", "kind-calico-down.sh"]) expect(read(`scripts/k8s/${f}`)).toContain('name="$(k8s_cluster_name)"');
    // no script names a cluster literally in a create or delete
    for (const [f, text] of scripts) expect(text, f).not.toMatch(/kind (create|delete) cluster --name [^"$]/);
  });

  it("refuses to reuse a cluster, and refuses a Calico manifest whose checksum differs", () => {
    const up = read("scripts/k8s/kind-calico-up.sh");
    expect(up).toContain("never reuses a cluster");
    expect(up).toContain('"$actual" != "$CALICO_MANIFEST_SHA256"');
    expect(up).toContain("still names an image without a digest");
    expect(up).toContain("--proto '=https'");
  });

  it("removes a work directory only when it carries the marker the up script wrote", () => {
    expect(read("scripts/k8s/kind-calico-up.sh")).toContain("zenith-life07.marker");
    const down = read("scripts/k8s/kind-calico-down.sh");
    expect(down).toContain('-f "$workdir/zenith-life07.marker"');
    expect(down.indexOf("zenith-life07.marker")).toBeLessThan(down.indexOf("rm -rf"));
  });

  it("makes the managed harness refuse every way of hitting the wrong cluster", () => {
    const managed = read("scripts/k8s/managed-acceptance.sh");
    for (const needle of [
      "ZENITH_MANAGED_K8S_PROVIDER",
      "eks | gke | aks | oke",
      "ZENITH_MANAGED_K8S_CONFIRM",
      "create-and-delete-namespaces",
      "ZENITH_MANAGED_K8S_CONTEXT",
      'current_context" = "$expected_context"',
      "kind-* | docker-desktop*",
    ]) expect(managed, needle).toContain(needle);
    // it never creates or deletes a cluster itself
    expect(managed).not.toMatch(/kind (create|delete)|eksctl|gcloud container clusters (create|delete)|az aks (create|delete)|oci ce cluster (create|delete)/);
  });

  it("runs the lifecycle suite with the pinned image and deletes the kind cluster on exit", () => {
    const run = read("scripts/k8s/lifecycle-acceptance.sh");
    expect(run).toContain('ZENITH_TEST_K8S_IMAGE="$ACCEPTANCE_IMAGE"');
    expect(run).toContain("trap cleanup EXIT");
    expect(run).toContain("kind-calico-down.sh");
    expect(run).toContain("tests/providers/kubernetes/lifecycle-acceptance.test.ts");
  });
});

describe("lifecycle-acceptance.test.ts gating", () => {
  const suite = read("tests/providers/kubernetes/lifecycle-acceptance.test.ts");

  it("is skipped unless explicitly enabled, with a digest-pinned image and a known profile", () => {
    expect(suite).toContain('process.env.ZENITH_TEST_K8S_LIFECYCLE === "1"');
    expect(suite).toContain("describe.skipIf(!enabled)");
    expect(suite).toContain("kind-calico|managed:(eks|gke|aks|oke)");
    expect(suite).toContain("DIGEST_PINNED.test(image)");
  });

  it("refuses a context it was not pointed at, and only works in namespaces it creates", () => {
    expect(suite).toContain("kind-zenith-life07");
    expect(suite).toContain("ZENITH_MANAGED_K8S_CONTEXT");
    expect(suite).toContain("`zenith-l7-${suffix}`");
    expect(suite).toContain("`zenith-l7n-${suffix}`");
  });
});
