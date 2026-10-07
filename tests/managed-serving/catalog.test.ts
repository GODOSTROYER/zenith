/**
 * PROD-MAN-03 managed service catalog: what the managed tier promises must equal what the offered catalog (PROD-LIFE-02) says
 * the drivers implement, and the drift check must actually fail when they diverge.
 */
import { describe, expect, it } from "vitest";
import { getOfferedCatalog, offeredSupport } from "@/lib/offered-catalog";
import {
  MANAGED_PROMISES, PLATFORM_PROVIDED_KINDS, buildManagedServiceCatalog, checkManagedCatalogDrift, serviceAvailability, type ManagedServicePromise,
} from "@/lib/managed-serving/catalog";
import { MAX_DOMAINS_PER_ENVIRONMENT } from "@/lib/managed-serving/domains";
import { PLAN_LIMITS } from "@/lib/providers/zenith/plans";
import { FULL_ENV, substrate } from "../providers/zenith/support";

const full = substrate({ ...FULL_ENV, ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: "zenith-letsencrypt-http01", ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" });
const plain = substrate({ ...FULL_ENV });
const service = (id: string): ManagedServicePromise => MANAGED_PROMISES.find((s) => s.id === id)!;
const clone = () => structuredClone(getOfferedCatalog());

describe("the managed service catalog and the offered catalog", () => {
  it("has no drift today", () => {
    expect(checkManagedCatalogDrift()).toEqual([]);
    const catalog = buildManagedServiceCatalog();
    expect(catalog.drift).toEqual({ ok: true, problems: [] });
    expect(catalog.offeredCatalogVersion).toBe(getOfferedCatalog().catalogVersion);
    expect(catalog.offeredCatalogDigest).toBe(getOfferedCatalog().contentDigest);
  });

  it("accounts for every kind the zenith drivers offer exactly once: promised or platform-provided", () => {
    const offered = getOfferedCatalog().entries.filter((e) => e.provider === "zenith" && e.level !== "unsupported").map((e) => e.kind as string).sort();
    const promised = MANAGED_PROMISES.flatMap((s) => s.kinds as string[]);
    const provided = PLATFORM_PROVIDED_KINDS as readonly string[];
    expect([...promised, ...provided].sort()).toEqual(offered);
    expect(new Set([...promised, ...provided]).size).toBe(offered.length);
  });

  it("reports each service's kinds at the level the offered catalog gives them, never higher", () => {
    const catalog = buildManagedServiceCatalog();
    for (const s of catalog.services) {
      for (const kind of s.kinds) expect(s.levels[kind], `${s.id}:${kind}`).toBe(offeredSupport("zenith", kind).level);
    }
    // every promised kind is offered at some level (a promise is never made for an unsupported one)
    expect(catalog.services.flatMap((s) => Object.values(s.levels)).every((l) => l === "preview" || l === "supported")).toBe(true);
  });

  it("lists the refused kinds with the offered catalog's own reasons, not a hand-written list", () => {
    const { notOffered } = buildManagedServiceCatalog();
    const kinds = notOffered.map((n) => n.kind);
    for (const kind of ["mysql", "redis", "queue", "pubsub", "function", "compute_instance", "kubernetes_cluster"]) expect(kinds, kind).toContain(kind);
    for (const n of notOffered) expect(n.reason).toBe(offeredSupport("zenith", n.kind as never).reason ?? "not offered");
    expect(kinds).not.toContain("postgres");
    expect(kinds).not.toContain("object_store");
  });

  it("derives per-tier limits from the plan limits instead of restating them", () => {
    const { services } = buildManagedServiceCatalog();
    const byId = (id: string) => services.find((s) => s.id === id)!;
    expect(byId("object-storage").tiers.free).toEqual({ included: false });
    expect(byId("object-storage").tiers.starter).toEqual({ included: true, limit: `${PLAN_LIMITS.starter.maxObjectStores} per environment` });
    expect(byId("object-storage").tiers.pro.limit).toBe(`${PLAN_LIMITS.pro.maxObjectStores} per environment`);
    expect(byId("autoscaling").tiers.free.included).toBe(false);
    expect(byId("autoscaling").tiers.pro.limit).toBe(`up to ${PLAN_LIMITS.pro.maxAutoscaleReplicas} replicas`);
    expect(byId("managed-postgres").tiers.free.limit).toBe(`${PLAN_LIMITS.free.maxManagedDatabases} per environment`);
    expect(byId("persistent-volumes").tiers.free.included).toBe(false);
    expect(byId("persistent-volumes").tiers.starter.included).toBe(true);
    expect(byId("custom-domains").tiers.free.limit).toBe(`${MAX_DOMAINS_PER_ENVIRONMENT} per environment`);
  });

  it("states that managed Postgres export and import are supported, from the portability matrix", () => {
    const pg = buildManagedServiceCatalog().services.find((s) => s.id === "managed-postgres")!;
    expect(pg.dataPortability).toEqual({ export: { supported: true }, import: { supported: true } });
    expect(buildManagedServiceCatalog().services.filter((s) => s.id !== "managed-postgres").every((s) => s.dataPortability === undefined)).toBe(true);
  });

  it("is serializable, deterministic and carries a digest that moves with its content", () => {
    const a = buildManagedServiceCatalog({ substrate: full });
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(buildManagedServiceCatalog({ substrate: full }).digest).toBe(a.digest);
    const changed = clone();
    changed.contentDigest = "f".repeat(64);
    expect(buildManagedServiceCatalog({ substrate: full, offered: changed }).digest).not.toBe(a.digest);
  });
});

describe("the drift check fails when the two diverge", () => {
  it("a promised kind that is no longer offered", () => {
    const offered = clone();
    const pg = offered.entries.find((e) => e.provider === "zenith" && e.kind === "postgres")!;
    pg.level = "unsupported";
    pg.reason = "driver withdrawn";
    const problems = checkManagedCatalogDrift(offered);
    expect(problems).toContainEqual(expect.objectContaining({ code: "promised_not_offered", kind: "postgres", service: "managed-postgres" }));
    expect(problems.find((p) => p.kind === "postgres")!.detail).toContain("driver withdrawn");
    expect(buildManagedServiceCatalog({ offered }).drift.ok).toBe(false);
  });

  it("an offered kind nobody promised (an undocumented capability)", () => {
    const offered = clone();
    const mysql = offered.entries.find((e) => e.provider === "zenith" && e.kind === "mysql")!;
    mysql.level = "preview";
    expect(checkManagedCatalogDrift(offered)).toContainEqual(expect.objectContaining({ code: "offered_not_promised", kind: "mysql" }));
  });

  it("a promised kind the catalog has no zenith entry for", () => {
    const offered = clone();
    offered.entries = offered.entries.filter((e) => !(e.provider === "zenith" && e.kind === "secret"));
    expect(checkManagedCatalogDrift(offered)).toContainEqual(expect.objectContaining({ code: "unknown_kind", kind: "secret" }));
  });

  it("a kind that is both promised and platform-provided, or platform-provided but not offered", () => {
    const offered = clone();
    expect(checkManagedCatalogDrift(offered, MANAGED_PROMISES, [...PLATFORM_PROVIDED_KINDS, "postgres"])).toContainEqual(expect.objectContaining({ code: "promised_and_platform_provided", kind: "postgres" }));
    expect(checkManagedCatalogDrift(offered, MANAGED_PROMISES, [...PLATFORM_PROVIDED_KINDS, "queue"])).toContainEqual(expect.objectContaining({ code: "promised_not_offered", kind: "queue" }));
  });

  it("a new promise for something the drivers refuse", () => {
    const extra: ManagedServicePromise = { id: "queues", title: "Queues", summary: "x", kinds: ["queue"], requires: ["cluster"], tiers: () => ({ included: true }) };
    expect(checkManagedCatalogDrift(getOfferedCatalog(), [...MANAGED_PROMISES, extra])).toContainEqual(expect.objectContaining({ code: "promised_not_offered", kind: "queue", service: "queues" }));
  });
});

describe("availability follows the substrate, and is separate from the promise", () => {
  it("everything needing the platform is unavailable when it is not configured at all", () => {
    for (const s of MANAGED_PROMISES) expect(serviceAvailability(s, undefined)).toMatchObject({ available: false });
  });

  it("names the variable to set for each missing component", () => {
    expect(serviceAvailability(service("object-storage"), plain)).toMatchObject({ available: false, missing: ["object_storage_admin"], reason: expect.stringContaining("ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF") });
    expect(serviceAvailability(service("custom-domains"), plain)).toMatchObject({ available: false, missing: ["http_issuer"], reason: expect.stringContaining("ZENITH_MANAGED_HTTP_CLUSTER_ISSUER") });
    const noDb = substrate({ ...FULL_ENV, ZENITH_MANAGED_DB_PROVIDER: "", ZENITH_MANAGED_DB_API_KEY_REF: "", ZENITH_MANAGED_DB_REGION: "", ZENITH_MANAGED_DB_EGRESS: "" });
    expect(serviceAvailability(service("managed-postgres"), noDb)).toMatchObject({ available: false, missing: ["managed_database"] });
    const noRegistry = substrate({ ...FULL_ENV, ZENITH_MANAGED_REGISTRY: "" });
    expect(serviceAvailability(service("built-images"), noRegistry)).toMatchObject({ available: false, missing: ["registry"] });
  });

  it("is available with everything configured, and Gateway API is needed for web services and custom domains", () => {
    for (const s of MANAGED_PROMISES) expect(serviceAvailability(s, full), s.id).toEqual({ available: true });
    const ingress = substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx", ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: "x" });
    expect(serviceAvailability(service("web-services"), ingress)).toMatchObject({ available: false, missing: ["gateway_api"] });
    expect(serviceAvailability(service("custom-domains"), ingress)).toMatchObject({ available: false, missing: ["gateway_api", "http_issuer"] });
  });
});
