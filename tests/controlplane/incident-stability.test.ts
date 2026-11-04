/**
 * PROD-OBS-03 durable incident stability on production SQL (PGlite always;
 * real Postgres when ZENITH_TEST_PLATFORM_PG_URL is set): fingerprint dedup,
 * hysteresis, auto-resolve with postmortem, the remediation reservation gate
 * under concurrency, windows, escalation and tenant isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db";
import * as events from "@/lib/controlplane/db/repos/events";
import * as incidents from "@/lib/controlplane/db/repos/incidents";
import * as stab from "@/lib/controlplane/db/repos/incident-stability";
import { DEFAULT_STABILITY_POLICY, incidentFingerprint, resolveStabilityPolicy, type GateRequest } from "@/lib/incidents/stability";
import type { Investigation } from "@/lib/incidents/types";
import { LANES, expectCode, newWorkspace, openLane, seedApprovedOperation, uid } from "./_support/harness";

const T0 = new Date("2026-10-05T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

it("ships the stability migration after the cleanup writer migrations", () => {
  const m = PLATFORM_MIGRATIONS.find((x) => x.name === "incident_stability");
  expect(m).toBeDefined();
  for (const t of ["incident_signal_state", "incident_remediation_attempts", "incident_maintenance_windows", "incident_postmortems"]) expect(m!.sql).toContain(`platform.${t}`);
  expect(m!.sql).toContain("incidents_open_fingerprint");
});

describe.each(LANES)("incident stability [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let ws: string;
  const env = "env_prod";
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  beforeEach(() => { ws = newWorkspace(); });

  const fp = (subject = "service/web") => incidentFingerprint({ workspaceId: ws, environmentId: env, problem: "service_down", subject });
  const observe = (fingerprint: string, observation: "bad" | "good" | "unknown", minute = 0, extra: Partial<stab.ObserveSignalInput> = {}) =>
    stab.observeSignal(ctx.db, { workspaceId: ws, environmentId: env, fingerprint, observation, now: at(minute), incident: { title: "web is down", severity: "high", source: "probe" }, ...extra });
  const open = async (fingerprint = fp()) => {
    let r!: stab.ObserveSignalResult;
    for (let i = 0; i < 3; i++) r = await observe(fingerprint, "bad", i);
    return r.incident!;
  };
  const request = (over: Partial<GateRequest> = {}): GateRequest => ({ capability: "drift.repair", resourceId: "firewall/a", blastRadius: "low", risk: "high", confidence: 0.9, autoscalerManaged: false, ...over });
  const reserve = (incidentId: string, minute: number, over: Partial<GateRequest> = {}, extra: Partial<stab.RemediationGateInput> = {}) =>
    stab.reserveRemediation(ctx.db, { workspaceId: ws, environmentId: env, incidentId, request: request(over), now: at(minute), ...extra });
  const investigation = (incidentId: string, hypotheses: Investigation["hypotheses"]): Investigation => ({
    id: uid("inv"), incidentId, workspaceId: ws, environmentId: env, startedAt: at(1).toISOString(), finishedAt: at(1).toISOString(), path: [], evidence: [], hypotheses, recentChanges: [], simulated: false,
  });
  const hyp = (code: string, confidence: number): Investigation["hypotheses"][number] => ({ id: `hyp:${code}`, code, title: code, confidence, category: code === "unknown" ? "unknown" : "runtime", supportingEvidence: ["ev1"], contradictingEvidence: [], remediations: [] });

  describe("hysteresis and dedup", () => {
    it("opens only after three consecutive bad observations", async () => {
      const f = fp();
      expect((await observe(f, "bad", 0)).incident).toBeUndefined();
      expect((await observe(f, "bad", 1)).incident).toBeUndefined();
      expect((await incidents.listIncidents(ctx.db, ws)).length).toBe(0);
      const third = await observe(f, "bad", 2);
      expect(third.transition).toBe("activated");
      expect(third.incidentCreated).toBe(true);
      expect(third.incident?.fingerprint).toBe(f);
    });
    it("a flapping signal opens nothing", async () => {
      const f = fp();
      for (let i = 0; i < 20; i++) await observe(f, i % 2 ? "good" : "bad", i);
      expect(await incidents.listIncidents(ctx.db, ws)).toEqual([]);
    });
    it("unknown observations never open or clear", async () => {
      const f = fp();
      for (let i = 0; i < 10; i++) await observe(f, "unknown", i);
      expect(await incidents.listIncidents(ctx.db, ws)).toEqual([]);
      const inc = await open(f);
      for (let i = 0; i < 20; i++) await observe(f, "unknown", 10 + i);
      expect((await stab.getStabilityIncident(ctx.db, ws, inc.id))?.status).toBe("open");
    });
    it("repeats attach to the same open incident, concurrent observers included", async () => {
      const f = fp();
      const first = await open(f);
      await Promise.all(Array.from({ length: 8 }, (_, i) => observe(f, "bad", 3 + i)));
      const all = await incidents.listIncidents(ctx.db, ws);
      expect(all.map((i) => i.id)).toEqual([first.id]);
      expect((await stab.getStabilityIncident(ctx.db, ws, first.id))?.occurrenceCount).toBe(9);
    });
    it("two quiet observers racing to activate still open exactly one incident", async () => {
      const f = fp();
      await observe(f, "bad", 0);
      await observe(f, "bad", 1);
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => observe(f, "bad", 2 + i)));
      expect(results.filter((r) => r.incidentCreated)).toHaveLength(1);
      expect(await incidents.listIncidents(ctx.db, ws)).toHaveLength(1);
    });
    it("different subjects and workspaces do not dedup", async () => {
      await open(fp("service/web"));
      await open(fp("service/api"));
      expect(await incidents.listIncidents(ctx.db, ws)).toHaveLength(2);
      expect(await incidents.listIncidents(ctx.db, newWorkspace())).toHaveLength(0);
    });
    it("clears after five good observations, resolves, records a postmortem and a recurrence opens a new incident", async () => {
      const f = fp();
      const inc = await open(f);
      let last!: stab.ObserveSignalResult;
      for (let i = 0; i < 5; i++) last = await observe(f, "good", 10 + i);
      expect(last.transition).toBe("cleared");
      expect(last.resolved?.incident.status).toBe("resolved");
      const pm = await stab.getPostmortem(ctx.db, ws, inc.id);
      expect(pm?.document.incidentId).toBe(inc.id);
      expect(pm?.document.rootCause.status).toBe("undetermined");
      expect(pm?.document.timeline.map((t) => t.kind)).toEqual(["opened", "resolved"]);
      const again = await open(f);
      expect(again.id).not.toBe(inc.id);
      const types = (await events.list(ctx.db, ws)).map((e) => e.type);
      expect(types.filter((t) => t === "incident.opened")).toHaveLength(2);
      expect(types).toContain("incident.resolved");
      expect(types).toContain("incident.postmortem_recorded");
    });
    it("rejects a malformed fingerprint", async () => {
      await expectCode(observe("not-a-digest", "bad"), "invalid_input");
    });
  });

  describe("remediation gate", () => {
    it("reserves a clean first attempt and replays the same proposal without counting it twice", async () => {
      const inc = await open();
      const a = await reserve(inc.id, 5);
      expect(a.decision.allowed).toBe(true);
      expect(a.attempt?.status).toBe("reserved");
      const again = await reserve(inc.id, 5);
      expect(again.replayed).toBe(true);
      expect(again.attempt?.id).toBe(a.attempt?.id);
      expect((await stab.listRemediationAttempts(ctx.db, ws, inc.id)).length).toBe(1);
    });
    it("requires a tracked incident to reserve, and treats an unknown incident as inactive", async () => {
      await expectCode(stab.reserveRemediation(ctx.db, { workspaceId: ws, environmentId: env, request: request(), now: at(1) }), "invalid_input");
      const d = await stab.checkRemediation(ctx.db, { workspaceId: ws, environmentId: env, incidentId: "inc_nope", request: request(), now: at(1) });
      expect(d.allowed).toBe(false);
      expect(d.codes).toContain("incident_inactive");
    });
    it("blocks a resolved incident", async () => {
      const f = fp();
      const inc = await open(f);
      for (let i = 0; i < 5; i++) await observe(f, "good", 3 + i);
      // resolved: the old incident accepts nothing
      const d = await stab.checkRemediation(ctx.db, { workspaceId: ws, environmentId: env, incidentId: inc.id, request: request(), now: at(20) });
      expect(d.codes).toContain("incident_inactive");
    });
    it("holds the cooldown after a settled attempt, with backoff after a failure", async () => {
      const inc = await open();
      const a = await reserve(inc.id, 5);
      await stab.settleAttempt(ctx.db, { workspaceId: ws, attemptId: a.attempt!.id, outcome: "failed", operationId: "op_1", now: at(6) });
      const soon = await reserve(inc.id, 10, { resourceId: "firewall/b" });
      expect(soon.decision.codes).toContain("cooldown_active");
      expect(soon.decision.retryAfter).toBe(at(15).toISOString());
      expect((await reserve(inc.id, 14, { resourceId: "firewall/b" })).decision.codes).toContain("cooldown_active");
      expect((await reserve(inc.id, 16, { resourceId: "firewall/b" })).decision.allowed).toBe(true);
    });
    it("stops after the per-incident attempt limit and escalates", async () => {
      const inc = await open();
      const relaxed = resolveStabilityPolicy({ remediation: { baseCooldownMs: 10_000, maxInflightPerEnvironment: 5 } });
      for (let i = 0; i < 3; i++) {
        const r = await reserve(inc.id, 5 + i * 60, { resourceId: `firewall/r${i}` }, { policy: relaxed });
        expect(r.decision.allowed).toBe(true);
        await stab.settleAttempt(ctx.db, { workspaceId: ws, attemptId: r.attempt!.id, outcome: "failed", now: at(6 + i * 60) });
      }
      const blocked = await reserve(inc.id, 300, { resourceId: "firewall/r9" }, { policy: relaxed });
      expect(blocked.decision.codes).toContain("attempts_exhausted");
      const after = await stab.getStabilityIncident(ctx.db, ws, inc.id);
      expect(after?.escalatedAt).toBeDefined();
      expect(after?.escalationReasons).toContain("attempts_exhausted");
      // an escalated incident proposes nothing further
      expect((await reserve(inc.id, 301, { resourceId: "firewall/r10" }, { policy: relaxed })).decision.codes).toContain("escalated_to_human");
      expect((await events.list(ctx.db, ws, { type: "incident.escalated" })).length).toBe(1);
    });
    it("a blast radius above the cap is blocked, recorded and escalated", async () => {
      const inc = await open();
      const r = await reserve(inc.id, 5, { blastRadius: "high" });
      expect(r.decision.codes).toEqual(["blast_radius_exceeded"]);
      expect(r.attempt).toBeUndefined();
      const rows = await stab.listRemediationAttempts(ctx.db, ws, inc.id);
      expect(rows.map((a) => a.status as string)).toEqual(["blocked"]);
      expect(rows[0].blockCodes).toEqual(["blast_radius_exceeded"]);
      expect((await stab.getStabilityIncident(ctx.db, ws, inc.id))?.escalationReasons).toContain("remediation_requires_human");
    });
    it("blocks scaling against an autoscaler", async () => {
      const inc = await open();
      const r = await reserve(inc.id, 5, { capability: "service.scale", autoscalerManaged: true });
      expect(r.decision.codes).toEqual(["autoscaler_conflict"]);
    });
    it("a repair storm admits exactly one in-flight attempt per environment", async () => {
      const inc = await open();
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => reserve(inc.id, 5, { resourceId: `firewall/s${i}` })));
      expect(results.filter((r) => r.decision.allowed)).toHaveLength(1);
      const rows = await stab.listRemediationAttempts(ctx.db, ws, inc.id);
      expect(rows.filter((a) => a.status === "reserved")).toHaveLength(1);
    });
    it("a storm across incidents is capped per environment window and per resource spread", async () => {
      const relaxed = resolveStabilityPolicy({ remediation: { maxInflightPerEnvironment: 5, baseCooldownMs: 10_000 } });
      const incs = [];
      for (let i = 0; i < 6; i++) incs.push(await open(fp(`service/s${i}`)));
      const results = await Promise.all(incs.map((inc, i) => reserve(inc.id, 5, { resourceId: `firewall/x${i}` }, { policy: relaxed })));
      expect(results.filter((r) => r.decision.allowed)).toHaveLength(relaxed.remediation.maxDistinctResourcesPerWindow);
      expect(results.filter((r) => !r.decision.allowed).every((r) => r.decision.codes.includes("resource_spread_limit"))).toBe(true);
    });
    it("a stale reservation stops counting as in flight", async () => {
      const inc = await open();
      await reserve(inc.id, 5);
      expect((await reserve(inc.id, 10, { resourceId: "firewall/b" })).decision.codes).toContain("inflight_limit");
      expect((await reserve(inc.id, 25, { resourceId: "firewall/b" })).decision.allowed).toBe(true);
    });
    it("settling is conditional and tenant scoped", async () => {
      const inc = await open();
      const a = await reserve(inc.id, 5);
      expect(await stab.settleAttempt(ctx.db, { workspaceId: newWorkspace(), attemptId: a.attempt!.id, outcome: "succeeded" })).toBeNull();
      expect((await stab.settleAttempt(ctx.db, { workspaceId: ws, attemptId: a.attempt!.id, outcome: "succeeded", operationId: "op_9", now: at(6) }))?.status).toBe("succeeded");
      expect(await stab.settleAttempt(ctx.db, { workspaceId: ws, attemptId: a.attempt!.id, outcome: "failed" })).toBeNull();
    });
    it("checkRemediation is read-only", async () => {
      const inc = await open();
      await stab.checkRemediation(ctx.db, { workspaceId: ws, environmentId: env, incidentId: inc.id, request: request(), now: at(5) });
      expect(await stab.listRemediationAttempts(ctx.db, ws, inc.id)).toEqual([]);
    });
  });

  describe("maintenance windows", () => {
    it("create, list active, block remediation, and cancel", async () => {
      const inc = await open();
      const w = await stab.createMaintenanceWindow(ctx.db, { workspaceId: ws, environmentId: env, startsAt: at(0), endsAt: at(60), reason: "planned database upgrade", createdBy: "user_1" });
      expect((await stab.listMaintenanceWindows(ctx.db, ws, { activeAt: at(10) })).map((x) => x.id)).toEqual([w.id]);
      expect(await stab.listMaintenanceWindows(ctx.db, ws, { activeAt: at(90) })).toEqual([]);
      const blocked = await reserve(inc.id, 10);
      expect(blocked.decision.codes).toEqual(["maintenance_window"]);
      expect(blocked.decision.retryAfter).toBe(at(60).toISOString());
      expect((await reserve(inc.id, 70)).decision.allowed).toBe(true);
      expect((await stab.cancelMaintenanceWindow(ctx.db, { workspaceId: ws, id: w.id, now: at(11) }))?.cancelledAt).toBeDefined();
      expect(await stab.listMaintenanceWindows(ctx.db, ws, { activeAt: at(12) })).toEqual([]);
    });
    it("a window for another environment or workspace does not apply", async () => {
      const inc = await open();
      await stab.createMaintenanceWindow(ctx.db, { workspaceId: ws, environmentId: "env_other", startsAt: at(0), endsAt: at(60), reason: "other env", createdBy: "u" });
      await stab.createMaintenanceWindow(ctx.db, { workspaceId: newWorkspace(), startsAt: at(0), endsAt: at(60), reason: "other tenant", createdBy: "u" });
      expect((await reserve(inc.id, 10)).decision.allowed).toBe(true);
    });
    it("refuses a backwards or over-long window", async () => {
      await expectCode(stab.createMaintenanceWindow(ctx.db, { workspaceId: ws, startsAt: at(10), endsAt: at(5), reason: "x", createdBy: "u" }), "invalid_input");
      await expectCode(stab.createMaintenanceWindow(ctx.db, { workspaceId: ws, startsAt: at(0), endsAt: at(60 * 24 * 8), reason: "x", createdBy: "u" }), "value_out_of_range");
    });
  });

  describe("escalation", () => {
    it("an inconclusive investigation escalates the incident once", async () => {
      const inc = await open();
      const r = await stab.recordInvestigation(ctx.db, { investigation: investigation(inc.id, [hyp("unknown", 0.2)]), now: at(5) });
      expect(r.escalation).toMatchObject({ escalate: true, reasons: ["inconclusive_diagnosis"] });
      expect((await stab.getStabilityIncident(ctx.db, ws, inc.id))?.escalationReasons).toEqual(["inconclusive_diagnosis"]);
      await stab.recordInvestigation(ctx.db, { investigation: investigation(inc.id, [hyp("unknown", 0.2)]), now: at(6) });
      expect((await events.list(ctx.db, ws, { type: "incident.escalated" })).length).toBe(1);
    });
    it("a confident investigation does not escalate", async () => {
      const inc = await open();
      const r = await stab.recordInvestigation(ctx.db, { investigation: investigation(inc.id, [hyp("bad_deploy", 0.9)]), now: at(5) });
      expect(r.escalation?.escalate).toBe(false);
      expect((await stab.getStabilityIncident(ctx.db, ws, inc.id))?.escalatedAt).toBeUndefined();
    });
    it("an incident open too long escalates; a resolved one never does", async () => {
      const inc = await open();
      const late = await stab.evaluateIncidentEscalation(ctx.db, { workspaceId: ws, incidentId: inc.id, now: at(3 * 60) });
      expect(late.reasons).toContain("unresolved_too_long");
      const f = fp("service/other");
      const other = await open(f);
      for (let i = 0; i < 5; i++) await observe(f, "good", 20 + i);
      expect((await stab.evaluateIncidentEscalation(ctx.db, { workspaceId: ws, incidentId: other.id, now: at(600) })).escalate).toBe(false);
    });
    it("refuses an investigation for another tenant's incident", async () => {
      const inc = await open();
      const foreign = { ...investigation(inc.id, [hyp("unknown", 0.2)]), workspaceId: newWorkspace() };
      await expectCode(stab.recordInvestigation(ctx.db, { investigation: foreign }), "not_found");
    });
  });

  describe("postmortem", () => {
    it("is refused for an unresolved incident, tenant scoped, and immutable once recorded", async () => {
      const f = fp();
      const inc = await open(f);
      await expectCode(stab.recordPostmortem(ctx.db, { workspaceId: ws, incidentId: inc.id }), "invalid_state");
      await stab.recordInvestigation(ctx.db, { investigation: investigation(inc.id, [hyp("bad_deploy", 0.9)]), now: at(4) });
      const a = await reserve(inc.id, 5);
      await stab.settleAttempt(ctx.db, { workspaceId: ws, attemptId: a.attempt!.id, outcome: "succeeded", operationId: "op_7", now: at(6) });
      for (let i = 0; i < 5; i++) await observe(f, "good", 30 + i);
      const pm = await stab.getPostmortem(ctx.db, ws, inc.id);
      expect(pm?.document.rootCause).toMatchObject({ status: "identified", code: "bad_deploy" });
      expect(pm?.document.remediation).toMatchObject({ attempts: 1, succeeded: 1 });
      const again = await stab.recordPostmortem(ctx.db, { workspaceId: ws, incidentId: inc.id, now: at(999) });
      expect(again.id).toBe(pm?.id);
      expect(again.documentDigest).toBe(pm?.documentDigest);
      expect(await stab.getPostmortem(ctx.db, newWorkspace(), inc.id)).toBeNull();
      await expectCode(stab.recordPostmortem(ctx.db, { workspaceId: newWorkspace(), incidentId: inc.id }), "not_found");
    });
  });

  describe("telemetry envelope trust", () => {
    const envelope = (state: "fresh" | "stale" | "empty" | "unknown" | "inaccessible") => ({ state, signal: "health" as const, observedAt: at(0).toISOString(), partial: false });
    it("stale, unknown and inaccessible telemetry cannot open an incident", async () => {
      const f = fp();
      for (const state of ["stale", "unknown", "inaccessible"] as const) for (let i = 0; i < 5; i++) {
        const r = await observe(f, "bad", i, { telemetry: envelope(state) });
        expect(r.appliedObservation).toBe("unknown");
      }
      expect(await incidents.listIncidents(ctx.db, ws)).toEqual([]);
    });
    it("fresh telemetry opens, records its provenance, and stale telemetry cannot clear", async () => {
      const f = fp();
      let r!: stab.ObserveSignalResult;
      for (let i = 0; i < 3; i++) r = await observe(f, "bad", i, { telemetry: envelope("fresh") });
      expect(r.incident?.document.telemetry).toMatchObject({ state: "fresh", signal: "health" });
      for (let i = 0; i < 10; i++) await observe(f, "good", 10 + i, { telemetry: envelope("stale") });
      expect((await stab.getStabilityIncident(ctx.db, ws, r.incident!.id))?.status).toBe("open");
      let last!: stab.ObserveSignalResult;
      for (let i = 0; i < 5; i++) last = await observe(f, "good", 30 + i, { telemetry: envelope("empty") });
      expect(last.transition).toBe("cleared");
    });
  });

  describe("operation binding, outcome sync and the escalation queue", () => {
    it("binds a reservation to an operation and settles it from the operation outcome", async () => {
      const inc = await open();
      const a = await reserve(inc.id, 5);
      const { operation } = await seedApprovedOperation(ctx.db, ws);
      const bound = await stab.bindAttemptToOperation(ctx.db, { workspaceId: ws, attemptId: a.attempt!.id, operationId: operation.id });
      expect(bound?.operationId).toBe(operation.id);
      expect(await stab.bindAttemptToOperation(ctx.db, { workspaceId: ws, attemptId: a.attempt!.id, operationId: operation.id })).toBeNull();
      expect(await stab.bindAttemptToOperation(ctx.db, { workspaceId: newWorkspace(), attemptId: a.attempt!.id, operationId: operation.id })).toBeNull();
      expect(await stab.syncAttemptOutcomes(ctx.db, { workspaceId: ws, now: at(6) })).toBe(0);
      await ctx.db.query("update platform.operations set status = 'failed' where workspace_id = $1 and id = $2", [ws, operation.id]);
      expect(await stab.syncAttemptOutcomes(ctx.db, { workspaceId: ws, now: at(7) })).toBe(1);
      expect((await stab.listRemediationAttempts(ctx.db, ws, inc.id))[0].status).toBe("failed");
    });
    it("a binding to a foreign or unknown operation is refused", async () => {
      const inc = await open();
      const a = await reserve(inc.id, 5);
      expect(await stab.bindAttemptToOperation(ctx.db, { workspaceId: ws, attemptId: a.attempt!.id, operationId: "op_nope" })).toBeNull();
    });
    it("lists escalations with an explicit unacknowledged state until a person acknowledges", async () => {
      const inc = await open();
      expect(await stab.listEscalations(ctx.db, ws)).toEqual([]);
      await stab.escalateIncident(ctx.db, { workspaceId: ws, incidentId: inc.id, reasons: ["inconclusive_diagnosis"], now: at(5) });
      const listed = await stab.listEscalations(ctx.db, ws, { environmentId: env });
      expect(listed.map((i) => [i.id, i.escalationState])).toEqual([[inc.id, "unacknowledged"]]);
      expect((await stab.listEscalations(ctx.db, ws, { unacknowledgedOnly: true })).length).toBe(1);
      expect(await stab.acknowledgeEscalation(ctx.db, { workspaceId: newWorkspace(), incidentId: inc.id, by: "user_x" })).toBeNull();
      const ack = await stab.acknowledgeEscalation(ctx.db, { workspaceId: ws, incidentId: inc.id, by: "user_1", now: at(6) });
      expect(ack?.escalationState).toBe("acknowledged");
      expect((await stab.acknowledgeEscalation(ctx.db, { workspaceId: ws, incidentId: inc.id, by: "user_2", now: at(7) }))?.escalationAcknowledgedBy).toBe("user_1");
      expect(await stab.listEscalations(ctx.db, ws, { unacknowledgedOnly: true })).toEqual([]);
      expect((await stab.listEscalations(ctx.db, ws)).map((i) => i.escalationState)).toEqual(["acknowledged"]);
    });
    it("the remediation start path is gated on an admitted, operation-bound attempt", async () => {
      const src = (await import("node:fs")).readFileSync("src/lib/controlplane/db/repos/workflow-start-intents.ts", "utf8");
      expect(src).toContain("requireRemediationAdmission");
      expect(src.match(/await requireRemediationAdmission\(tx,request,op\);/g)).toHaveLength(2);
      expect(src).toContain("platform.incident_remediation_attempts where workspace_id=$1 and incident_id=$2 and operation_id=$3");
    });
  });

  it("defaults are the documented ones", () => {
    expect(DEFAULT_STABILITY_POLICY.hysteresis).toEqual({ openAfter: 3, clearAfter: 5 });
  });
});
