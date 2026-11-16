import { describe, expect, it } from "vitest";
import {
  computeDriftV2,
  defaultExpectedAttributes,
  expandManifest,
  type DriftFinding,
  type Observation,
  type ObservedValue,
  type Presence,
  type ResourceGraph,
} from "@/lib/resources";
import { PROD, fullManifest, shuffledCopy, webDb } from "./_fixtures";

const AT = "2026-09-30T12:00:00.000Z";
const known = (value: unknown, observedAt = AT): ObservedValue => ({ state: "known", value, observedAt });
const unknown = (reason: "not_supported" | "not_inspected" | "access_denied" | "error" | "not_applicable" = "not_inspected"): ObservedValue => ({ state: "unknown", reason });

const obs = (address: string, presence: Presence, attributes: Record<string, ObservedValue> = {}, extra: Partial<Observation> = {}): Observation => ({
  address,
  presence,
  attributes,
  observedAt: AT,
  source: "test.driver@1",
  simulated: false,
  ...extra,
});

const graph: ResourceGraph = expandManifest(webDb(), PROD);
const run = (observations: Observation[], opts = {}) => computeDriftV2(graph, observations, { computedAt: AT, ...opts });
const only = (findings: DriftFinding[], address: string) => findings.filter((f) => f.address === address);

/** Observe every node as present with no known attributes, so only what a test adds can drift. */
const allPresent = (): Observation[] => graph.nodes.map((n) => obs(n.address, "present"));
const withOverride = (o: Observation): Observation[] => [...allPresent().filter((x) => x.address !== o.address), o];

describe("drift v2: present, missing, changed", () => {
  it("reports nothing when everything is present and nothing known differs", () => {
    const r = run(allPresent());
    expect(r.findings).toEqual([]);
    expect(r.unobserved).toEqual([]);
    expect(r.environmentId).toBe("env-prod");
    expect(r.graphDigest).toBe(graph.graphDigest);
    expect(r.simulated).toBe(false);
    expect(r.computedAt).toBe(AT);
  });

  it("reports nothing when known attributes match (scalars compared as text)", () => {
    const r = run(withOverride(obs("container_service/web", "present", { replicas: known("2"), port: known(3000), size: known("small") })));
    expect(r.findings).toEqual([]);
  });

  it("a managed non-stateful node that is missing: medium, repairable, auto-repair eligible", () => {
    const r = run(withOverride(obs("log_group/web", "missing")));
    const f = only(r.findings, "log_group/web");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ class: "missing", severity: "medium", repairable: true, autoRepairEligible: true });
    expect(f[0].explanation).toMatch(/Re-applying recreates it/);
  });

  it("a stateful node that is missing is high severity, repairable but never auto-repaired", () => {
    const r = run(withOverride(obs("postgres/postgres", "missing")));
    expect(only(r.findings, "postgres/postgres")[0]).toMatchObject({ class: "missing", severity: "high", repairable: true, autoRepairEligible: false });
    expect(only(r.findings, "postgres/postgres")[0].explanation).toMatch(/data is gone/);
    expect(r.findings[0].address).toBe("postgres/postgres"); // high sorts first
  });

  it("a changed attribute is `changed`, with the differing fields only", () => {
    const r = run(withOverride(obs("container_service/web", "present", { replicas: known(3), port: known(3000), size: known("small") })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      class: "changed",
      severity: "medium",
      repairable: true,
      autoRepairEligible: true,
      fields: [{ attribute: "replicas", desired: 2, observed: 3 }],
    });
  });

  it("uses the driver's expectedAttributes callback when supplied", () => {
    const o = withOverride(obs("container_service/web", "present", { desiredCount: known(5), replicas: known(99) }));
    const r = run(o, { expectedAttributes: (n: { spec: Record<string, unknown> }) => ({ desiredCount: n.spec.replicas }) });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].fields).toEqual([{ attribute: "desiredCount", desired: 2, observed: 5 }]);
  });

  it("the default expectation is the spec's shallow scalars", () => {
    const web = graph.nodes.find((n) => n.address === "container_service/web")!;
    const d = defaultExpectedAttributes(web);
    expect(d).toMatchObject({ replicas: 2, port: 3000, size: "small", workload: "web" });
    expect(d).not.toHaveProperty("env");
    expect(d).not.toHaveProperty("artifact");
  });
});

describe("drift v2: unknown is never a match, never a change", () => {
  it("an unknown attribute produces no `changed` finding, whatever the desired value", () => {
    const r = run(withOverride(obs("container_service/web", "present", { replicas: unknown("access_denied"), port: unknown(), size: unknown("not_supported") })));
    expect(r.findings).toEqual([]);
  });

  it("only the known attributes are compared when others are unknown", () => {
    const r = run(withOverride(obs("container_service/web", "present", { replicas: unknown(), port: known(8080) })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].fields).toEqual([{ attribute: "port", desired: 3000, observed: 8080 }]);
  });

  it("presence unknown with every attribute unknown (or none) is class `unknown` and unobserved", () => {
    for (const attributes of [{} as Record<string, ObservedValue>, { replicas: unknown(), port: unknown("error") }]) {
      const r = run(withOverride(obs("container_service/web", "unknown", attributes, { error: "timeout" })));
      const f = only(r.findings, "container_service/web");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ class: "unknown", severity: "low", repairable: false, autoRepairEligible: false });
      expect(f[0].explanation).toMatch(/presence and every attribute are unknown/);
      expect(r.unobserved).toEqual(["container_service/web"]);
    }
  });

  it("presence unknown but some attribute known: that attribute is compared, no `unknown` finding", () => {
    const r = run(withOverride(obs("container_service/web", "unknown", { replicas: known(2), port: unknown() })));
    expect(r.findings).toEqual([]);
    const r2 = run(withOverride(obs("container_service/web", "unknown", { replicas: known(5) })));
    expect(r2.findings.map((f) => f.class)).toEqual(["changed"]);
  });

  it("a node nobody observed is `unknown` and listed as unobserved: silence is not a match", () => {
    const r2 = run(allPresent().filter((o) => o.address !== "log_group/web"));
    expect(r2.findings.map((f) => [f.address, f.class])).toEqual([["log_group/web", "unknown"]]);
    expect(r2.unobserved).toEqual(["log_group/web"]);
    const none = run([]);
    expect(none.findings).toHaveLength(graph.nodes.length);
    expect(none.findings.every((f) => f.class === "unknown" && !f.repairable && !f.autoRepairEligible)).toBe(true);
    expect(none.unobserved).toEqual(graph.nodes.map((n) => n.address).sort());
  });

  it("presence present with nothing known is not reported: existence is all that is claimed", () => {
    const r = run(withOverride(obs("postgres/postgres", "present", { engine: unknown(), version: unknown() })));
    expect(r.findings).toEqual([]);
    expect(r.unobserved).toEqual([]);
  });

  it("inaccessible is its own class, medium, unrepairable, and unobserved", () => {
    const r = run(withOverride(obs("postgres/postgres", "inaccessible", {}, { error: "AccessDenied: not authorized\nto describe\u0000 instances" })));
    const f = only(r.findings, "postgres/postgres")[0];
    expect(f).toMatchObject({ class: "inaccessible", severity: "medium", repairable: false, autoRepairEligible: false });
    expect(f.explanation).toMatch(/cannot read postgres\/postgres/);
    expect(f.explanation).toContain("AccessDenied: not authorized to describe instances");
    expect(f.explanation).not.toMatch(/[\u0000-\u001f]/);
    expect(r.unobserved).toEqual(["postgres/postgres"]);
  });

  it("an inaccessible node's stale attributes are not compared", () => {
    const r = run(withOverride(obs("container_service/web", "inaccessible", { replicas: known(99) })));
    expect(r.findings.map((f) => f.class)).toEqual(["inaccessible"]);
  });

  it("truncates a provider error rather than passing it through whole", () => {
    const r = run(withOverride(obs("postgres/postgres", "inaccessible", {}, { error: "x".repeat(5000) })));
    expect(only(r.findings, "postgres/postgres")[0].explanation.length).toBeLessThan(400);
  });
});

describe("drift v2: severity and repair rules", () => {
  it("an identity that changed is high and never auto-repaired", () => {
    const r = run(withOverride(obs("identity/web", "present", { principal: known("admin") })));
    expect(only(r.findings, "identity/web")[0]).toMatchObject({ class: "changed", severity: "high", repairable: true, autoRepairEligible: false });
  });

  it("a firewall opened to the world is high and never auto-repaired; a benign change is medium and eligible", () => {
    const open = run(withOverride(obs("firewall/web-to-postgres", "present", { port: known(5432), source: known(["0.0.0.0/0"]) }))
      , { expectedAttributes: () => ({ source: ["10.0.0.0/16"], port: 5432 }) });
    expect(open.findings).toHaveLength(1);
    expect(open.findings[0]).toMatchObject({ class: "changed", severity: "high", repairable: true, autoRepairEligible: false });
    expect(open.findings[0].explanation).toMatch(/admits more than the desired graph allows/);

    const wide = run(withOverride(obs("firewall/web-to-postgres", "present", { port: known("0-65535") })));
    expect(wide.findings[0]).toMatchObject({ severity: "high", autoRepairEligible: false });

    const benign = run(withOverride(obs("firewall/web-to-postgres", "present", { port: known(5433) })));
    expect(benign.findings[0]).toMatchObject({ severity: "medium", repairable: true, autoRepairEligible: true });

    // already-open by design (internet → lb) is not "opened"
    const already = run(withOverride(obs("firewall/internet-to-lb-443", "present", { description: known("something else") })));
    expect(already.findings[0]).toMatchObject({ severity: "medium" });
  });

  it("a stateful node that changed is never auto-repaired; becoming public is high", () => {
    const changed = run(withOverride(obs("postgres/postgres", "present", { version: known("15") })));
    expect(changed.findings[0]).toMatchObject({ class: "changed", severity: "medium", repairable: true, autoRepairEligible: false });
    const exposed = run(withOverride(obs("postgres/postgres", "present", { publiclyAccessible: known(true) })), {
      expectedAttributes: () => ({ publiclyAccessible: false }),
    });
    expect(exposed.findings[0]).toMatchObject({ severity: "high", autoRepairEligible: false });
    expect(exposed.findings[0].explanation).toMatch(/publicly reachable/);
  });

  it("only managed nodes are repairable; referenced ones are reported but never repaired; external ones are skipped", () => {
    const g = expandManifest(fullManifest(), PROD);
    const o = [
      obs("postgres/old-db", "missing"),
      obs("container_service/legacy", "present", { replicas: known(9) }),
      obs("queue/stripe", "missing"),
      obs("dns_zone/acme.io", "missing"),
    ];
    const r = computeDriftV2(g, o, { computedAt: AT, expectedAttributes: (n) => (n.address === "container_service/legacy" ? { replicas: 1 } : {}) });
    const byAddr = (a: string) => r.findings.find((f) => f.address === a);
    expect(byAddr("postgres/old-db")).toMatchObject({ class: "missing", severity: "high", repairable: false, autoRepairEligible: false });
    expect(byAddr("postgres/old-db")!.explanation).toMatch(/postgres\/old-db \(referenced\)/);
    expect(byAddr("container_service/legacy")).toMatchObject({ class: "changed", repairable: false, autoRepairEligible: false });
    expect(byAddr("dns_zone/acme.io")).toMatchObject({ class: "missing", repairable: false });
    expect(byAddr("queue/stripe")).toBeUndefined(); // external: no cloud presence to drift from
    expect(r.unobserved).not.toContain("queue/stripe");
  });

  it("no finding is ever repairable unless its node is managed", () => {
    const g = expandManifest(fullManifest(), PROD);
    const everythingMissing = g.nodes.map((n) => obs(n.address, "missing"));
    const r = computeDriftV2(g, everythingMissing, { computedAt: AT });
    for (const f of r.findings) {
      const n = g.nodes.find((x) => x.address === f.address)!;
      expect(f.repairable, f.address).toBe(n.ownership === "managed");
      if (f.severity === "high") expect(f.autoRepairEligible, f.address).toBe(false);
    }
    for (const f of r.findings.filter((x) => /^(postgres|redis|object_store|queue|secret|identity)\//.test(x.address))) expect(f.autoRepairEligible, f.address).toBe(false);
  });
});

describe("drift v2: extra", () => {
  const tagged = (env = "env-prod", managed: unknown = "true") => ({ native: { tags: { "zenith:managed": managed, "zenith:environment": env } } });

  it("reports an unowned observation only when it is tagged as Zenith's for this environment", () => {
    const r = run([...allPresent(), obs("queue/orphan", "present", {}, tagged())]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ address: "queue/orphan", class: "extra", severity: "medium", repairable: false, autoRepairEligible: false });
    expect(r.findings[0].explanation).toMatch(/tagged as Zenith-managed/);
  });

  it("ignores strangers: untagged, tagged for another environment, or tagged not-managed", () => {
    const r = run([
      ...allPresent(),
      obs("queue/stranger", "present"),
      obs("queue/other-env", "present", {}, tagged("env-other")),
      obs("queue/not-managed", "present", {}, tagged("env-prod", "false")),
      obs("queue/no-env-tag", "present", { }, { native: { tags: { "zenith:managed": "true" } } }),
    ]);
    expect(r.findings).toEqual([]);
  });

  it("reports a named address even without tags, and reads labels as well as tags", () => {
    const named = run([...allPresent(), obs("log_group/ghost", "present")], { includeExtra: ["log_group/ghost"] });
    expect(named.findings).toHaveLength(1);
    expect(named.findings[0]).toMatchObject({ class: "extra", severity: "low" });
    expect(named.findings[0].explanation).not.toMatch(/tagged/);
    const labelled = run([...allPresent(), obs("log_group/ghost", "present", {}, { native: { labels: { "zenith:managed": true, "zenith:environment": "env-prod" } } })]);
    expect(labelled.findings.map((f) => f.address)).toEqual(["log_group/ghost"]);
  });

  it("does not report something that is already gone", () => {
    expect(run([...allPresent(), obs("queue/orphan", "missing", {}, tagged())]).findings).toEqual([]);
  });

  it("sensitive extras (stateful, firewall, identity) are medium", () => {
    const r = run([...allPresent(), obs("firewall/mystery", "present", {}, tagged()), obs("identity/rogue", "present", {}, tagged()), obs("log_group/x", "present", {}, tagged())]);
    expect(Object.fromEntries(r.findings.map((f) => [f.address, f.severity]))).toEqual({ "firewall/mystery": "medium", "identity/rogue": "medium", "log_group/x": "low" });
  });
});

describe("drift v2: reporting hygiene", () => {
  it("redacts credential-looking attributes and truncates oversized values, but not pointer-shaped keys", () => {
    const big = { list: Array.from({ length: 400 }, (_, i) => `item-${i}`) };
    const r = run(
      withOverride(obs("postgres/postgres", "present", { masterPassword: known("hunter2-observed"), apiToken: known("tok-observed"), secretRef: known("vault:other"), blob: known(big) })),
      { expectedAttributes: () => ({ masterPassword: "hunter2-desired", apiToken: "tok-desired", secretRef: "vault:mine", blob: { list: [] } }) }
    );
    const f = r.findings[0];
    const by = Object.fromEntries((f.fields ?? []).map((x) => [x.attribute, x]));
    expect(by.masterPassword).toMatchObject({ desired: "[redacted]", observed: "[redacted]" });
    expect(by.apiToken).toMatchObject({ desired: "[redacted]", observed: "[redacted]" });
    expect(by.secretRef).toMatchObject({ desired: "vault:mine", observed: "vault:other" });
    expect((by.blob.observed as { truncated: boolean }).truncated).toBe(true);
    const json = JSON.stringify(r);
    for (const leaked of ["hunter2-observed", "hunter2-desired", "tok-observed", "tok-desired", "item-399"]) expect(json).not.toContain(leaked);
  });

  it("is `simulated` when any observation is simulated", () => {
    expect(run([...allPresent(), ]).simulated).toBe(false);
    expect(run(withOverride(obs("log_group/web", "present", {}, { simulated: true }))).simulated).toBe(true);
  });

  it("is deterministic: input order never matters, and the newest duplicate wins", () => {
    const base = withOverride(obs("container_service/web", "present", { replicas: known(3) }));
    const a = JSON.stringify(run(base));
    for (const seed of [1, 2, 3, 4]) expect(JSON.stringify(run(shuffledCopy(base, seed)))).toBe(a);

    const stale = obs("container_service/web", "present", { replicas: known(9, "2026-09-30T10:00:00.000Z") }, { observedAt: "2026-09-30T10:00:00.000Z" });
    const fresh = obs("container_service/web", "present", { replicas: known(2, "2026-09-30T11:00:00.000Z") }, { observedAt: "2026-09-30T11:00:00.000Z" });
    const rest = allPresent().filter((o) => o.address !== "container_service/web");
    expect(run([...rest, stale, fresh]).findings).toEqual([]);
    expect(run([...rest, fresh, stale]).findings).toEqual([]);
    const missingNewer = obs("container_service/web", "missing", {}, { observedAt: "2026-09-30T13:00:00.000Z" });
    expect(run([...rest, fresh, missingNewer]).findings[0].class).toBe("missing");
    expect(run([...rest, missingNewer, fresh]).findings[0].class).toBe("missing");
  });

  it("orders findings by severity, then class, then address", () => {
    const r = run([
      ...allPresent().filter((o) => !["postgres/postgres", "log_group/web", "container_service/web", "identity/web"].includes(o.address)),
      obs("log_group/web", "missing"),
      obs("postgres/postgres", "missing"),
      obs("container_service/web", "present", { replicas: known(1) }),
      obs("identity/web", "inaccessible"),
    ]);
    expect(r.findings.map((f) => `${f.severity}:${f.class}:${f.address}`)).toEqual([
      "high:missing:postgres/postgres",
      "medium:missing:log_group/web",
      "medium:changed:container_service/web",
      "medium:inaccessible:identity/web",
    ]);
  });

  it("stamps computedAt from the clock when not given", () => {
    const r = computeDriftV2(graph, allPresent(), { now: () => new Date("2026-01-02T03:04:05.000Z") });
    expect(r.computedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("does not touch the legacy drift module", async () => {
    const legacy = await import("@/lib/drift");
    expect(typeof legacy.computeDrift).toBe("function");
    expect(legacy).not.toHaveProperty("computeDriftV2");
  });
});
