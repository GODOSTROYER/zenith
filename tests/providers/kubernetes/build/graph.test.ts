/** Native git-source expansion and the real reviewed-semantics collector, without API execution. */
import { beforeAll, describe, expect, it } from "vitest";
import { buildDesiredState, findGraphProblems } from "@/lib/execution/graph";
import { collectSemanticsInputs, type CollectArgs } from "@/lib/execution/semantics/collect";
import { computeExecutableSemantics } from "@/lib/execution/semantics/digest";
import { findDriver } from "@/lib/drivers/types";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import type { ProductContext } from "@/lib/execution/ports";
import type { ExecContext } from "@/lib/execution/context";
import type { Runtime } from "@/lib/execution/runtime";
import { builtManifest } from "../../../execution/fakes/fixtures";
import { buildProfileDigest } from "@/lib/providers/kubernetes/build";
import { profile } from "./fixtures";
const product: ProductContext = {
  workspace: { id: profile.workspaceId, name: "J6", slug: "j6" }, project: { id: "project-j6", name: "J6", slug: "j6" },
  environment: { id: profile.environmentId, name: "J6", class: "production", provider: "kubernetes", region: "local", baseDomain: "j6.example.test", connectionId: "connection-j6", policies: { approvalRequired: true, allowStatefulDeletion: false } },
  revision: { id: "revision-j6", number: 1, manifest: builtManifest() },
};
beforeAll(() => registerKubernetesDrivers());
describe("native source graph and reviewed profile", () => {
  it("admits the native registry/pipeline release inputs while keeping normal Kubernetes driver/render validation", () => {
    const desired = buildDesiredState(product);
    expect(desired.problems).toEqual([]);
    expect(desired.graph?.nodes.filter(n => ["container_registry", "build_pipeline"].includes(n.kind)).map(n => n.nativeType).sort()).toEqual(["k8s:BuildPipeline", "k8s:BuildRegistry"]);
    expect(findGraphProblems(desired.graph!, "kubernetes", findDriver)).toEqual([]);
  });
  it("re-derives the tenant build profile as part of the reviewed provenance semantics", async () => {
    const graph = buildDesiredState(product).graph!;
    const ec = { product, workspaceId: profile.workspaceId, environmentId: profile.environmentId, op: { proposal: { input: {} } } } as unknown as ExecContext;
    let selected = structuredClone(profile);
    const rt = { d: { resources: {}, buildProfile: () => buildProfileDigest(selected) } } as unknown as Pick<Runtime, "d">;
    const args: CollectArgs = { graph, connection: { id: "connection-j6", config: {} } as CollectArgs["connection"], ws: { files: [], backend: "local", configDigest: "1".repeat(64), lockDigest: "2".repeat(64) }, planDigest: "3".repeat(64) };
    const before = await collectSemanticsInputs(rt, ec, args);
    expect(before.provenance.buildProfileDigest).toBe(buildProfileDigest(profile));
    selected = { ...selected, verifierCredentialRef: "vault:j6/reviewed-rotation" };
    const after = await collectSemanticsInputs(rt, ec, args);
    expect(computeExecutableSemantics(after).components.provenance).not.toEqual(computeExecutableSemantics(before).components.provenance);
    expect(after.targets).toEqual(before.targets); expect(after.recipe).toEqual(before.recipe);
  });
});
