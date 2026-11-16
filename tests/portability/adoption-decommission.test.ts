/**
 * PROD-LIFE-11 pure rules: the support matrix, the adoption claim and its drift
 * baseline (over the LIFE-12 field ownership registry), the decommission gate and
 * the network guard. No I/O.
 */
import { describe, expect, it } from "vitest";
import { AdoptionClaimSchema, assertClaimMatchesRegistry, assertClaimedObjectIsLive, buildBaseline, claimDigest, compareToBaseline, fieldOwnersFor } from "@/lib/portability/adoption";
import { DecommissionRefusedError, assertDecommissionAllowed, assessDecommission, type AdoptionFact, type DecommissionTarget } from "@/lib/portability/decommission";
import { parsePortabilityInput, portabilityDetails, isPortabilityCapability } from "@/lib/portability/inputs";
import { portabilitySupport, supportTable } from "@/lib/portability/matrix";
import { assertConnectableHost, classifyAddress } from "@/lib/portability/net";
import type { ObservedValue } from "@/lib/resources/types";

const known = (value: unknown): ObservedValue => ({ state: "known", value, observedAt: "2026-10-05T00:00:00.000Z" });

describe("support matrix", () => {
  it("says exactly what each provider can do and why not", () => {
    expect(portabilitySupport("export", "aws", "postgres")).toMatchObject({ supported: true, method: "postgres-logical-v1" });
    expect(portabilitySupport("export", "zenith", "postgres")).toMatchObject({ supported: true });
    expect(portabilitySupport("export", "azure", "mysql")).toMatchObject({ supported: true, method: "mysql-cli-v1", evidence: "contract" });
    expect(portabilitySupport("export", "zenith", "mysql")).toMatchObject({ supported: false, reason: expect.stringContaining("Postgres only") });
    expect(portabilitySupport("export", "aws", "object_store")).toMatchObject({ supported: true, method: "s3-objects-v1" });
    expect(portabilitySupport("export", "azure", "object_store")).toMatchObject({ supported: false, reason: expect.stringContaining("no S3 API") });
    expect(portabilitySupport("import", "kubernetes", "volume")).toMatchObject({ supported: false, reason: expect.stringContaining("no data mover") });
    expect(portabilitySupport("export", "sandbox", "postgres")).toMatchObject({ supported: false });
    expect(portabilitySupport("export", "aws", "container_service")).toMatchObject({ supported: false, reason: expect.stringContaining("not a data service") });
    expect(portabilitySupport("adopt", "zenith", "postgres")).toMatchObject({ supported: false });
    expect(portabilitySupport("adopt", "aws", "volume")).toMatchObject({ supported: true });
  });

  it("never claims support without naming a method, and never refuses without a reason", () => {
    for (const row of supportTable()) {
      for (const s of [row.export, row.import, row.adopt, row.release]) {
        if (s.supported) expect(s.method.length).toBeGreaterThan(3);
        else expect(s.reason.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("adoption claim", () => {
  const identity = { workspaceId: "ws", environmentId: "env", address: "postgres/legacy", provider: "aws", nativeType: "aws:rds_instance" };
  const claim = AdoptionClaimSchema.parse({ externalId: "db-1", acknowledge: true });

  it("requires an explicit acknowledgement and an exact object, and defaults to the safe lifecycle", () => {
    expect(claim.lifecycle).toBe("manage");
    expect(AdoptionClaimSchema.safeParse({ externalId: "db-1" }).success).toBe(false);
    expect(AdoptionClaimSchema.safeParse({ externalId: "db-1", acknowledge: false }).success).toBe(false);
    expect(AdoptionClaimSchema.safeParse({ externalId: "", acknowledge: true }).success).toBe(false);
    expect(AdoptionClaimSchema.safeParse({ externalId: "db-1", acknowledge: true, extra: 1 }).success).toBe(false);
  });

  it("binds the approval digest to the object, the lifecycle, the fields and the resource it is for", () => {
    const base = claimDigest(identity, claim);
    expect(claimDigest(identity, claim)).toBe(base);
    expect(claimDigest(identity, { ...claim, externalId: "db-2" })).not.toBe(base);
    expect(claimDigest(identity, { ...claim, lifecycle: "manage_and_destroy" })).not.toBe(base);
    expect(claimDigest({ ...identity, address: "postgres/other" }, claim)).not.toBe(base);
    expect(claimDigest({ ...identity, workspaceId: "ws2" }, claim)).not.toBe(base);
    expect(claimDigest(identity, { ...claim, fields: [{ path: "a", owner: "iac" }, { path: "b", owner: "iac" }] })).toBe(claimDigest(identity, { ...claim, fields: [{ path: "b", owner: "iac" }, { path: "a", owner: "iac" }] }));
  });

  it("takes field owners from the registry and refuses a claim that contradicts it", () => {
    const owners = fieldOwnersFor("azure:postgresql_flexible_server", "postgres/legacy", {});
    expect(owners).toEqual(expect.arrayContaining([expect.objectContaining({ path: "zone", owner: "provider-managed", source: "rule" })]));
    expect(() => assertClaimMatchesRegistry("azure:postgresql_flexible_server", "postgres/legacy", {}, { ...claim, fields: [{ path: "zone", owner: "iac" }] })).toThrow(/registry gives it to provider-managed/);
    expect(assertClaimMatchesRegistry("azure:postgresql_flexible_server", "postgres/legacy", {}, { ...claim, fields: [{ path: "zone", owner: "provider-managed" }, { path: "sku_name", owner: "iac" }] }).length).toBeGreaterThan(0);
    // facts change the owner: an autoscaled ECS service hands its replica count to the autoscaler
    const ecs = fieldOwnersFor("aws:ecs_service", "service/web", { autoscaled: true });
    expect(ecs.find((o) => o.path === "desired_count")?.owner).toBe("autoscaler");
    expect(fieldOwnersFor("aws:ecs_service", "service/web", {}).find((o) => o.path === "desired_count")?.owner).toBe("iac");
  });
});

describe("drift baseline", () => {
  const ctx = { nativeType: "aws:ecs_service", address: "service/web", facts: { autoscaled: true } };
  const attrs = { image: known("web:1"), desired_count: known(3), cpu: known(256), secretish: { state: "unknown", reason: "access_denied" } as ObservedValue };

  it("captures only known, IaC-owned attributes and records what another owner holds", () => {
    const b = buildBaseline({ nativeType: ctx.nativeType, address: ctx.address, attributes: attrs, facts: ctx.facts, observedAt: "2026-10-05T00:00:00.000Z" });
    expect(b.attributes).toEqual({ cpu: 256, image: "web:1" });
    expect(b.excluded).toEqual([{ path: "desired_count", owner: "autoscaler" }]);
    expect(b.digest).toMatch(/^[0-9a-f]{64}$/);
    // without the autoscaler fact the replica count is the manifest's and is part of the baseline
    expect(buildBaseline({ nativeType: ctx.nativeType, address: ctx.address, attributes: attrs, facts: {}, observedAt: "2026-10-05T00:00:00.000Z" }).attributes).toEqual({ cpu: 256, desired_count: 3, image: "web:1" });
  });

  it("reports drift from the baseline on owned fields and treats another owner's movement as expected variance", () => {
    const b = buildBaseline({ nativeType: ctx.nativeType, address: ctx.address, attributes: attrs, facts: ctx.facts, observedAt: "2026-10-05T00:00:00.000Z" });
    expect(compareToBaseline(b, attrs, ctx)).toEqual([]);
    const moved = { ...attrs, desired_count: known(9) };
    expect(compareToBaseline(b, moved, ctx)).toEqual([]);
    const drifted = { image: known("web:2"), desired_count: known(9), memory: known(512) };
    expect(compareToBaseline(b, drifted, ctx)).toEqual([
      { attribute: "cpu", kind: "missing", baseline: 256 },
      { attribute: "image", kind: "changed", baseline: "web:1", current: "web:2" },
      { attribute: "memory", kind: "added", current: 512 },
    ]);
  });

  it("refuses a baseline too large to record", () => {
    const big: Record<string, ObservedValue> = { blob: known("x".repeat(70_000)) };
    expect(() => buildBaseline({ nativeType: "aws:rds_instance", address: "postgres/x", attributes: big, facts: {}, observedAt: "2026-10-05T00:00:00.000Z" })).toThrow(/too large/);
  });
});

describe("the claimed object must be the live object", () => {
  const claim = AdoptionClaimSchema.parse({ externalId: "db-1", acknowledge: true });
  const live = { presence: "present", externalId: "db-1", simulated: false };
  it("accepts only a present, real observation of exactly that object", () => {
    expect(() => assertClaimedObjectIsLive({ claim, observation: live, sandbox: false })).not.toThrow();
    expect(() => assertClaimedObjectIsLive({ claim, observation: null, sandbox: false })).toThrow(/not found/);
    expect(() => assertClaimedObjectIsLive({ claim, observation: { ...live, presence: "missing" }, sandbox: false })).toThrow(/not found/);
    expect(() => assertClaimedObjectIsLive({ claim, observation: { ...live, externalId: "db-2" }, sandbox: false })).toThrow(/identity/);
    expect(() => assertClaimedObjectIsLive({ claim, observation: { ...live, externalId: undefined }, sandbox: false })).toThrow(/identity/);
    expect(() => assertClaimedObjectIsLive({ claim, observation: { ...live, simulated: true }, sandbox: false })).toThrow(/simulated/);
    expect(() => assertClaimedObjectIsLive({ claim, observation: { ...live, simulated: true }, sandbox: true })).not.toThrow();
    expect(() => assertClaimedObjectIsLive({ claim, rowExternalId: "other", observation: live, sandbox: false })).toThrow(/different object/);
  });
});

describe("decommission gate", () => {
  const target = (over: Partial<DecommissionTarget> = {}): DecommissionTarget => ({ address: "postgres/db", kind: "postgres", ownership: "managed", externalId: "db-1", ...over });
  const fact = (over: Partial<AdoptionFact> = {}): AdoptionFact => ({ address: "postgres/db", externalId: "db-1", status: "active", lifecycle: "manage", approvalId: "apr-1", ...over });

  it("leaves objects Zenith created to the existing guards", () => {
    expect(assessDecommission([target()], [])).toMatchObject({ allowed: true });
    expect(assessDecommission([target()], [fact({ address: "postgres/elsewhere", externalId: "other" })]).allowed).toBe(true);
  });

  it("refuses everything the claim did not allow, with a reason per object", () => {
    expect(assessDecommission([target({ ownership: "referenced" })], [])).toMatchObject({ allowed: false, verdicts: [{ code: "not_managed" }] });
    expect(assessDecommission([target()], [fact()]).verdicts[0]).toMatchObject({ allowed: false, code: "adopted_destroy_not_allowed" });
    expect(assessDecommission([target()], [fact({ status: "released" })]).verdicts[0]).toMatchObject({ allowed: false, code: "adoption_released" });
    expect(assessDecommission([target({ externalId: "db-2" })], [fact()]).verdicts[0]).toMatchObject({ allowed: false, code: "adoption_identity_mismatch" });
    expect(assessDecommission([target({ address: "postgres/alias" })], [fact()]).verdicts[0]).toMatchObject({ allowed: false, code: "adoption_alias" });
  });

  it("allows an adopted object only while its destroy-allowing claim is active and exact, and says which claim", () => {
    const verdicts = assertDecommissionAllowed([target()], [fact({ lifecycle: "manage_and_destroy" })]);
    expect(verdicts[0]).toMatchObject({ allowed: true, viaAdoptionClaim: "apr-1" });
    expect(() => assertDecommissionAllowed([target(), target({ address: "postgres/other", externalId: undefined })], [fact()])).toThrow(DecommissionRefusedError);
  });
});

describe("capability inputs", () => {
  it("are strict references, normalized, and shown to the approver", () => {
    expect(isPortabilityCapability("data.export")).toBe(true);
    expect(isPortabilityCapability("service.scale")).toBe(false);
    const dest = { resourceAddress: "object_store/backups", credentialsRef: "vault:proj/backups/creds" };
    const exp = parsePortabilityInput("data.export", { destination: dest });
    expect(portabilityDetails(exp)[0]).toContain("object_store/backups");
    expect(() => parsePortabilityInput("data.export", { destination: { ...dest, credentialsRef: "AKIA-not-a-ref" } })).toThrow();
    expect(() => parsePortabilityInput("data.export", { destination: dest, surprise: true })).toThrow();
    expect(() => parsePortabilityInput("data.import", { exportId: "pex_1", destination: dest })).not.toThrow();
    expect(() => parsePortabilityInput("data.import", { destination: dest })).toThrow();
    const adopt = parsePortabilityInput("resource.adopt", { claim: { externalId: "db-1", acknowledge: true } });
    expect((adopt.input as { claim: { lifecycle: string } }).claim.lifecycle).toBe("manage");
    expect(portabilityDetails(adopt).join(" ")).toContain("does NOT allow Zenith to delete");
    expect(portabilityDetails(parsePortabilityInput("resource.adopt", { claim: { externalId: "db-1", acknowledge: true, lifecycle: "manage_and_destroy" } })).join(" ")).toContain("ALLOWS a later approved destroy");
  });
});

describe("where the worker may connect", () => {
  it("classifies addresses", () => {
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("10.0.0.5")).toBe("private");
    expect(classifyAddress("172.20.1.1")).toBe("private");
    expect(classifyAddress("192.168.0.9")).toBe("private");
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("169.254.169.254")).toBe("never");
    expect(classifyAddress("0.0.0.0")).toBe("never");
    expect(classifyAddress("fe80::1")).toBe("never");
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("never");
    expect(classifyAddress("fd00::1")).toBe("private");
    expect(classifyAddress("2606:4700::1111")).toBe("public");
  });

  it("refuses metadata, loopback and private hosts by default, and a name that resolves to one", async () => {
    const lookup = async (host: string) => (host === "db.example.test" ? ["93.184.216.34"] : host === "sneaky.example.test" ? ["93.184.216.34", "169.254.169.254"] : ["10.1.2.3"]);
    await expect(assertConnectableHost("169.254.169.254", { lookup, allowPrivate: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertConnectableHost("127.0.0.1", { lookup, allowPrivate: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertConnectableHost("localhost", { lookup, allowPrivate: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertConnectableHost("metadata.google.internal", { lookup, allowPrivate: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertConnectableHost("10.0.0.5", { lookup, allowPrivate: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertConnectableHost("inside.example.test", { lookup, allowPrivate: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertConnectableHost("sneaky.example.test", { lookup, allowPrivate: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertConnectableHost("db.example.test", { lookup, allowPrivate: false })).resolves.toBeUndefined();
    await expect(assertConnectableHost("93.184.216.34", { lookup, allowPrivate: false })).resolves.toBeUndefined();
    await expect(assertConnectableHost("10.0.0.5", { lookup, allowPrivate: true })).resolves.toBeUndefined();
  });
});
