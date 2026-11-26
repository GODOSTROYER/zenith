/** Real request parsing, caller resolution and ranking with trusted synthetic
 * catalog fixtures. Authorities and SQL connection reads never reach a cloud. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { NextRequest as RequestType } from "next/server";
import type { ComputeCatalog, ComputeOffer, ComputeProvider, SourceEvidence } from "@/lib/compute-catalog/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-compute-route-");
const NOW = "2026-11-26T12:00:00.000Z";
const RETRIEVED_AT = "2026-11-26T11:30:00.000Z";
const auth = vi.hoisted(() => ({ verify: vi.fn(), authorize: vi.fn(), session: vi.fn(), configured: vi.fn() }));
const TEST_BEARER = `Bearer za_${"x".repeat(43)}`;
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => ({ verify: auth.verify }) }));
vi.mock("@/lib/capabilities/platform", () => ({ platformBroker: async () => ({ authorizeRead: auth.authorize }) }));
type RouteHandler = (req: RequestType, params: { id: string }) => Promise<Response>;
vi.mock("@/lib/server/request", () => ({
  currentRequest: () => auth.session(),
  route: (a: RouteHandler | object, b?: RouteHandler) => {
    const handler = (typeof a === "function" ? a : b) as RouteHandler;
    return (req: RequestType, context: { params: Promise<{ id: string }> }) => context.params.then((params) => handler(req, params));
  },
}));
vi.mock("@/lib/server/actor", () => ({ resolveActor: async () => ({ type: "user", id: "bob", name: "Bob" }) }));
vi.mock("@/lib/server/workspace", () => ({ requireWorkspace: () => ({ id: "ws-a" }) }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => auth.configured() }));

const { db, resetDb } = await import("@/lib/db/store");
const { Manifest } = await import("@/lib/domain/types");
const { ManifestV2 } = await import("@/lib/resources/manifest-v2");
const { placementReads } = await import("@/lib/placement/recommend");
const catalogStore = await import("@/lib/compute-catalog/store");
const { POST } = await import("@/app/api/platform/v1/environments/[id]/compute-recommendations/route");
const { platformAccess } = await import("@/app/api/platform/v1/_lib/bearer-paths");
const { BrokerError } = await import("@/lib/capabilities/errors");

const specKinds = { aws: "aws_instance_types", gcp: "gcp_machine_types", azure: "azure_resource_skus" } as const;
const priceKinds = { aws: "aws_ec2_prices", gcp: "gcp_skus", azure: "azure_retail_prices" } as const;
function evidence(provider: ComputeProvider, price = false): SourceEvidence {
  return { kind: price ? priceKinds[provider] : specKinds[provider], url: `https://example.test/${provider}/${price ? "prices" : "specifications"}`, retrievedAt: RETRIEVED_AT };
}
function offer(id: string, provider: ComputeProvider, region: string, hourlyUsd: string): ComputeOffer {
  return { id, provider, region, instanceType: `${provider}-synthetic-4`, vcpus: 4, memoryMiB: 16384,
    architecture: "x86_64", cpuMode: "sustained", operatingSystem: "linux", tenancy: "shared", purchaseModel: "on_demand",
    price: { hourlyUsd, source: evidence(provider, true) }, specSource: evidence(provider), offeringState: "offered", warnings: [] };
}
function catalog(offers: ComputeOffer[]): ComputeCatalog {
  const providers = [...new Set(offers.map((entry) => entry.provider))];
  return { schemaVersion: 1, version: "synthetic-route-fixture", generatedAt: NOW,
    sources: providers.flatMap((provider) => [evidence(provider), evidence(provider, true)]), offers,
    coverage: providers.map((provider) => ({ provider, regions: [...new Set(offers.filter((entry) => entry.provider === provider).map((entry) => entry.region))],
      offerCount: offers.filter((entry) => entry.provider === provider).length,
      pricedOfferCount: offers.filter((entry) => entry.provider === provider && entry.price !== null).length, scope: "imported_snapshots", warnings: [] })), warnings: [] };
}
const baseRequest = { minimumVcpus: 4, minimumMemoryMiB: 16384 };
const request = (id = "env-a", body: unknown = baseRequest, headers: Record<string, string> = {}) => POST(
  new NextRequest(`http://localhost/api/platform/v1/environments/${id}/compute-recommendations`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  auth.verify.mockResolvedValue({ id: "int-a", label: "Test", subject: "bob", workspaceId: "ws-a" });
  auth.authorize.mockResolvedValue({ decision: { outcome: "allow" }, claims: {} });
  auth.configured.mockReturnValue(true);
  auth.session.mockReturnValue({ user: { id: "bob", name: "Bob" } });
  resetDb({ projects: ["a", "b"].map((suffix) => ({
    id: `proj-${suffix}`, workspaceId: `ws-${suffix}`, name: suffix, slug: suffix, createdAt: NOW,
    origin: { type: "blank" }, workingManifest: Manifest.parse({ version: 1 }),
  })), environments: ["a", "b"].map((suffix) => ({
    id: `env-${suffix}`, projectId: `proj-${suffix}`, name: "Staging", class: "staging", connectionId: `conn-${suffix}`,
    region: "ap-south-1", baseDomain: "example.test", createdAt: NOW, policies: { approvalRequired: false, allowStatefulDeletion: false },
  })) });
  vi.spyOn(catalogStore, "loadComputeCatalog").mockResolvedValue(catalog([
    offer("aws-india", "aws", "ap-south-1", "0.10"),
    offer("aws-us", "aws", "us-east-1", "0.09"),
    offer("gcp-india", "gcp", "asia-south1", "0.08"),
    offer("azure-india", "azure", "centralindia", "0.11"),
  ]));
  vi.spyOn(placementReads, "connections").mockResolvedValue([{ workspaceId: "ws-a", provider: "aws", verified: true }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("compute recommendation REST discovery", () => {
  it("authorizes a linked bearer at environment scope and returns read-only estimates without caching", async () => {
    const before = JSON.stringify(db());
    const response = await request("env-a", { ...baseRequest, allowedProviders: ["aws"] }, { authorization: TEST_BEARER });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(auth.verify).toHaveBeenCalledWith(TEST_BEARER);
    expect(auth.authorize).toHaveBeenCalledWith({ capability: "placement.solve", scope: { workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a" } },
      expect.objectContaining({ kind: "integration", id: "int-a", onBehalfOf: "bob" }));
    const body = await response.json();
    expect(body).toMatchObject({ workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a", policy: { scope: "compute_only" } });
    expect(body.result.chosen).toMatchObject({ requiresConnection: false });
    expect(JSON.stringify(body.result)).toContain("account_eligibility");
    expect(JSON.stringify(body.result)).toContain("capacity");
    expect(body).not.toHaveProperty("grant");
    expect(body).not.toHaveProperty("manifest");
    expect(JSON.stringify(db())).toBe(before);
  });

  it("supports authenticated browser requests", async () => {
    expect((await request()).status).toBe(200);
    expect(auth.authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "user", id: "bob" }));
    expect(auth.verify).not.toHaveBeenCalled();
  });

  it("refuses unauthenticated browser requests before catalog or policy reads", async () => {
    auth.session.mockReturnValue(undefined);
    expect((await request()).status).toBe(401);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(catalogStore.loadComputeCatalog).not.toHaveBeenCalled();
  });

  it("returns identical not-found responses for missing and foreign environment ids", async () => {
    const foreign = await request("env-b");
    const missing = await request("missing");
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(catalogStore.loadComputeCatalog).not.toHaveBeenCalled();
    expect(placementReads.connections).not.toHaveBeenCalled();
  });

  it("checks broker policy before catalog and connection metadata", async () => {
    auth.authorize.mockResolvedValue({ decision: { outcome: "deny" } });
    expect((await request()).status).toBe(403);
    expect(catalogStore.loadComputeCatalog).not.toHaveBeenCalled();
    expect(placementReads.connections).not.toHaveBeenCalled();
  });

  it("refuses a revoked bearer and conflicting workspace without reading the catalog", async () => {
    auth.verify.mockRejectedValueOnce(new BrokerError("unauthenticated", "Credential is unavailable."));
    expect((await request("env-a", baseRequest, { authorization: TEST_BEARER })).status).toBe(401);
    expect((await request("env-a", baseRequest, { authorization: TEST_BEARER, "x-zenith-workspace": "ws-b" })).status).toBe(404);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(catalogStore.loadComputeCatalog).not.toHaveBeenCalled();
  });

  it.each(["apply", "catalog", "catalogPath", "latencyObservations", "connectedProviders"])("rejects client-supplied %s instead of trusting request evidence", async (field) => {
    const response = await request("env-a", { ...baseRequest, [field]: "untrusted-value" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("untrusted-value");
    expect(catalogStore.loadComputeCatalog).not.toHaveBeenCalled();
  });

  it.each([
    [new catalogStore.ComputeCatalogUnavailableError(), "compute_catalog_unavailable"],
    [new catalogStore.ComputeCatalogValidationError(["sensitive/path/private-value"]), "compute_catalog_invalid"],
  ])("returns a redacted actionable 503 when the catalog cannot be used", async (error, reason) => {
    vi.mocked(catalogStore.loadComputeCatalog).mockRejectedValueOnce(error);
    const response = await request();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: "platform_store_unavailable", details: { reason } });
    expect(body.error.fix).toContain("compute:catalog");
    expect(JSON.stringify(body)).not.toContain("private-value");
    expect(placementReads.connections).not.toHaveBeenCalled();
  });

  it.each([
    { manifestBudget: 50, environmentBudget: 80, requestedBudget: 5000, expectedBudget: 50 },
    { manifestBudget: 80, environmentBudget: 50, requestedBudget: 5000, expectedBudget: 50 },
    { manifestBudget: 80, environmentBudget: 100, requestedBudget: 20, expectedBudget: 20 },
  ])("enforces the tightest compute budget: $expectedBudget USD", async ({ manifestBudget, environmentBudget, requestedBudget, expectedBudget }) => {
    db().projects[0].workingManifest = ManifestV2.parse({ version: 2, constraints: { budgetUsdMonthly: manifestBudget } });
    db().environments[0].policies.budgetUsdMonthly = environmentBudget;
    const response = await request("env-a", { ...baseRequest, budgetUsdMonthly: requestedBudget });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.policy.budgetUsdMonthly).toBe(expectedBudget);
    expect(body.policy.note).toContain("full-environment budget");
    expect(body.result.chosen).toBeNull();
  });

  it("cannot override an explicit manifest provider or region with a request allowlist", async () => {
    db().projects[0].workingManifest = ManifestV2.parse({ version: 2, placement: { provider: "aws", regions: ["ap-south-1"] } });
    const differentProvider = await (await request("env-a", { ...baseRequest, allowedProviders: ["gcp"] })).json();
    expect(differentProvider.policy).toMatchObject({ provider: "aws", regions: ["ap-south-1"] });
    expect(differentProvider.result.chosen).toBeNull();
    expect(JSON.stringify(differentProvider.result.rejected)).toContain("manifest's explicit placement provider");
    const differentRegion = await (await request("env-a", { ...baseRequest, allowedRegions: [{ provider: "aws", region: "us-east-1" }] })).json();
    expect(differentRegion.result.chosen).toBeNull();
    expect(JSON.stringify(differentRegion.result.rejected)).toContain("manifest's permitted placement regions");
  });

  it("enforces manifest residency and rejects unknown geography instead of assuming it is permitted", async () => {
    db().projects[0].workingManifest = ManifestV2.parse({ version: 2, placement: { provider: "auto", residency: ["eu"] } });
    vi.mocked(catalogStore.loadComputeCatalog).mockResolvedValue(catalog([
      offer("us-offer", "aws", "us-east-1", "0.02"),
      offer("unknown-geography", "gcp", "europe-unverified1", "0.01"),
    ]));
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.policy.residency).toEqual(["eu"]);
    expect(body.result.chosen).toBeNull();
    expect(JSON.stringify(body.result.rejected)).toContain("geography is unverified");
    expect(JSON.stringify(body.result.rejected)).toContain("does not satisfy the manifest's residency");
  });

  it("retains a permitted offer when manifest pins and known residency are satisfied", async () => {
    db().projects[0].workingManifest = ManifestV2.parse({ version: 2, placement: { provider: "aws", regions: ["ap-south-1"], residency: ["in"] } });
    const body = await (await request()).json();
    expect(body.result.chosen?.offer.id).toBe("aws-india");
    expect(body.result.alternatives).toEqual([]);
  });

  it("does not mistake foreign or unverified connections for account eligibility", async () => {
    vi.mocked(placementReads.connections).mockResolvedValue([
      { workspaceId: "ws-a", provider: "aws", verified: false },
      { workspaceId: "ws-b", provider: "aws", verified: true },
    ]);
    const body = await (await request("env-a", { ...baseRequest, allowedProviders: ["aws"] })).json();
    expect(body.result.chosen).toMatchObject({ requiresConnection: true });
    expect(JSON.stringify(body.result)).toContain("account_eligibility");
  });

  it("does not substitute static geography estimates for requested measured latency", async () => {
    const response = await request("env-a", { ...baseRequest, maxRttP95Ms: 80, audience: [{ id: "audience-a", weight: 1 }] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.chosen).toBeNull();
    expect(JSON.stringify(body.result.rejected)).toMatch(/latency/i);
  });

  it("classifies only the exact POST endpoint for linked-agent access", () => {
    const path = "/api/platform/v1/environments/env-a/compute-recommendations";
    expect(platformAccess(path, "POST")).toBe("bearer-capable");
    expect(platformAccess(path, "GET")).toBeUndefined();
    expect(platformAccess(`${path}/apply`, "POST")).toBeUndefined();
    expect(platformAccess("/api/platform/v1/environments/env.a/compute-recommendations", "POST")).toBeUndefined();
  });
});
