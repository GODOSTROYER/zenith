/**
 * Real provider drivers compiled and assembled through buildWorkspace(), the
 * execution activity entry point. Context/connection records are fixtures;
 * no compiler or reference resolver is mocked, and no cloud API is called.
 * Opt-in init/validate tests exercise real pinned OpenTofu provider schemas.
 */
import { describe, expect, it } from "vitest";
import { findDriver, type TofuFragment } from "@/lib/drivers/types";
import { buildWorkspace } from "@/lib/execution/compile";
import type { ExecContext } from "@/lib/execution/context";
import type { DriverLookup } from "@/lib/execution/ports";
import { scopeOf } from "@/lib/execution/runtime";
import { registerAwsDrivers } from "@/lib/providers/aws/drivers";
import { registerGcpDrivers } from "@/lib/providers/gcp/drivers";
import { ociCompileContext } from "@/lib/providers/oci/context";
import { registerOciDrivers } from "@/lib/providers/oci/drivers";
import { ociPrimaryAddress } from "@/lib/providers/oci/naming";
import { expandManifest, upgradeManifest, graphDigestOf, specDigestOf, type ProviderKey, type ResourceGraph } from "@/lib/resources";
import { TofuRunner } from "@/lib/tofu/runner";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { expanded, realisticManifest, REGION as AWS_REGION, SECRET_CANARY } from "../providers/aws/drivers/_integration";
import { environmentNodes, graphOf, IMAGE as GCP_IMAGE, PROJECT as GCP_PROJECT, REGION as GCP_REGION } from "../providers/gcp/_fixtures";
import { COMPARTMENT, TENANCY, expandOci, webStack, OCI_ENV, OCI_PROD } from "../providers/oci/_support";
import { providerConnection } from "./fakes/fixtures";
import { FakeProduct } from "./fakes/product";
import { FakeEvents, FakeOps } from "./fakes/store";

function executionWorkspace(graph: ResourceGraph, provider: ProviderKey, region: string, envClass: "production" | "staging", drivers: DriverLookup = findDriver) {
  const product = new FakeProduct().base;
  const op = new FakeOps(new FakeEvents()).seed({ environmentId: graph.environmentId });
  const ec: ExecContext = {
    op,
    workspaceId: product.workspace.id, environmentId: graph.environmentId,
    scope: scopeOf(op),
    product: { ...product, environment: { ...product.environment, id: graph.environmentId, provider, region, class: envClass, name: envClass } },
  };
  return buildWorkspace({ ec, graph, connection: providerConnection(), drivers,
    // This job tests compilation/reference resolution, not non-AWS backend
    // wiring. Local backends also keep validation independent of cloud state.
    overrides: { backend: () => ({ backend: { kind: "local", path: "state/terraform.tfstate" } }) } });
}

function aws(envClass: "production" | "staging") {
  registerAwsDrivers();
  const graph = expanded(envClass);
  return { graph, ...executionWorkspace(graph, "aws", AWS_REGION, envClass) };
}

function oci(envClass: "production" | "staging") {
  registerOciDrivers();
  const graph = expandOci(webStack(), envClass === "production" ? OCI_PROD : OCI_ENV);
  // The real OCI drivers require account scoping. Wrap only their compile
  // context, retaining the execution compiler's node/ref functions intact.
  const drivers: DriverLookup = (provider, type) => {
    const original = findDriver(provider, type);
    if (!original?.compile) return original;
    const compile = original.compile;
    return { ...original, compile: (node, ctx) => compile(node, ociCompileContext(ctx, { compartmentOcid: COMPARTMENT, tenancyOcid: TENANCY })) };
  };
  return { graph, ...executionWorkspace(graph, "oci", OCI_ENV.region, envClass, drivers) };
}

function gcp(envClass?: "production" | "staging") {
  registerGcpDrivers();
  const graph = envClass
    ? expandManifest(upgradeManifest(realisticManifest(), { provider: "gcp", region: GCP_REGION }), { id: "env-gcp-ref", name: envClass, class: envClass, provider: "gcp", region: GCP_REGION, baseDomain: "acme.io" })
    : graphOf(environmentNodes());
  if (envClass) {
    // GCP intentionally refuses unresolved build artifacts. Supply the test
    // fixture's synthetic post-build image digest, keeping the real expanded
    // registry/pipeline graph intact. No build or registry lookup is claimed.
    graph.nodes = graph.nodes.map((node) => {
      // Referenced zones need the connection's explicit Cloud DNS identifier;
      // the AWS fixture's inferred domain alone is not a GCP resource name.
      if (node.kind === "dns_zone" && node.ownership === "referenced") return { ...node, externalRef: `projects/${GCP_PROJECT}/managedZones/acme-io` };
      const artifact = node.spec.artifact as { type?: string } | undefined;
      if (artifact?.type !== "built") return node;
      const resolved = { ...node, spec: { ...node.spec, artifact: { type: "image", ref: GCP_IMAGE } } };
      return { ...resolved, specDigest: specDigestOf(resolved) };
    });
    graph.graphDigest = graphDigestOf(graph.nodes, graph.edges);
  }
  return { graph, ...executionWorkspace(graph, "gcp", GCP_REGION, envClass ?? "staging") };
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item)]);
  return [];
}

function assertReferences(ws: TofuWorkspace, fragments: Map<string, TofuFragment>) {
  const definitions = new Map<string, number>();
  const add = (key: string) => definitions.set(key, (definitions.get(key) ?? 0) + 1);
  for (const fragment of fragments.values()) {
    for (const name of Object.keys(fragment.locals ?? {})) add(`local.${name}`);
    for (const [type, labels] of Object.entries(fragment.resource ?? {})) for (const label of Object.keys(labels)) add(`${type}.${label}`);
    for (const [type, labels] of Object.entries(fragment.data ?? {})) for (const label of Object.keys(labels)) add(`data.${type}.${label}`);
  }
  expect([...definitions.values()].every((count) => count === 1)).toBe(true);
  const addresses = Object.values(ws.addressMap).flat();
  expect(new Set(addresses).size).toBe(addresses.length);
  for (const address of addresses) expect(definitions.get(address), address).toBe(1);
  let locals = 0;
  let traversals = 0;
  // Scan all generated files, including nested expressions and output/locals
  // bodies. Escaped $${...} is literal manifest text, not a reference.
  for (const file of ws.files) {
    expect(file.content).not.toMatch(/(?<!\$)\$\{__zenith_ref_/);
    for (const text of stringsIn(JSON.parse(file.content))) {
      for (const [, expression] of text.matchAll(/(?<!\$)\$\{([\s\S]*?)\}/g)) {
        for (const [reference] of expression.matchAll(/\b(?:local\.[A-Za-z0-9_]+|data\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+|(?:aws|google|oci|azurerm|random|terraform)_[A-Za-z0-9_]+\.[A-Za-z0-9_]+)/g)) {
          expect(definitions.get(reference), `undefined or multiply declared ${reference}`).toBe(1);
          if (reference.startsWith("local.")) locals++;
          else traversals++;
        }
      }
    }
  }
  expect(traversals).toBeGreaterThan(10);
  return { locals, traversals };
}

describe.each(["production", "staging"] as const)("AWS %s through the execution compiler", (envClass) => {
  it("resolves every local and resource/data traversal exactly once", () => {
    const { graph, ws, fragments } = aws(envClass);
    expect(fragments.size).toBe(graph.nodes.length);
    expect(assertReferences(ws, fragments).locals).toBeGreaterThan(50);
    expect(JSON.stringify({ graph, ws })).not.toContain(SECRET_CANARY);
    // This semantic reference was refused by the old ATTRIBUTE regexp.
    expect(ws.files.find((file) => file.path === "main.tf.json")!.content).toContain("${local.ref_load_balancer_public__target_group_arn_container_service_web}");
  });

  it("has a deterministic configDigest over two independent expansion/compile/assembly runs", () => {
    expect(aws(envClass).ws).toEqual(aws(envClass).ws);
  });

  it("keeps configDigest unchanged when node order changes provisional token numbering", () => {
    const { graph, ws } = aws(envClass);
    const reordered = executionWorkspace({ ...graph, nodes: [...graph.nodes].reverse() }, "aws", AWS_REGION, envClass).ws;
    expect(reordered.configDigest).toBe(ws.configDigest);
    expect(reordered).toEqual(ws);
  });
});

describe.each(["production", "staging"] as const)("OCI %s through the execution compiler", (envClass) => {
  it("resolves the fixture graph's primary traversals and auxiliary locals", () => {
    const { graph, ws, fragments } = oci(envClass);
    expect(fragments.size).toBe(graph.nodes.length);
    expect(assertReferences(ws, fragments).locals).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      const primary = ociPrimaryAddress(node);
      const fragment = fragments.get(node.address)!;
      if (primary && (node.ownership === "managed" || fragment.addresses.length > 0)) expect(fragment.addresses[0], node.address).toBe(primary);
      // OCI deliberately contributes no tofu object for a foreign secret
      // (e.g. an AWS ARN). It must not invent an OCI Vault address for it.
      if (node.kind === "secret" && node.ownership !== "managed") expect(fragment.addresses, node.address).toEqual([]);
    }
  });

  it("has a deterministic configDigest over two complete runs", () => {
    expect(oci(envClass).ws).toEqual(oci(envClass).ws);
  });
});

describe.each([undefined, "production", "staging"] as const)("GCP %s through the execution compiler", (envClass) => {
  it("resolves primary traversals in the provider fixture or a real expanded manifest", () => {
    const { graph, ws, fragments } = gcp(envClass);
    expect(fragments.size).toBe(graph.nodes.length);
    assertReferences(ws, fragments);
    expect(JSON.stringify({ graph, ws })).not.toContain(SECRET_CANARY);
  });

  it("has a deterministic configDigest over two complete runs", () => {
    expect(gcp(envClass).ws).toEqual(gcp(envClass).ws);
  });
});

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("real AWS schema validation through the execution compiler (opt-in)", () => {
  it.each(["production", "staging"] as const)("runs tofu init -backend=false and tofu validate on %s", async (envClass) => {
    const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });
    await runner.run(aws(envClass).ws, {}, async (run) => {
      await run.init({ backend: false });
      const result = await run.validate();
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }, 180_000);
});
