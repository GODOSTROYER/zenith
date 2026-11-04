/** Exact IRSA contracts and gated real provider-schema validation; no live AWS calls. */
import { describe, expect, it } from "vitest";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import { compileIamRole, expectedIamAttributes } from "@/lib/providers/aws/drivers/data/iam-role";
import { tfLabel, refLocalName } from "@/lib/providers/aws/drivers/shared";
import { compileGraph } from "@/lib/execution/compile";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { renderIdentity } from "@/lib/providers/kubernetes/renderers/identity";
import { compileCtx, mkNode } from "../drivers/data/_helpers";

function fixture() {
  const role = mkNode("identity/cloud.web", "identity", { principal: "workload", workload: "service/web", grants: [] });
  const account = mkNode("identity/kube.web", "identity", { principal: "workload", workload: "service/web", grants: [] }, { provider: "kubernetes", nativeType: "k8s:ServiceAccount", dependsOn: ["network/kube"] });
  const workload = mkNode("service/web", "container_service", {}, { provider: "kubernetes", nativeType: "k8s:Deployment", dependsOn: [account.address, "network/kube", "cluster/main"] });
  const namespace = mkNode("network/kube", "network", { namespace: "payments" }, { provider: "kubernetes", nativeType: "k8s:Namespace" });
  const cluster = mkNode("cluster/main", "kubernetes_cluster", { oidcProviderOwner: role.address }, { nativeType: "aws:eks_cluster" });
  return { role, account, workload, namespace, cluster, nodes: [role, account, workload, namespace, cluster] };
}

function workspace(nodes = fixture().nodes) {
  const graph: ResourceGraph = { version: 1, environmentId: "env_test", nodes, edges: [], notes: [], graphDigest: "a".repeat(64), manifestDigest: "b".repeat(64) };
  const drivers = (_provider: string, type: string) => ({
    id: type, provider: _provider, nativeType: type,
    compile: type === "aws:iam_role" ? compileIamRole : type === "aws:eks_cluster" ? () => ({ addresses: ["data.aws_eks_cluster.cluster_main"], data: { aws_eks_cluster: { cluster_main: { name: "contract-cluster" } } } }) : () => ({ addresses: [] }),
  }) as ResourceDriver;
  const { fragments } = compileGraph({ graph, environmentId: graph.environmentId, region: "ap-south-1", tags: {}, drivers });
  return assembleWorkspace({ graph, fragments, providerSet: "aws", region: "ap-south-1", backend: { kind: "local", path: "terraform.tfstate" }, tags: {} });
}

describe("EKS exact ServiceAccount trust", () => {
  it("uses the rendered ServiceAccount subject, exact audience and federated principal", () => {
    const f = fixture(); const ctx = compileCtx(f.nodes);
    const sa = renderIdentity(f.account, { environmentId: ctx.environmentId, node: ctx.node }).objects[0];
    const fragment = compileIamRole(f.role, ctx);
    const statement = (fragment.data!.aws_iam_policy_document[`${tfLabel(f.role.address)}_trust`].statement as Record<string, unknown>[])[0];
    expect(statement).toMatchObject({ actions: ["sts:AssumeRoleWithWebIdentity"], principals: [{ type: "Federated", identifiers: [`\${local.${refLocalName(f.cluster.address, "oidc_provider_arn")}}`] }] });
    expect(statement.condition).toEqual([
      { test: "StringEquals", variable: expect.stringContaining(":sub"), values: [`system:serviceaccount:${sa.metadata.namespace}:${sa.metadata.name}`] },
      { test: "StringEquals", variable: expect.stringContaining(":aud"), values: ["sts.amazonaws.com"] },
    ]);
    expect(JSON.stringify(statement)).not.toContain("*");
    expect(fragment.addresses[0]).toBe(`aws_iam_role.${tfLabel(f.role.address)}`);
    expect(fragment.resource!.aws_iam_openid_connect_provider.cluster_main_workload_oidc.client_id_list).toEqual(["sts.amazonaws.com"]);
    expect(fragment.locals).toHaveProperty(refLocalName(f.cluster.address, "oidc_provider_arn"));
  });

  it("owns one cluster OIDC provider across two workload roles, independent of compile order", () => {
    const f = fixture(); const second = mkNode("identity/second", "identity", { principal: "workload", workload: "service/second", grants: [] });
    const account = { ...f.account, address: "identity/second-sa", spec: { ...f.account.spec, workload: "service/second" } };
    const workload = { ...f.workload, address: "service/second", dependsOn: [account.address, f.namespace.address, f.cluster.address] };
    const nodes = [...f.nodes, second, account, workload];
    const fragments = [second, f.role].map((n) => compileIamRole(n, compileCtx(nodes)));
    expect(fragments.flatMap((p) => p.addresses).filter((a) => a.startsWith("aws_iam_openid_connect_provider."))).toHaveLength(1);
    const a = workspace(nodes); const b = workspace([...nodes].reverse());
    expect(a.configDigest).toBe(b.configDigest);
    expect(a.files).toEqual(b.files);
  });

  it.each(["referenced", "external"] as const)("emits only a note for a %s cluster", (ownership) => {
    const f = fixture(); f.cluster.ownership = ownership;
    const result = compileIamRole(f.role, compileCtx(f.nodes));
    expect(result.resource).toBeUndefined(); expect(result.addresses).toEqual([]);
    expect(JSON.stringify(result.output)).toContain("customer-managed trust");
  });

  it.each(["missing cluster", "missing account", "ambiguous account", "wrong namespace", "missing owner", "wrong owner"])("fails closed: %s", (failure) => {
    const f = fixture(); let nodes = f.nodes;
    if (failure === "missing cluster") nodes = nodes.filter((n) => n !== f.cluster);
    if (failure === "missing account") nodes = nodes.filter((n) => n !== f.account);
    if (failure === "ambiguous account") { const other = { ...f.account, address: "identity/other" }; nodes.push(other); f.workload.dependsOn.push(other.address); }
    if (failure === "wrong namespace") f.account.spec.namespace = "other";
    if (failure === "missing owner") delete f.cluster.spec.oidcProviderOwner;
    if (failure === "wrong owner") f.cluster.spec.oidcProviderOwner = f.account.address;
    expect(compileIamRole(f.role, compileCtx(nodes)).resource).toBeUndefined();
  });

  it("retains native workload service trust", () => {
    const role = mkNode("identity/native", "identity", { principal: "workload", workload: "container_service/native", grants: [] });
    expect(JSON.stringify(compileIamRole(role, compileCtx([role])).data)).toContain("ecs-tasks.amazonaws.com");
  });
  it("does not compare an explicit Kubernetes role against an inferred ECS principal", () => {
    const role = mkNode("identity/cloud", "identity", { principal: "workload", workload: "container_service/web", cluster: "cluster/main", grants: [] });
    expect(expectedIamAttributes(role)).not.toHaveProperty("trustPrincipals");
  });

  it("resolves EKS issuer paths through the real compiler and accepts the assembled workspace", () => {
    const result = workspace(); const text = result.files.find((f) => f.path === "main.tf.json")!.content;
    expect(text).toContain("data.aws_eks_cluster.cluster_main.identity[0].oidc[0].issuer");
    expect(text).not.toContain("__zenith_ref_");
  });
});

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("IRSA pinned provider schema", () => {
  it("validates the new trust and OIDC provider with real tofu", async () => {
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(workspace(), {}, async (run) => {
      const init = await run.init(); expect(init.exitCode, init.output).toBe(0);
      const validation = await run.validate(); expect(validation.result.exitCode, validation.result.output).toBe(0);
    });
  }, 900_000);
});
