/**
 * PROD-OBS-03 pure rules: fingerprint, hysteresis, policy validation, the
 * remediation gate (every code), autoscaler conflict, escalation, postmortem
 * determinism, and the gate's enforcement inside the investigation engine.
 */
import { describe, expect, it } from "vitest";
import { investigate, type GateRequest } from "@/lib/incidents";
import {
  DEFAULT_STABILITY_POLICY,
  INITIAL_SIGNAL,
  StabilityPolicyError,
  advanceSignal,
  autoscalerManaged,
  buildPostmortem,
  cooldownMs,
  decideEscalation,
  decideRemediation,
  gateUnavailable,
  incidentFingerprint,
  resolveStabilityPolicy,
  trustedObservation,
  type AttemptView,
  type GateSnapshot,
  type SignalState,
} from "@/lib/incidents/stability";
import { ADDR, ENV, PROJECT, WORKSPACE, buildGraph, healthyWorld, makePorts, node, removeDbIngress, series } from "./fixtures";

const P = DEFAULT_STABILITY_POLICY;
const scaler = (spec: Record<string, unknown>) => ({ ...node("provider_native/hpa", "function", spec, { nativeType: "k8s:HorizontalPodAutoscaler" }), kind: "provider_native" as const });
const NOW = new Date("2026-10-05T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const req = (over: Partial<GateRequest> = {}): GateRequest => ({ capability: "drift.repair", resourceId: "firewall/a", blastRadius: "low", risk: "high", confidence: 0.9, autoscalerManaged: false, ...over });
const snap = (over: Partial<GateSnapshot> = {}): GateSnapshot => ({
  now: NOW,
  environmentId: "env_1",
  incident: { id: "inc_1", status: "open" },
  signalActive: true,
  incidentAttempts: [],
  fingerprintAttempts: [],
  environmentAttempts: [],
  workspaceAttemptCount: 0,
  windows: [],
  ...over,
});
const attempt = (id: string, m: number, status: AttemptView["status"] = "succeeded", resourceId = "firewall/a"): AttemptView => ({ id, incidentId: "inc_1", environmentId: "env_1", fingerprint: "f", capability: "drift.repair", resourceId, status, reservedAt: minutesAgo(m) });

describe("fingerprint", () => {
  const base = { workspaceId: "ws", environmentId: "env", problem: "db_unreachable_security_group", subject: "resource/db" };
  it("is stable and scoped", () => {
    expect(incidentFingerprint(base)).toBe(incidentFingerprint({ ...base, problem: "  DB_UNREACHABLE_SECURITY_GROUP " }));
    expect(incidentFingerprint(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(incidentFingerprint(base)).not.toBe(incidentFingerprint({ ...base, environmentId: "other" }));
    expect(incidentFingerprint(base)).not.toBe(incidentFingerprint({ ...base, workspaceId: "other" }));
    expect(incidentFingerprint(base)).not.toBe(incidentFingerprint({ ...base, subject: "resource/cache" }));
  });
  it("refuses empty parts", () => {
    expect(() => incidentFingerprint({ ...base, problem: " " })).toThrow(StabilityPolicyError);
  });
});

describe("hysteresis", () => {
  const run = (obs: ("bad" | "good" | "unknown")[]) => {
    let s: SignalState = INITIAL_SIGNAL;
    const transitions: string[] = [];
    for (const o of obs) {
      const r = advanceSignal(P, s, o);
      s = r.next;
      transitions.push(r.transition);
    }
    return { s, transitions };
  };
  it("opens only after openAfter consecutive bad observations", () => {
    expect(run(["bad", "bad"]).s.state).toBe("quiet");
    expect(run(["bad", "bad", "good", "bad", "bad"]).s.state).toBe("quiet");
    const r = run(["bad", "bad", "bad"]);
    expect(r.s.state).toBe("active");
    expect(r.transitions).toEqual(["none", "none", "activated"]);
  });
  it("clears only after clearAfter consecutive good observations, and one bad resets", () => {
    const active = ["bad", "bad", "bad"] as const;
    expect(run([...active, "good", "good", "good", "good"]).s.state).toBe("active");
    expect(run([...active, "good", "good", "good", "good", "bad", "good", "good", "good", "good"]).s.state).toBe("active");
    const r = run([...active, "good", "good", "good", "good", "good"]);
    expect(r.s.state).toBe("quiet");
    expect(r.transitions.at(-1)).toBe("cleared");
  });
  it("unknown neither opens nor clears nor resets", () => {
    expect(run(["bad", "bad", "unknown", "bad"]).s.state).toBe("active");
    expect(run(["bad", "bad", "bad", "good", "good", "unknown", "unknown", "unknown", "good", "good", "good"]).s.state).toBe("quiet");
    expect(run(["bad", "bad", "bad", "good", "good", "unknown", "unknown"]).s.state).toBe("active");
  });
  it("a flapping signal never opens or clears", () => {
    const flap = Array.from({ length: 40 }, (_, i) => (i % 2 ? "good" : "bad")) as ("bad" | "good")[];
    const r = run(flap);
    expect(r.s.state).toBe("quiet");
    expect(r.transitions.every((t) => t === "none")).toBe(true);
  });
});

describe("policy", () => {
  it("accepts defaults and sane overrides", () => {
    expect(resolveStabilityPolicy()).toEqual(P);
    expect(resolveStabilityPolicy({ remediation: { maxAttemptsPerIncident: 1 } }).remediation.maxAttemptsPerIncident).toBe(1);
  });
  it("refuses removing a limit or loosening past the ceiling", () => {
    expect(() => resolveStabilityPolicy({ remediation: { maxAttemptsPerIncident: 0 } })).toThrow(StabilityPolicyError);
    expect(() => resolveStabilityPolicy({ remediation: { maxAttemptsPerIncident: 11 } })).toThrow(StabilityPolicyError);
    expect(() => resolveStabilityPolicy({ remediation: { baseCooldownMs: 0 } })).toThrow(StabilityPolicyError);
    expect(() => resolveStabilityPolicy({ remediation: { maxRisk: "critical" } })).toThrow(StabilityPolicyError);
    expect(() => resolveStabilityPolicy({ remediation: { minConfidence: 0.1 } })).toThrow(StabilityPolicyError);
    expect(() => resolveStabilityPolicy({ hysteresis: { openAfter: 5, clearAfter: 2 } })).toThrow(StabilityPolicyError);
    expect(() => resolveStabilityPolicy({ remediation: { baseCooldownMs: 600_000, maxCooldownMs: 60_000 } })).toThrow(StabilityPolicyError);
  });
});

describe("remediation gate", () => {
  it("allows a clean first attempt", () => {
    expect(decideRemediation(P, snap(), req())).toEqual({ allowed: true, codes: [], messages: [], escalate: false });
  });
  it("is deterministic", () => {
    const s = snap({ incidentAttempts: [attempt("a", 1, "failed")] });
    expect(decideRemediation(P, s, req())).toEqual(decideRemediation(P, s, req()));
  });
  it("blocks in a maintenance window and reports when it lifts; other environments are unaffected", () => {
    const w = { id: "w", environmentId: "env_1", startsAt: minutesAgo(10), endsAt: new Date(NOW.getTime() + 600_000).toISOString() };
    const d = decideRemediation(P, snap({ windows: [w] }), req());
    expect(d.codes).toEqual(["maintenance_window"]);
    expect(d.retryAfter).toBe(w.endsAt);
    expect(decideRemediation(P, snap({ windows: [{ ...w, environmentId: "env_2" }] }), req()).allowed).toBe(true);
    expect(decideRemediation(P, snap({ windows: [{ id: "w", startsAt: w.startsAt, endsAt: w.endsAt }] }), req()).codes).toEqual(["maintenance_window"]);
    expect(decideRemediation(P, snap({ windows: [{ ...w, endsAt: minutesAgo(1) }] }), req()).allowed).toBe(true);
  });
  it("blocks resolved, escalated and unconfirmed incidents", () => {
    expect(decideRemediation(P, snap({ incident: { id: "i", status: "resolved" } }), req()).codes).toContain("incident_inactive");
    expect(decideRemediation(P, snap({ incident: { id: "i", status: "open", escalatedAt: minutesAgo(1) } }), req()).codes).toContain("escalated_to_human");
    expect(decideRemediation(P, snap({ signalActive: false }), req()).codes).toEqual(["signal_not_confirmed"]);
  });
  it("blocks low confidence, high risk and wide blast radius, and escalates the latter two", () => {
    expect(decideRemediation(P, snap(), req({ confidence: 0.49 })).codes).toEqual(["low_confidence"]);
    const risk = decideRemediation(P, snap(), req({ risk: "critical" }));
    expect(risk.codes).toEqual(["risk_too_high"]);
    expect(risk.escalate).toBe(true);
    const blast = decideRemediation(P, snap(), req({ blastRadius: "high" }));
    expect(blast.codes).toEqual(["blast_radius_exceeded"]);
    expect(blast.escalate).toBe(true);
    expect(decideRemediation(resolveStabilityPolicy({ remediation: { maxBlastRadius: "high" } }), snap(), req({ blastRadius: "high" })).allowed).toBe(true);
  });
  it("blocks an autoscaler conflict", () => {
    const d = decideRemediation(P, snap(), req({ capability: "service.scale", autoscalerManaged: true }));
    expect(d.codes).toEqual(["autoscaler_conflict"]);
    expect(d.escalate).toBe(true);
  });
  it("enforces the per-incident attempt limit (counting failed attempts) and escalates", () => {
    const three = [attempt("a", 300, "failed"), attempt("b", 200, "failed"), attempt("c", 100, "failed")];
    const d = decideRemediation(P, snap({ incidentAttempts: three, fingerprintAttempts: three }), req());
    expect(d.codes).toContain("attempts_exhausted");
    expect(d.escalate).toBe(true);
    expect(decideRemediation(P, snap({ incidentAttempts: three.slice(0, 2), fingerprintAttempts: [] }), req()).codes).not.toContain("attempts_exhausted");
  });
  it("enforces cooldown with exponential backoff after failures", () => {
    expect(cooldownMs(P, 0)).toBe(5 * 60_000);
    expect(cooldownMs(P, 1)).toBe(10 * 60_000);
    expect(cooldownMs(P, 30)).toBe(P.remediation.maxCooldownMs);
    const recent = decideRemediation(P, snap({ incidentAttempts: [attempt("a", 2)] }), req());
    expect(recent.codes).toEqual(["cooldown_active"]);
    expect(recent.retryAfter).toBe(new Date(NOW.getTime() + 3 * 60_000).toISOString());
    expect(decideRemediation(P, snap({ incidentAttempts: [attempt("a", 6)] }), req()).allowed).toBe(true);
    // a failed attempt 6 minutes ago still holds a 10 minute backoff
    expect(decideRemediation(P, snap({ incidentAttempts: [attempt("a", 6, "failed")] }), req()).codes).toEqual(["cooldown_active"]);
    expect(decideRemediation(P, snap({ fingerprintCooldownUntil: new Date(NOW.getTime() + 1000).toISOString() }), req()).codes).toEqual(["cooldown_active"]);
  });
  it("limits in-flight repairs per environment and lets a stale reservation expire", () => {
    expect(decideRemediation(P, snap({ environmentAttempts: [attempt("a", 3, "reserved", "firewall/other")] }), req()).codes).toContain("inflight_limit");
    expect(decideRemediation(P, snap({ environmentAttempts: [attempt("a", 20, "reserved", "firewall/other")] }), req()).codes).not.toContain("inflight_limit");
  });
  it("limits repairs per environment window, distinct resources and per workspace", () => {
    const five = ["a", "b", "c", "d", "e"].map((id, i) => attempt(id, 10 + i * 5, "succeeded", `firewall/${id}`));
    expect(decideRemediation(P, snap({ environmentAttempts: five }), req({ resourceId: "firewall/a" })).codes).toContain("environment_rate_limit");
    const three = five.slice(0, 3);
    expect(decideRemediation(P, snap({ environmentAttempts: three }), req({ resourceId: "firewall/new" })).codes).toEqual(["resource_spread_limit"]);
    expect(decideRemediation(P, snap({ environmentAttempts: three }), req({ resourceId: "firewall/a" })).allowed).toBe(true);
    expect(decideRemediation(P, snap({ workspaceAttemptCount: 20 }), req()).codes).toEqual(["workspace_rate_limit"]);
  });
  it("a repair storm of 100 proposals admits only the blast-radius cap", () => {
    const env: AttemptView[] = [];
    let admitted = 0;
    for (let i = 0; i < 100; i++) {
      const now = new Date(NOW.getTime() + i * 1000);
      const d = decideRemediation(P, snap({ now, incident: null, signalActive: null, environmentAttempts: env, workspaceAttemptCount: env.length }), req({ resourceId: `firewall/r${i}` }));
      if (d.allowed) {
        admitted++;
        env.push({ ...attempt(`n${i}`, 0, "succeeded", `firewall/r${i}`), reservedAt: now.toISOString() });
      }
    }
    expect(admitted).toBe(P.remediation.maxDistinctResourcesPerWindow);
  });
  it("lists every blocking code in fixed order", () => {
    const w = { id: "w", startsAt: minutesAgo(1), endsAt: new Date(NOW.getTime() + 60_000).toISOString() };
    const d = decideRemediation(P, snap({ windows: [w], signalActive: false }), req({ confidence: 0.1, blastRadius: "high" }));
    expect(d.codes).toEqual(["maintenance_window", "signal_not_confirmed", "low_confidence", "blast_radius_exceeded"]);
    expect(d.messages).toHaveLength(4);
  });
  it("gateUnavailable fails closed", () => {
    expect(gateUnavailable().allowed).toBe(false);
  });
});

describe("autoscaler detection", () => {
  const withScaler = (target?: string) => {
    const g = buildGraph();
    g.nodes.push(scaler(target === undefined ? {} : { target }));
    return g;
  };
  it("matches by address or short name, and conservatively when the target is unknown", () => {
    expect(autoscalerManaged(withScaler(ADDR.web), "service.scale", ADDR.web)).toBe(true);
    expect(autoscalerManaged(withScaler("web"), "service.scale", ADDR.web)).toBe(true);
    expect(autoscalerManaged(withScaler(), "service.scale", ADDR.web)).toBe(true);
    expect(autoscalerManaged(withScaler("other"), "service.scale", ADDR.web)).toBe(false);
  });
  it("only concerns replica-setting capabilities and a graph with an autoscaler", () => {
    expect(autoscalerManaged(withScaler(ADDR.web), "service.restart", ADDR.web)).toBe(false);
    expect(autoscalerManaged(buildGraph(), "service.scale", ADDR.web)).toBe(false);
    expect(autoscalerManaged(withScaler(ADDR.web), "service.scale", undefined)).toBe(false);
  });
});

describe("escalation", () => {
  const incident = { severity: "high" as const, openedAt: minutesAgo(10), status: "open" };
  const input = { now: NOW, incident, countedAttempts: 0, blockedCodes: [] };
  it("escalates an inconclusive diagnosis", () => {
    expect(decideEscalation(P, { ...input, diagnosis: { hypotheses: [{ code: "unknown", confidence: 0.2 }] } }).reasons).toEqual(["inconclusive_diagnosis"]);
    expect(decideEscalation(P, { ...input, diagnosis: { hypotheses: [] } }).reasons).toEqual(["inconclusive_diagnosis"]);
    expect(decideEscalation(P, { ...input, diagnosis: { hypotheses: [{ code: "bad_deploy", confidence: 0.4 }] } }).escalate).toBe(true);
    expect(decideEscalation(P, { ...input, diagnosis: { hypotheses: [{ code: "bad_deploy", confidence: 0.8 }] } }).escalate).toBe(false);
    expect(decideEscalation(P, input).escalate).toBe(false);
  });
  it("escalates exhausted attempts, caps that need a person, and unresolved age", () => {
    expect(decideEscalation(P, { ...input, countedAttempts: 3 }).reasons).toEqual(["attempts_exhausted"]);
    expect(decideEscalation(P, { ...input, blockedCodes: ["blast_radius_exceeded"] }).reasons).toEqual(["remediation_requires_human"]);
    expect(decideEscalation(P, { ...input, incident: { ...incident, openedAt: minutesAgo(121) } }).reasons).toEqual(["unresolved_too_long"]);
    expect(decideEscalation(P, { ...input, incident: { ...incident, severity: "critical", openedAt: minutesAgo(31) } }).reasons).toEqual(["unresolved_too_long"]);
  });
  it("never escalates a resolved incident and reports an existing escalation", () => {
    expect(decideEscalation(P, { ...input, incident: { ...incident, status: "resolved" }, countedAttempts: 9 }).escalate).toBe(false);
    expect(decideEscalation(P, { ...input, countedAttempts: 3, incident: { ...incident, escalatedAt: minutesAgo(1) } }).alreadyEscalated).toBe(true);
  });
});

describe("postmortem", () => {
  const input = {
    incident: { id: "inc_1", title: "Database unreachable", severity: "high", source: "probe", openedAt: minutesAgo(40), resolvedAt: minutesAgo(5), occurrenceCount: 4, escalatedAt: minutesAgo(20), escalationReasons: ["attempts_exhausted"] },
    investigations: [{ id: "inv_1", startedAt: minutesAgo(38), hypotheses: [{ code: "db_unreachable_security_group", title: "DB blocked", confidence: 0.9, supportingEvidence: ["e1", "e2"] }] }],
    attempts: [{ id: "a1", incidentId: "inc_1", environmentId: "e", fingerprint: "f", capability: "drift.repair", resourceId: "firewall/a", status: "failed" as const, reservedAt: minutesAgo(30) }],
    blocked: [{ capability: "drift.repair", resourceId: "firewall/a", at: minutesAgo(25), codes: ["cooldown_active"] }],
  };
  it("is deterministic, ordered and built from stored facts", () => {
    const a = buildPostmortem(P, input);
    expect(buildPostmortem(P, input)).toEqual(a);
    expect(a.rootCause).toMatchObject({ status: "identified", code: "db_unreachable_security_group", evidence: ["e1", "e2"] });
    expect(a.timeline.map((t) => t.kind)).toEqual(["opened", "investigated", "attempt_failed", "proposal_blocked", "escalated", "resolved"]);
    expect(a.remediation).toEqual({ attempts: 1, succeeded: 0, failed: 1, blocked: 1 });
    expect(a.escalation).toMatchObject({ escalated: true, reasons: ["attempts_exhausted"] });
    expect(a.followUps.length).toBeGreaterThanOrEqual(3);
  });
  it("says so when the cause was not established", () => {
    const a = buildPostmortem(P, { ...input, investigations: [{ id: "i", startedAt: minutesAgo(30), hypotheses: [{ code: "unknown", title: "?", confidence: 0.2, supportingEvidence: [] }] }] });
    expect(a.rootCause.status).toBe("undetermined");
    expect(a.followUps[0]).toMatch(/not established/);
  });
});

describe("investigation engine enforces the gate", () => {
  const env = { workspaceId: WORKSPACE, projectId: PROJECT, environmentId: ENV };
  const portsWith = (gate?: ReturnType<typeof makePorts>["remediationGate"]) => ({ ...makePorts(removeDbIngress(healthyWorld())), ...(gate ? { remediationGate: gate } : {}) });

  it("without a gate the proposals are unchanged", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env }, portsWith());
    expect(inv.hypotheses[0].remediations.length).toBeGreaterThan(0);
    expect(inv.hypotheses[0].suppressedRemediations).toBeUndefined();
  });
  it("a refusing gate removes every proposal and records the codes", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env }, portsWith(() => ({ allowed: false, codes: ["maintenance_window"], messages: ["held"], escalate: false })));
    const top = inv.hypotheses[0];
    expect(top.remediations).toEqual([]);
    expect(top.suppressedRemediations?.[0]).toMatchObject({ codes: ["maintenance_window"], escalate: false });
  });
  it("a throwing gate fails closed", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env }, portsWith(() => { throw new Error("db down"); }));
    expect(inv.hypotheses[0].remediations).toEqual([]);
    expect(inv.hypotheses[0].suppressedRemediations?.[0].codes).toEqual(["gate_unavailable"]);
  });
  it("a gate that never answers fails closed within the probe timeout", async () => {
    const ports = portsWith(() => new Promise(() => {}));
    const inv = await investigate({ graph: buildGraph(), environment: env }, ports, { probeTimeoutMs: 50 });
    expect(inv.hypotheses[0].suppressedRemediations?.[0].codes).toEqual(["gate_unavailable"]);
  });
  it("passes blast radius, risk, confidence and the autoscaler flag to the gate", async () => {
    const seen: GateRequest[] = [];
    await investigate({ graph: buildGraph(), environment: env }, portsWith((r) => { seen.push(r); return { allowed: true, codes: [], messages: [], escalate: false }; }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ capability: "drift.repair", blastRadius: "low", autoscalerManaged: false });
    expect(seen[0].confidence).toBeGreaterThan(0.3);
  });
  it("blocks a scale proposal against an autoscaled service", async () => {
    const w = healthyWorld();
    w.metrics[ADDR.web] = [series("cpu.utilization", [95, 96, 97], "percent", ADDR.web), series("memory.utilization", [91, 92, 93], "percent", ADDR.web)];
    const graph = buildGraph();
    graph.nodes.push(scaler({ target: ADDR.web }));
    const gate = (r: GateRequest) => decideRemediation(P, snap({ incident: null, signalActive: null }), r);
    const inv = await investigate({ graph, environment: env }, { ...makePorts(w), remediationGate: gate });
    const offered = inv.hypotheses.flatMap((h) => h.remediations);
    expect(offered.some((o) => o.request.capability === "service.scale")).toBe(false);
    expect(inv.hypotheses.flatMap((h) => h.suppressedRemediations ?? []).some((s) => s.codes.includes("autoscaler_conflict"))).toBe(true);
    expect(inv.escalation?.reasons).toContain("remediation_requires_human");
  });
  it("an inconclusive diagnosis escalates and proposes nothing", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env, symptom: "the site feels slow" }, makePorts(healthyWorld()));
    expect(inv.hypotheses.map((h) => h.code)).toEqual(["unknown"]);
    expect(inv.hypotheses[0].remediations).toEqual([]);
    expect(inv.escalation).toEqual({ required: true, reasons: ["inconclusive_diagnosis"] });
  });
  it("a healthy environment does not escalate", async () => {
    const inv = await investigate({ graph: buildGraph(), environment: env }, makePorts(healthyWorld()));
    expect(inv.escalation).toBeUndefined();
  });
});

describe("telemetry trust gate", () => {
  it("only fresh data can open; only fresh or empty data can clear; the rest proves nothing", () => {
    expect(trustedObservation("bad", "fresh")).toBe("bad");
    for (const state of ["stale", "empty", "unknown", "inaccessible"] as const) expect(trustedObservation("bad", state)).toBe("unknown");
    expect(trustedObservation("good", "fresh")).toBe("good");
    expect(trustedObservation("good", "empty")).toBe("good");
    for (const state of ["stale", "unknown", "inaccessible"] as const) expect(trustedObservation("good", state)).toBe("unknown");
    expect(trustedObservation("unknown", "fresh")).toBe("unknown");
    expect(trustedObservation("bad", undefined)).toBe("bad");
  });
});
