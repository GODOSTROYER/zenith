/**
 * PROD-MAN-01: what makes a Zenith-managed graph NOT executable.
 *
 * `findGraphProblems` used to apply the Kubernetes rules only to `kubernetes`
 * environments, so a managed environment failed validation on the derived log
 * group and on "observe-only" Kubernetes drivers. A managed graph is judged by
 * the managed provider's own classification instead: platform-provided and
 * not-offered kinds are not executable resources and are never a problem; kinds
 * the managed platform cannot honor are problems that say why.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildDesiredState, findGraphProblems } from "@/lib/execution/graph";
import type { ProductContext } from "@/lib/execution/ports";
import { createKubernetesToolkit } from "@/lib/platform/kubernetes-toolkit";
import { findDriver } from "@/lib/drivers/types";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import { registerZenithDrivers } from "@/lib/providers/zenith/drivers";
import type { Manifest } from "@/lib/domain/types";
import { ENV, PRODUCT_CONNECTION, PROJECT, WS, bucketManifest, webDbManifest } from "./fakes/fixtures";

const lookup = ((provider: string, nativeType: string) => findDriver(provider as never, nativeType)) as never;

function product(manifest: unknown, provider = "zenith"): ProductContext {
  return {
    workspace: { id: WS, name: "Atlas", slug: "atlas" },
    project: { id: PROJECT, name: "Atlas", slug: "atlas" },
    environment: { id: ENV, name: "production", class: "production", provider, region: "zenith-managed", baseDomain: "atlas.zenith.test", connectionId: PRODUCT_CONNECTION, policies: { approvalRequired: false, allowStatefulDeletion: false } },
    revision: { id: "rev-1", number: 1, manifest },
  } as unknown as ProductContext;
}

beforeAll(() => {
  registerKubernetesDrivers();
  registerZenithDrivers({ toolkit: createKubernetesToolkit() });
});

describe("findGraphProblems for a Zenith-managed environment", () => {
  it("accepts the standard web + managed Postgres + TLS route manifest", () => {
    const desired = buildDesiredState(product(webDbManifest()));
    expect(desired.problems).toEqual([]);
    expect(desired.graph).toBeDefined();
    expect(desired.graph!.nodes.find((node) => node.kind === "dns_zone")).toMatchObject({ ownership: "referenced", provider: "zenith" });
    expect(findGraphProblems(desired.graph!, "zenith", lookup)).toEqual([]);
  });

  it("does not count platform-provided or not-offered kinds as unexecutable", () => {
    const desired = buildDesiredState(product(webDbManifest()));
    const kinds = new Set(desired.graph!.nodes.map((n) => n.kind));
    // the derived infrastructure the managed platform provides or does not offer is present in the graph ...
    expect(kinds.has("log_group") || kinds.has("dns_record") || kinds.has("tls_certificate") || kinds.has("network")).toBe(true);
    // ... and none of it is a problem
    const problems = findGraphProblems(desired.graph!, "zenith", lookup);
    expect(problems.filter((p) => /log_group|dns_record|tls_certificate|network\//.test(p))).toEqual([]);
  });

  it("accepts the dedicated object-store realization while requiring its registered driver and native mapping", () => {
    const desired = buildDesiredState(product(bucketManifest("media")));
    expect(desired.problems).toEqual([]);
    expect(findGraphProblems(desired.graph!, "zenith", lookup)).toEqual([]);
    const withoutDriver = findGraphProblems(desired.graph!, "zenith", () => undefined);
    expect(withoutDriver).toContainEqual(expect.stringMatching(/object_store\/media: no driver is registered/));
    const unmapped = { ...desired.graph!, nodes: desired.graph!.nodes.map((node) => node.kind === "object_store" ? { ...node, nativeType: "unsupported:zenith:object_store" } : node) };
    expect(findGraphProblems(unmapped, "zenith", lookup)).toContainEqual(expect.stringMatching(/object_store\/media.*no native type/));
  });

  it("keeps foreign placement and missing external-reference refusals for object stores", () => {
    const desired = buildDesiredState(product(bucketManifest("media")));
    const foreign = { ...desired.graph!, nodes: desired.graph!.nodes.map((node) => node.kind === "object_store" ? { ...node, provider: "aws" as const, nativeType: "aws:s3_bucket" } : node) };
    expect(findGraphProblems(foreign, "zenith", lookup)).toContainEqual(expect.stringMatching(/object_store\/media.*multi-provider/));
    const referenced = { ...desired.graph!, nodes: desired.graph!.nodes.map((node) => node.kind === "object_store" ? { ...node, ownership: "referenced" as const, externalRef: undefined } : node) };
    expect(findGraphProblems(referenced, "zenith", lookup)).toContainEqual(expect.stringMatching(/object_store\/media is referenced but has no externalRef/));
  });

  it("refuses a kind the managed platform cannot honor, and says why", () => {
    const manifest = webDbManifest() as unknown as { resources: unknown[] };
    manifest.resources.push({ id: "res-cache", name: "cache", kind: "redis", config: {}, size: "small", ownership: "managed" });
    const desired = buildDesiredState(product(manifest as unknown as Manifest));
    const problems = findGraphProblems(desired.graph!, "zenith", lookup);
    expect(problems.some((p) => /redis/.test(p) && /managed platform/.test(p))).toBe(true);
  });

  it("still refuses a node placed on another provider", () => {
    const desired = buildDesiredState(product(webDbManifest()));
    const moved = { ...desired.graph!, nodes: desired.graph!.nodes.map((n) => (n.kind === "container_service" ? { ...n, provider: "aws" as const } : n)) };
    expect(findGraphProblems(moved, "zenith", lookup).some((p) => /multi-provider/.test(p))).toBe(true);
  });
});
