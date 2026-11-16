/**
 * Real execution compiler and workspace assembler acceptance for SNS/EBS/EKS.
 * Provider-schema validation stays gated behind ZENITH_TEST_TOFU_NETWORK=1;
 * tofu availability is asserted inside the gate, so sandbox failures cannot be
 * silently counted as validation passes. No AWS account is used even in the gate.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { awsDrivers, NOT_YET_IMPLEMENTED, registerAwsDrivers } from "@/lib/providers/aws/drivers";
import { findDriver, type ResourceDriver } from "@/lib/drivers/types";
import { compileGraph } from "@/lib/execution/compile";
import { parseNativeConfig } from "@/lib/resources/native-registry";
import { expandManifest, upgradeManifest, ManifestV2 } from "@/lib/resources";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import type { ResourceNode } from "@/lib/resources/types";
import { compileCtx, graphOf, mkNode, networkNodes, CTX_TAGS, REGION } from "../data/_helpers";
import { refLocalName } from "@/lib/providers/aws/drivers/shared";
import { tempDir, tofuOnPath } from "../../../../tofu/_helpers";
import { manifest, res, svc } from "../../../../resources/_fixtures";

const types = ["aws:sns_topic", "aws:ebs_volume", "aws:eks_cluster"];
function nodes(): ResourceNode[] {
  return [
    ...networkNodes(),
    ...["a", "b"].map((zone, index) => mkNode(`subnet/public-${zone}`, "subnet", { tier: "public", zone, cidr: `10.0.${index}.0/24`, network: "network/main" }, { dependsOn: ["network/main"] })),
    mkNode("queue/jobs", "queue", {}),
    mkNode("pubsub/events", "pubsub", { subscriptions: ["queue/jobs"], deletionPolicy: "allow" }),
    mkNode("volume/data", "volume", { sizeGb: 64, instance: "compute_instance/worker", availabilityZone: "ap-south-1a", deletionPolicy: "allow" }),
    mkNode("compute_instance/worker", "compute_instance", {}, { dependsOn: ["subnet/private-a"] }),
    mkNode("kubernetes_cluster/apps", "kubernetes_cluster", { version: "1.35" }, { dependsOn: ["subnet/private-a", "subnet/private-b"] }),
    mkNode("identity/publisher", "identity", { principal: "workload", workload: "compute_instance/worker", grants: [{ target: "pubsub/events", access: ["publish"], via: ["binding:publish"] }] }),
  ];
}
function workspace(all = nodes(), statePath = "terraform.tfstate") {
  const graph = graphOf(all);
  const { fragments } = compileGraph({ graph, environmentId: graph.environmentId, region: REGION, tags: CTX_TAGS,
    drivers: (_provider, type) => awsDrivers.find((driver) => driver.nativeType === type) as unknown as ResourceDriver,
  });
  const ws = assembleWorkspace({ graph, fragments, providerSet: "aws", region: REGION, tags: CTX_TAGS, backend: { kind: "local", path: statePath } });
  return { ws, fragments, graph };
}

describe("remaining AWS native drivers in the execution path", () => {
  it("registers each new native type exactly once and removes its explicit gap", () => {
    registerAwsDrivers(); registerAwsDrivers();
    for (const type of types) {
      expect(awsDrivers.filter((driver) => driver.nativeType === type)).toHaveLength(1);
      expect(findDriver("aws", type)).toBeDefined();
      expect(NOT_YET_IMPLEMENTED.has(type)).toBe(false);
    }
  });
  it("compiles and assembles the real graph with no provisional references left over", () => {
    const { ws, fragments } = workspace();
    const main = ws.files.find((f) => f.path === "main.tf.json")!.content;
    expect(main).toContain('"aws_eks_cluster"'); expect(main).toContain('"aws_ebs_volume"'); expect(main).toContain('"aws_sns_topic"');
    expect(main).not.toMatch(/__zenith_ref|provisioner|templatefile\(|file\(/);
    expect(fragments.get("kubernetes_cluster/apps")!.addresses[0]).toBe("aws_eks_cluster.kubernetes_cluster_apps");
    expect(ws.addressMap["kubernetes_cluster/apps"]).toContain("aws_eks_cluster.kubernetes_cluster_apps");
  });
  it("registers strict native schemas and compiles their parsed config form", () => {
    registerAwsDrivers();
    const all = nodes().map((node) => types.includes(node.nativeType) ? { ...node, kind: "provider_native" as const, spec: { type: node.nativeType, config: node.spec } } : node);
    for (const n of all.filter((node) => types.includes(node.nativeType))) {
      expect(parseNativeConfig("aws", n.nativeType, n.spec.config).ok).toBe(true);
      expect(parseNativeConfig("aws", n.nativeType, { ...(n.spec.config as object), unknown: true }).ok).toBe(false);
    }
    expect(() => workspace(all)).not.toThrow();
  });
  it("accepts real native manifest expansion with SNS queue bindings, a standalone volume and private EKS", () => {
    registerAwsDrivers();
    const env = { id: "env_test", name: "production", class: "production" as const, provider: "aws" as const, region: REGION, baseDomain: "zenith.test" };
    const base = upgradeManifest(manifest({ services: [svc({ id: "worker", name: "worker", kind: "worker" })], resources: [res({ id: "jobs", name: "jobs", kind: "queue" })] }), env);
    const input = ManifestV2.parse({ ...base, native: [
      { id: "events", provider: "aws", type: "aws:sns_topic", config: {}, dependsOn: ["jobs"] },
      { id: "data", provider: "aws", type: "aws:ebs_volume", config: { sizeGb: 64, availabilityZone: "ap-south-1a" } },
      { id: "apps", provider: "aws", type: "aws:eks_cluster", config: { version: "1.35", subnets: ["subnet/private-a", "subnet/private-b"] } },
    ] });
    const graph = expandManifest(input, env);
    const { ws, fragments } = workspace(graph.nodes);
    expect(fragments.get("provider_native/events")!.resource!.aws_sns_topic_subscription).toBeDefined();
    expect(ws.addressMap["provider_native/apps"]).toContain("aws_eks_cluster.provider_native_apps");
    expect(ws.addressMap["provider_native/data"]).toEqual(["aws_ebs_volume.provider_native_data"]);
  });
  it("is deterministic under graph/node dependency ordering and preserves the graph", () => {
    const all = nodes(); const before = structuredClone(all);
    const a = workspace(all).ws;
    const b = workspace([...all].reverse().map((node) => ({ ...node, dependsOn: [...node.dependsOn].reverse() }))).ws;
    expect(a.files).toEqual(b.files); expect(a.configDigest).toBe(b.configDigest);
    expect(all).toEqual(before);
  });
  it("escapes hostile tag strings and excludes unrecognized top-level secret data", () => {
    const all = nodes();
    for (const node of all.filter((n) => types.includes(n.nativeType))) node.spec.unrecognized = "sensitive-secret-canary";
    const { graph, fragments } = workspace(all);
    const driver = awsDrivers.find((d) => d.nativeType === "aws:eks_cluster")!;
    const n = all.find((n) => n.kind === "kubernetes_cluster")!;
    fragments.set(n.address, driver.compile!(n, compileCtx(all, { tags: { ...CTX_TAGS, "team${key}": "value${other}%{directive}" } })));
    const ws = assembleWorkspace({ graph, fragments, providerSet: "aws", region: REGION, tags: {}, backend: { kind: "local", path: "terraform.tfstate" } });
    const main = ws.files.find((f) => f.path === "main.tf.json")!.content;
    expect(main).toContain('"team$${key}"'); expect(main).not.toContain("sensitive-secret-canary");
  });
  it("fails closed on two topics claiming the same SQS delivery policy", () => {
    const all = nodes(); all.push(mkNode("pubsub/second", "pubsub", { subscriptions: ["queue/jobs"] }));
    expect(() => workspace(all)).toThrow(/duplicate|already|defined|claimed/i);
  });
  it("resolves the Kubernetes session attributes as locals without generating credentials", () => {
    const { fragments } = workspace(); const f = fragments.get("kubernetes_cluster/apps")!;
    for (const attribute of ["endpoint", "ca_data", "oidc_issuer", "cluster_name", "security_group_id"]) {
      expect(f.locals![refLocalName("kubernetes_cluster/apps", attribute)]).toMatch(/^\$\{/);
    }
    expect(JSON.stringify(f)).not.toContain("credentialRef");
  });
});

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("OpenTofu AWS 6.66.0 schema validation (requires binary/network)", () => {
  it("validates the complete SNS/EBS/EKS graph against the pinned provider", async () => {
    expect(tofuOnPath(), "OpenTofu cannot execute in this environment").toBe(true);
    const { dir, cleanup } = tempDir("zenith-aws-more-");
    try {
      const { ws } = workspace(nodes(), path.join(dir, "terraform.tfstate"));
      const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });
      await runner.run(ws, {}, async (run) => {
        await run.init(); const result = await run.validate();
        expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        expect(result.valid).toBe(true);
      });
    } finally { cleanup(); }
  }, 180_000);
});
