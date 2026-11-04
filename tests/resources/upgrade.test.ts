import { describe, expect, it } from "vitest";
import type { Manifest } from "@/lib/domain/types";
import {
  downgradeToV1,
  ManifestV2,
  parseManifest,
  upgradeManifest,
  upgradeManifestDetailed,
  v1View,
  v2OnlySections,
} from "@/lib/resources";
import { blueprints } from "@/lib/blueprints";
import { fullManifest, manifest, res, svc, v1Fixtures, webDb } from "./_fixtures";

const TARGET = { provider: "aws", region: "us-east-1" } as const;

describe("upgradeManifest / downgradeToV1", () => {
  const fixtures = v1Fixtures();

  it("has a meaningful fixture population", () => {
    expect(fixtures.length).toBeGreaterThan(130);
    for (const bp of blueprints) expect(fixtures.some((f) => f.name === `blueprint:${bp.id}`)).toBe(true);
    expect(fixtures.some((f) => f.name === "importer:compose")).toBe(true);
    expect(fixtures.some((f) => f.name === "importer:terraform")).toBe(true);
  });

  it("round-trips losslessly for every fixture, including undefined-valued optional keys", () => {
    for (const { name, manifest: m } of fixtures) {
      const before = structuredClone(m);
      const up = upgradeManifest(m, TARGET);
      expect(m, `${name}: input mutated`).toStrictEqual(before);
      expect(up.version).toBe(2);
      // exact, down to key presence: toStrictEqual distinguishes `{a: undefined}` from `{}`
      expect(downgradeToV1(up), `${name}: round trip`).toStrictEqual(m);
    }
  });

  it("produces a manifest the V2 schema accepts unchanged", () => {
    for (const { name, manifest: m } of fixtures) {
      const up = upgradeManifest(m, TARGET);
      const parsed = ManifestV2.safeParse(up);
      expect(parsed.success, `${name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
      const viaParse = parseManifest(up);
      expect(viaParse.ok).toBe(true);
    }
  });

  it("is deterministic", () => {
    for (const { manifest: m } of fixtures.slice(0, 40)) {
      expect(JSON.stringify(upgradeManifestDetailed(m, TARGET))).toBe(JSON.stringify(upgradeManifestDetailed(m, TARGET)));
    }
  });

  it("does not alias the input: mutating the result leaves the V1 manifest alone", () => {
    const m = webDb();
    const up = upgradeManifest(m, TARGET);
    up.services[0].name = "changed";
    up.services[0].env.push({ key: "X", value: "1" });
    up.bindings.pop();
    expect(m.services[0].name).toBe("web");
    expect(m.services[0].env).toEqual([]);
    expect(m.bindings).toHaveLength(2);
    const back = downgradeToV1(upgradeManifest(m, TARGET));
    back.services[0].name = "again";
    expect(m.services[0].name).toBe("web");
  });

  it("applies V2 defaults and records every one in notes", () => {
    const { manifest: up, notes } = upgradeManifestDetailed(webDb(), TARGET);
    expect(up.placement).toEqual({ provider: "aws", regions: ["us-east-1"] });
    expect(up.policies).toEqual({ deletion: "approval", backup: "daily" });
    expect(up.constraints).toBeUndefined();
    expect(up.nodePlacement).toBeUndefined();
    expect(up.providerConfig).toBeUndefined();
    expect(up.native).toBeUndefined();
    expect(notes.some((n) => n.startsWith("placement:") && n.includes("us-east-1"))).toBe(true);
    expect(notes.some((n) => n.startsWith("policies.deletion:") && n.includes('"approval"'))).toBe(true);
    expect(notes.some((n) => n.startsWith("policies.backup:") && n.includes("postgres"))).toBe(true);
    expect(notes.some((n) => n.startsWith("policies.approvalRequired and policies.allowStatefulDeletion: left unset"))).toBe(true);
    expect(notes.some((n) => n.startsWith("constraints, nodePlacement, providerConfig and native: omitted"))).toBe(true);
  });

  it("names the stateful resources the backup default applies to, or says there are none", () => {
    expect(upgradeManifestDetailed(manifest({}), TARGET).notes.find((n) => n.startsWith("policies.backup"))).toMatch(/has none yet/);
    const withData = manifest({ resources: [res({ id: "r1", name: "zeta", kind: "queue" }), res({ id: "r2", name: "alpha", kind: "redis" })] });
    expect(upgradeManifestDetailed(withData, TARGET).notes.find((n) => n.startsWith("policies.backup"))).toContain("(alpha, zeta)");
  });

  it("carries the environment's V1 policies over when given, and says so", () => {
    const { manifest: up, notes } = upgradeManifestDetailed(webDb(), {
      ...TARGET,
      policies: { approvalRequired: true, allowStatefulDeletion: false, budgetUsdMonthly: 250 },
    });
    expect(up.policies).toEqual({ deletion: "approval", backup: "daily", approvalRequired: true, allowStatefulDeletion: false });
    expect(up.constraints).toEqual({ budgetUsdMonthly: 250 });
    expect(notes.filter((n) => /carried over/.test(n))).toHaveLength(3);
    expect(notes.some((n) => /left unset/.test(n))).toBe(false);
    expect(ManifestV2.safeParse(up).success).toBe(true);
  });

  it("supports provider auto without a region, and demands one otherwise", () => {
    const auto = upgradeManifestDetailed(webDb(), { provider: "auto" });
    expect(auto.manifest.placement).toEqual({ provider: "auto", regions: [] });
    expect(auto.notes[0]).toMatch(/no region/);
    expect(() => upgradeManifest(webDb(), { provider: "aws" })).toThrow(/regions needs at least one region/);
    expect(() => upgradeManifest(webDb(), { provider: "aws", region: "US EAST" })).toThrow(/Cannot upgrade/);
  });

  it("refuses anything that is not a V1 manifest", () => {
    const v2 = upgradeManifest(webDb(), TARGET);
    expect(() => upgradeManifest(v2 as unknown as Manifest, TARGET)).toThrow(/version 1/);
  });

  it("downgrade of an authored V2 drops V2-only sections, and v2OnlySections says which", () => {
    const up = upgradeManifest(fullManifest(), TARGET);
    expect(v2OnlySections(up)).toEqual(["placement", "policies"]);
    const rich = ManifestV2.parse({
      ...up,
      constraints: { availabilityTarget: 99.9 },
      nodePlacement: { db: { provider: "gcp", region: "europe-west1" } },
      providerConfig: { aws: { natGateways: "single" } },
      native: [{ id: "topic", provider: "aws", type: "aws:sns_topic", config: {} }],
      release: { migrate: { service: "api", command: ["node", "migrate.js"] } },
    });
    expect(v2OnlySections(rich)).toEqual(["placement", "constraints", "policies", "nodePlacement", "providerConfig", "native", "release"]);
    expect(downgradeToV1(rich)).toStrictEqual(fullManifest());
  });

  it("v1View returns a V1 as-is and the V1 part of a V2", () => {
    const m = webDb();
    expect(v1View(m)).toBe(m);
    expect(v1View(upgradeManifest(m, TARGET))).toStrictEqual(m);
  });

  it("carries ids, ownership and secret references untouched", () => {
    const m = manifest({
      services: [svc({ id: "svc-a", name: "aa", kind: "worker", ownership: "referenced", env: [{ key: "TOKEN", secretRef: "vault:p/a/TOKEN" }, { key: "MODE", value: "x" }] })],
    });
    const up = upgradeManifest(m, TARGET);
    expect(up.services[0]).toStrictEqual(m.services[0]);
  });
});
