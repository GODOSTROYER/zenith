/** Exact GKE principal contracts, plus opt-in real provider schema validation. */
import { describe, expect, it } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import { serviceAccountDriver } from "@/lib/providers/gcp/drivers/identity/service-account";
import { workloadTrust } from "@/lib/providers/gcp/drivers/identity/workload-trust";
import { renderIdentity } from "@/lib/providers/kubernetes/renderers/identity";
import { compileCtx, mkNode } from "../../aws/drivers/data/_helpers";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";

function fixture() {
  const account = mkNode("identity/kube.long.Name", "identity", { principal: "workload", workload: "service/web", grants: [] }, { provider: "kubernetes", nativeType: "k8s:ServiceAccount" });
  const workload = mkNode("service/web", "container_service", {}, { provider: "kubernetes", nativeType: "k8s:Deployment", dependsOn: [account.address, "cluster/main"] });
  const cluster = mkNode("cluster/main", "kubernetes_cluster", {}, { provider: "gcp", nativeType: "gcp:gke_cluster" });
  const identity = mkNode("identity/cloud", "identity", { principal: "workload", workload: workload.address, grants: [] }, { provider: "gcp", nativeType: "gcp:service_account" });
  return { account, workload, cluster, identity, nodes: [account, workload, cluster, identity] };
}
function compile(nodes: ResourceNode[], identity = nodes.find((n) => n.nativeType === "gcp:service_account")!) {
  return serviceAccountDriver.compile!(identity, { ...compileCtx(nodes), ref: () => "${local.cluster_project}" });
}
describe("GKE ServiceAccount trust", () => {
  it("binds workloadIdentityUser on only the GSA to the renderer's exact namespace/account", () => {
    const f = fixture(); const ctx = compileCtx(f.nodes);
    const sa = renderIdentity(f.account, { environmentId: ctx.environmentId, node: ctx.node }).objects[0];
    const bindings = Object.values(compile(f.nodes).resource!.google_service_account_iam_member);
    expect(bindings).toEqual([{ service_account_id: expect.stringMatching(/^\$\{google_service_account\..*\.name\}$/), role: "roles/iam.workloadIdentityUser", member: `serviceAccount:\${local.cluster_project}.svc.id.goog[${sa.metadata.namespace}/${sa.metadata.name}]` }]);
    expect(JSON.stringify(bindings)).not.toContain("*");
    expect(compile([...f.nodes].reverse())).toEqual(compile(f.nodes));
  });
  it.each(["referenced", "external"] as const)("omits federation and notes the %s cluster", (ownership) => {
    const f = fixture(); f.cluster.ownership = ownership;
    const result = compile(f.nodes);
    expect(result.resource!.google_service_account_iam_member).toBeUndefined();
    expect(JSON.stringify(result.output)).toContain("customer-managed trust");
  });
  it("does not guess a ServiceAccount when the link is missing", () => {
    const f = fixture(); f.workload.dependsOn = [f.cluster.address];
    expect(compile(f.nodes).resource!.google_service_account_iam_member).toBeUndefined();
    expect(workloadTrust(f.identity, compileCtx(f.nodes)).state).toBe("unresolved");
  });
  it.each(["bad namespace", "wrong cluster", "foreign account", "wrong workload"])("refuses %s", (failure) => {
    const f = fixture();
    if (failure === "bad namespace") f.account.spec.namespace = "*";
    if (failure === "wrong cluster") f.cluster.provider = "aws";
    if (failure === "foreign account") f.account.ownership = "referenced";
    if (failure === "wrong workload") f.account.spec.workload = "service/other";
    expect(compile(f.nodes).resource!.google_service_account_iam_member).toBeUndefined();
  });
  it("supports explicit graph addresses and keeps missing clusters unresolved", () => {
    const f = fixture(); f.workload.dependsOn = [];
    Object.assign(f.identity.spec, { serviceAccount: f.account.address, cluster: f.cluster.address });
    expect(compile(f.nodes).resource!.google_service_account_iam_member).toBeDefined();
    expect(compile(f.nodes.filter((n) => n !== f.cluster)).resource!.google_service_account_iam_member).toBeUndefined();
  });
});
describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("GKE trust pinned provider schema", () => {
  it("validates the new GSA IAM binding with real tofu", async () => {
    const f = fixture(); const fragment = compile(f.nodes); fragment.locals = { cluster_project: "contract-project" };
    const graph = { version: 1 as const, environmentId: "env_test", nodes: f.nodes, edges: [], notes: [], manifestDigest: "a".repeat(64), graphDigest: "b".repeat(64) };
    const ws = assembleWorkspace({ graph, fragments: new Map([[f.identity.address, fragment]]), providerSet: "gcp", region: "asia-south1", backend: { kind: "local", path: "terraform.tfstate" }, tags: {}, providerConfig: { google: { project: "contract-project" } } });
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(ws, {}, async (run) => {
      const init = await run.init(); expect(init.exitCode, init.output).toBe(0);
      const validation = await run.validate(); expect(validation.result.exitCode, validation.result.output).toBe(0);
    });
  }, 900_000);
});
