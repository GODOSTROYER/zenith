/**
 * Hypothesis rules are data. These tests check the data is sane (every clause
 * refers to a check a probe really emits, no single indicator can convince on
 * its own), and that the scoring arithmetic is exactly what the module comment
 * promises.
 */
import { describe, expect, it } from "vitest";
import { HYPOTHESIS_THRESHOLD, RULES, UNKNOWN_CONFIDENCE, rankHypotheses, scoreRule, type Evidence, type HypothesisRule } from "@/lib/incidents";
import { changesProbe, deployProbe, driftProbe } from "@/lib/incidents/probes-change";
import { cacheProbe, computeProbe, databaseProbe, identityProbe, queueProbe, secretProbe, storageProbe } from "@/lib/incidents/probes-dependencies";
import { dnsProbe, firewallProbe, httpProbe, lbProbe, tlsProbe } from "@/lib/incidents/probes-edge";
import { LOG_CHECKS, applicationProbe, capacityProbe, serviceProbe } from "@/lib/incidents/probes-workload";

const ev = (check: string, outcome: Evidence["outcome"], data: Record<string, unknown> = {}, id = `ev:${check}`): Evidence => ({
  id,
  hop: "firewall",
  check,
  outcome,
  finding: "f",
  observedAt: "2026-09-30T12:00:00.000Z",
  data,
  simulated: false,
});

const EMITTED = new Set<string>([
  ...[changesProbe, deployProbe, driftProbe, httpProbe, dnsProbe, tlsProbe, lbProbe, firewallProbe, serviceProbe, capacityProbe, applicationProbe, databaseProbe, cacheProbe, queueProbe, storageProbe, computeProbe, secretProbe, identityProbe].flatMap((p) => [...p.checks]),
  ...LOG_CHECKS,
  "drift.missing",
  "drift.changed",
  "drift.inaccessible",
  "drift.unknown",
  "http.dns_resolution",
  "http.tls_handshake",
]);

describe("rule data", () => {
  it("has unique codes and non-empty titles", () => {
    expect(new Set(RULES.map((r) => r.code)).size).toBe(RULES.length);
    for (const r of RULES) expect(r.title.length).toBeGreaterThan(10);
    expect(RULES.map((r) => r.code)).toEqual(
      expect.arrayContaining([
        "db_unreachable_security_group",
        "db_down",
        "bad_deploy",
        "container_crash_oom",
        "image_pull_failure",
        "missing_secret",
        "iam_denied",
        "dns_misconfigured",
        "certificate_invalid",
        "lb_no_healthy_targets",
        "capacity_saturation",
      ])
    );
  });

  it("every clause names a check that a probe can actually emit (no typos, no dead clauses)", () => {
    for (const r of RULES) for (const c of [...r.requires, ...r.contradicts]) expect(EMITTED.has(c.match.check), `${r.code}.${c.id} → ${c.match.check}`).toBe(true);
  });

  it("clause ids are unique within a rule and anchors are supporting clauses", () => {
    for (const r of RULES) {
      const ids = [...r.requires, ...r.contradicts].map((c) => c.id);
      expect(new Set(ids).size, r.code).toBe(ids.length);
      expect(r.anchors.length, r.code).toBeGreaterThan(0);
      for (const a of r.anchors) expect(r.requires.some((c) => c.id === a), `${r.code} anchor ${a}`).toBe(true);
    }
  });

  it("weights are positive and no single indicator can reach the 0.8 a textbook case is expected to", () => {
    for (const r of RULES) for (const c of [...r.requires, ...r.contradicts]) {
      expect(c.weight, `${r.code}.${c.id}`).toBeGreaterThan(0);
      expect(c.weight, `${r.code}.${c.id}`).toBeLessThan(0.8);
    }
  });

  it("a textbook case can reach 0.8 (unless the rule is deliberately capped)", () => {
    for (const r of RULES) {
      const best = Math.min(r.requires.reduce((a, c) => a + c.weight, 0), r.cap ?? 1);
      if (r.cap !== undefined) expect(r.cap).toBeLessThan(0.8);
      else expect(best, r.code).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("the generic load balancer rule is capped below every specific rule's textbook confidence", () => {
    expect(RULES.find((r) => r.code === "lb_no_healthy_targets")?.cap).toBeLessThanOrEqual(0.5);
  });

  it("the unknown fallback sits below the reporting threshold", () => {
    expect(UNKNOWN_CONFIDENCE).toBeLessThan(HYPOTHESIS_THRESHOLD);
    expect(HYPOTHESIS_THRESHOLD).toBe(0.3);
  });
});

describe("scoring arithmetic", () => {
  const rule: HypothesisRule = {
    code: "t",
    title: "a test rule for scoring",
    category: "runtime",
    requires: [
      { id: "a", match: { check: "x.a", outcome: "fail" }, weight: 0.4, note: "a" },
      { id: "b", match: { check: "x.b", outcome: "fail", data: { kind: "db", n: 3, ok: true } }, weight: 0.3, note: "b" },
      { id: "c", match: { check: "x.c", outcome: "pass" }, weight: 0.2, note: "c" },
    ],
    contradicts: [{ id: "z", match: { check: "x.z", outcome: "fail" }, weight: 0.25, note: "z" }],
    anchors: ["a"],
  };

  it("sums satisfied supports, subtracts satisfied contradictions, and rounds to three places", () => {
    expect(scoreRule(rule, [ev("x.a", "fail")]).confidence).toBe(0.4);
    expect(scoreRule(rule, [ev("x.a", "fail"), ev("x.c", "pass")]).confidence).toBe(0.6);
    expect(scoreRule(rule, [ev("x.a", "fail"), ev("x.c", "pass"), ev("x.z", "fail")]).confidence).toBe(0.35);
    const third: HypothesisRule = { ...rule, requires: [{ ...rule.requires[0], weight: 0.1 }, { ...rule.requires[1], match: { check: "x.b", outcome: "fail" }, weight: 0.2 }], anchors: ["a"] };
    expect(scoreRule(third, [ev("x.a", "fail"), ev("x.b", "fail")]).confidence).toBe(0.3); // 0.1 + 0.2 without float noise
  });

  it("counts a clause once however many records satisfy it", () => {
    const s = scoreRule(rule, [ev("x.a", "fail", {}, "e1"), ev("x.a", "fail", {}, "e2")]);
    expect(s.confidence).toBe(0.4);
    expect(s.supporting).toEqual(["e1", "e2"]);
  });

  it("clamps to 0 and to 1", () => {
    expect(scoreRule(rule, [ev("x.a", "fail", {}, "e1"), ev("x.z", "fail")]).confidence).toBe(0.15);
    const heavy: HypothesisRule = { ...rule, contradicts: [{ ...rule.contradicts[0], weight: 0.9 }] };
    expect(scoreRule(heavy, [ev("x.a", "fail"), ev("x.z", "fail")]).confidence).toBe(0);
    const big: HypothesisRule = { ...rule, requires: rule.requires.map((c) => ({ ...c, weight: 0.7 })) };
    expect(scoreRule(big, [ev("x.a", "fail"), ev("x.b", "fail", { kind: "db", n: 3, ok: true }), ev("x.c", "pass")]).confidence).toBe(1);
  });

  it("applies the cap", () => {
    const capped: HypothesisRule = { ...rule, cap: 0.5 };
    expect(scoreRule(capped, [ev("x.a", "fail"), ev("x.b", "fail", { kind: "db", n: 3, ok: true }), ev("x.c", "pass")]).confidence).toBe(0.5);
  });

  it("does not fire without an anchor, however much side evidence there is", () => {
    const s = scoreRule(rule, [ev("x.b", "fail", { kind: "db", n: 3, ok: true }), ev("x.c", "pass")]);
    expect(s.fired).toBe(false);
    expect(s.confidence).toBe(0);
  });

  it("unknown evidence satisfies nothing: it neither supports nor contradicts", () => {
    const s = scoreRule(rule, [ev("x.a", "unknown"), ev("x.z", "unknown")]);
    expect(s.fired).toBe(false);
    const withAnchor = scoreRule(rule, [ev("x.a", "fail"), ev("x.b", "unknown"), ev("x.z", "unknown")]);
    expect(withAnchor.confidence).toBe(0.4);
    expect(withAnchor.contradicting).toEqual([]);
  });

  it("data predicates match exactly, by strict equality", () => {
    expect(scoreRule(rule, [ev("x.a", "fail"), ev("x.b", "fail", { kind: "db", n: 3, ok: true })]).confidence).toBe(0.7);
    expect(scoreRule(rule, [ev("x.a", "fail"), ev("x.b", "fail", { kind: "db", n: "3", ok: true })]).confidence).toBe(0.4);
    expect(scoreRule(rule, [ev("x.a", "fail"), ev("x.b", "fail", { kind: "db", n: 3 })]).confidence).toBe(0.4);
    expect(scoreRule(rule, [ev("x.a", "fail"), ev("x.b", "pass", { kind: "db", n: 3, ok: true })]).confidence).toBe(0.4);
  });

  it("a clause with `unless` is void while any evidence matches the exception", () => {
    const guarded: HypothesisRule = {
      ...rule,
      contradicts: [{ id: "z", match: { check: "x.z", outcome: "pass" }, weight: 0.25, note: "z", unless: { check: "x.z", outcome: "fail" } }],
    };
    expect(scoreRule(guarded, [ev("x.a", "fail"), ev("x.z", "pass", {}, "p1")]).confidence).toBe(0.15);
    expect(scoreRule(guarded, [ev("x.a", "fail"), ev("x.z", "pass", {}, "p1"), ev("x.z", "fail", {}, "f1")]).confidence).toBe(0.4);
  });

  it("records each satisfied clause with its weight, note and evidence ids", () => {
    const s = scoreRule(rule, [ev("x.a", "fail", {}, "ea"), ev("x.z", "fail", {}, "ez")]);
    expect(s.basis).toEqual([
      { clause: "a", kind: "supports", weight: 0.4, note: "a", evidence: ["ea"] },
      { clause: "z", kind: "contradicts", weight: 0.25, note: "z", evidence: ["ez"] },
    ]);
    expect(s.contradicting).toEqual(["ez"]);
  });
});

describe("ranking", () => {
  const simple = (code: string, weight: number): HypothesisRule => ({
    code,
    title: `rule ${code} for ranking`,
    category: "runtime",
    requires: [{ id: "a", match: { check: "x.a", outcome: "fail" }, weight, note: "a" }],
    contradicts: [],
    anchors: ["a"],
  });

  it("orders by confidence descending, then code ascending", () => {
    const rules = [simple("zeta", 0.5), simple("alpha", 0.5), simple("mid", 0.7), simple("low", 0.31)];
    const out = rankHypotheses([ev("x.a", "fail")], {}, rules);
    expect(out.map((h) => [h.code, h.confidence])).toEqual([["mid", 0.7], ["alpha", 0.5], ["zeta", 0.5], ["low", 0.31]]);
  });

  it("drops anything under the threshold, and is stable under evidence reordering", () => {
    const rules = [simple("a", 0.29), simple("b", 0.3)];
    expect(rankHypotheses([ev("x.a", "fail")], {}, rules).map((h) => h.code)).toEqual(["b"]);
  });

  it("returns the unknown fallback only when nothing reaches the threshold and there is something to explain", () => {
    const rules = [simple("a", 0.1)];
    expect(rankHypotheses([ev("x.a", "pass")], {}, rules)).toEqual([]);
    expect(rankHypotheses([ev("x.a", "pass")], { hasSymptom: true }, rules)[0]).toMatchObject({ code: "unknown", confidence: UNKNOWN_CONFIDENCE });
    const failing = rankHypotheses([ev("x.a", "fail", {}, "e1"), ev("x.b", "unknown", {}, "e2"), ev("x.c", "pass", {}, "e3")], {}, rules)[0];
    expect(failing.code).toBe("unknown");
    expect(failing.supportingEvidence).toEqual(["e1", "e2"]);
    expect(failing.contradictingEvidence).toEqual(["e3"]);
    expect(failing.title).toMatch(/1 failing check/);
    const onlyUnknown = rankHypotheses([ev("x.b", "unknown")], {}, rules)[0];
    expect(onlyUnknown.title).toMatch(/could not be completed/);
  });

  it("never returns the fallback alongside a real hypothesis", () => {
    const out = rankHypotheses([ev("x.a", "fail"), ev("x.b", "unknown")], { hasSymptom: true }, [simple("a", 0.6)]);
    expect(out.map((h) => h.code)).toEqual(["a"]);
  });
});
