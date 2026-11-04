/** Injected prerequisite probes, plus cache tests with mocked service transports. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedReadiness, executionPlaneReadiness, READINESS_TTL_MS, resetReadinessCache, type ReadinessProbes } from "@/lib/bridge/readiness";

const mocks = vi.hoisted(() => ({ query: vi.fn(async () => []), schema: vi.fn(async () => undefined), temporal: vi.fn(async () => ({ available: true, address: "localhost:7234", namespace: "test", latencyMs: 1 })), drivers: vi.fn(() => [{}]), memory: vi.fn(() => false) }));
vi.mock("@/lib/controlplane/db", () => ({ platformDb: async () => ({ query: mocks.query }), platformDbConfigFromEnv: () => ({ kind: "postgres", source: "env" }), assertPlatformSchemaCurrent: mocks.schema, MIGRATE_COMMAND: "npm run platform:migrate" }));
vi.mock("@/lib/capabilities/platform", () => ({ isMemoryStoreEnabled: mocks.memory }));
vi.mock("@/lib/workflows/client", () => ({ temporalAvailable: mocks.temporal }));
vi.mock("@/lib/drivers/types", () => ({ listDrivers: mocks.drivers }));

const yes = { ok: true, detail: "configured" };
function probes(): ReadinessProbes {
  return { platformStore: async () => yes, platformSchema: async () => yes, temporal: async () => yes, credentials: async () => ({ controlKey: yes, oidcKey: yes, issuer: yes }), drivers: () => 1 };
}
beforeEach(() => { resetReadinessCache(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetReadinessCache(); });

describe("prerequisites", () => {
  it("all configured is ready, and every check has a fix", async () => {
    const r = await executionPlaneReadiness("aws", { probes: probes() });
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(["provider", "platform_store", "platform_schema", "temporal", "control_signing_key", "oidc_signing_key", "oidc_issuer", "drivers"]);
    expect(r.checks.every((c) => c.fix.length > 0)).toBe(true);
  });
  it.each(["platform_store", "platform_schema", "temporal", "control_signing_key", "oidc_signing_key", "oidc_issuer", "drivers"])("fails closed for missing %s", async (check) => {
    const p = probes();
    const no = { ok: false, detail: "missing" };
    if (check === "platform_store") p.platformStore = async () => no;
    if (check === "platform_schema") p.platformSchema = async () => no;
    if (check === "temporal") p.temporal = async () => no;
    if (check === "drivers") p.drivers = () => 0;
    if (check.includes("signing") || check === "oidc_issuer") p.credentials = async () => ({ controlKey: check === "control_signing_key" ? no : yes, oidcKey: check === "oidc_signing_key" ? no : yes, issuer: check === "oidc_issuer" ? no : yes });
    const r = await executionPlaneReadiness("aws", { probes: p });
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.id === check)).toMatchObject({ ok: false, fix: expect.any(String) });
    expect(r.checks.filter((c) => !c.ok).every((c) => c.fix.length > 0)).toBe(true);
    if (check === "drivers") expect(JSON.stringify(r)).toMatch(/No aws resource drivers/);
  });
  it.each(["sandbox", "localstack", "unknown"])("never routes %s and never probes services", async (provider) => {
    const p = probes(); p.platformStore = vi.fn();
    expect((await executionPlaneReadiness(provider, { probes: p })).checks).toEqual([expect.objectContaining({ id: "provider", ok: false })]);
    expect(p.platformStore).not.toHaveBeenCalled();
  });
  it("thrown probe errors do not throw or expose secret canaries", async () => {
    const p = probes(); const fail = async () => { throw new Error("CANARY-private-credential"); };
    p.platformStore = fail; p.platformSchema = fail; p.temporal = fail; p.credentials = fail; p.drivers = fail;
    const r = await executionPlaneReadiness("aws", { probes: p });
    expect(r.checks).toHaveLength(8); expect(r.ready).toBe(false);
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  it("invalid signing configuration never exposes its value", async () => {
    vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK", "CANARY-not-json");
    const r = await executionPlaneReadiness("aws");
    expect(r.ready).toBe(false); expect(JSON.stringify(r)).not.toContain("CANARY");
  });
});

it("deduplicates in-flight calls, expires cache, honours fresh and expires synchronous labels", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK", '{"kty":"OKP"}'); vi.stubEnv("ZENITH_OIDC_SIGNING_JWK", '{"kty":"RSA"}'); vi.stubEnv("ZENITH_OIDC_ISSUER", "https://bridge.example.com/api/oidc");
  const [a, b] = await Promise.all([executionPlaneReadiness("aws"), executionPlaneReadiness("aws")]);
  expect(a).toBe(b); expect(mocks.temporal).toHaveBeenCalledTimes(1);
  expect(await executionPlaneReadiness("aws")).toBe(a);
  await executionPlaneReadiness("aws", { fresh: true }); expect(mocks.temporal).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + READINESS_TTL_MS + 1);
  await executionPlaneReadiness("aws"); expect(mocks.temporal).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.now() + READINESS_TTL_MS * 6 + 1); expect(cachedReadiness("aws")).toBeUndefined();
});
it("refuses a per-process memory broker store", async () => {
  mocks.memory.mockReturnValueOnce(true);
  const r = await executionPlaneReadiness("aws");
  expect(r.checks.find((c) => c.id === "platform_store")).toMatchObject({ ok: false, fix: expect.stringContaining("Unset ZENITH_PLATFORM_BROKER_MEMORY") });
});
