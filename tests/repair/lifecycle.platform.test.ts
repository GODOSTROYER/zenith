/**
 * PROD-OBS-01 post-remediation verification against the real stability
 * adapter on production SQL (PGlite always; real PostgreSQL when
 * ZENITH_TEST_PLATFORM_PG_URL is set): a settled repair is re-observed and the
 * incident closes, escalates or stays unclaimed. Provider reads are not
 * involved: the observations are the controller's own verdict records.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as stab from "@/lib/controlplane/db/repos/incident-stability";
import { createPlatformStability } from "@/lib/reconcile/platform/stability";
import type { ReconcileEnvironment, StabilityFindingObservation } from "@/lib/reconcile";
import { LANES, newWorkspace, openLane, seedApprovedOperation } from "../controlplane/_support/harness";

const T0 = new Date("2026-10-05T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ADDRESS = "log_group/web";

describe.each(LANES)("repair verification [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let ws: string;
  const environmentId = "env_prod";
  const env = (): ReconcileEnvironment => ({ workspaceId: ws, projectId: "proj-1", environmentId, class: "production", provider: "aws", region: "us-east-1" });
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  beforeEach(() => { ws = newWorkspace(); });

  const bad: StabilityFindingObservation[] = [{ address: ADDRESS, class: "missing", severity: "low", observation: "bad" }];
  const good: StabilityFindingObservation[] = [{ address: ADDRESS, observation: "good" }];
  const unknown: StabilityFindingObservation[] = [{ address: ADDRESS, observation: "unknown" }];

  /** Confirm the incident, admit one repair, bind it to a real operation and give that operation a terminal status. */
  async function repaired(status: "succeeded" | "failed") {
    const stability = createPlatformStability(ctx.db);
    let ref: { incidentId: string } | undefined;
    for (let i = 0; i < 3; i++) ref = (await stability.observe(env(), bad, at(i))).get(`${ADDRESS}|missing`);
    const admission = await stability.admit(env(), { incidentId: ref!.incidentId, request: { capability: "drift.repair", scope: { workspaceId: ws, environmentId }, input: {}, reason: "r", idempotencyKey: "k1" }, address: ADDRESS }, at(4));
    expect(admission.allowed).toBe(true);
    const { operation } = await seedApprovedOperation(ctx.db, ws);
    await stability.attach(env(), admission.attemptId!, operation.id);
    await ctx.db.query("update platform.operations set status = $3 where workspace_id = $1 and id = $2", [ws, operation.id, status]);
    return { stability, incidentId: ref!.incidentId, operationId: operation.id, attemptId: admission.attemptId! };
  }

  it("an operation still in flight is not awaiting verification", async () => {
    const stability = createPlatformStability(ctx.db);
    let ref: { incidentId: string } | undefined;
    for (let i = 0; i < 3; i++) ref = (await stability.observe(env(), bad, at(i))).get(`${ADDRESS}|missing`);
    await stability.admit(env(), { incidentId: ref!.incidentId, request: { capability: "drift.repair", scope: { workspaceId: ws, environmentId }, input: {}, reason: "r", idempotencyKey: "k1" }, address: ADDRESS }, at(4));
    expect(await stability.awaitingVerification!(env(), at(5))).toEqual([]);
  });

  it("a succeeded repair whose drift persists escalates for a person (verification_failed)", async () => {
    const r = await repaired("succeeded");
    const awaiting = await r.stability.awaitingVerification!(env(), at(10));
    expect(awaiting).toEqual([expect.objectContaining({ incidentId: r.incidentId, operationId: r.operationId, address: ADDRESS, attemptStatus: "succeeded" })]);
    await r.stability.observe(env(), bad, at(11));
    const [v] = await r.stability.verifyRepairs!(env(), awaiting, bad, at(11), { simulated: false });
    expect(v).toMatchObject({ outcome: "still_present", escalated: true, escalationReasons: ["verification_failed"] });
    const incident = await stab.getStabilityIncident(ctx.db, ws, r.incidentId);
    expect(incident).toMatchObject({ status: expect.not.stringMatching(/resolved/), escalationState: "unacknowledged" });
    // Idempotent: a second verification pass records nothing new.
    const again = await r.stability.verifyRepairs!(env(), awaiting, bad, at(12), { simulated: false });
    expect(again[0].escalationReasons).toEqual(["verification_failed"]);
  });

  it("a repair whose drift clears closes the incident by hysteresis and never escalates", async () => {
    const r = await repaired("succeeded");
    let outcome: Awaited<ReturnType<NonNullable<typeof r.stability.verifyRepairs>>>[number] | undefined;
    for (let pass = 0; pass < 8 && outcome?.incident !== "closed"; pass++) {
      const now = at(10 + pass);
      const awaiting = await r.stability.awaitingVerification!(env(), now);
      if (awaiting.length === 0) break;
      await r.stability.observe(env(), good, now);
      [outcome] = await r.stability.verifyRepairs!(env(), awaiting, good, now, { simulated: false });
      expect(outcome).toMatchObject({ outcome: "cleared", escalated: false });
    }
    expect(outcome).toMatchObject({ outcome: "cleared", incident: "closed" });
    expect((await stab.getStabilityIncident(ctx.db, ws, r.incidentId))?.status).toBe("resolved");
    expect(await r.stability.awaitingVerification!(env(), at(30))).toEqual([]);
  });

  it("an unreadable or simulated re-observation claims nothing and does not clear", async () => {
    const r = await repaired("failed");
    const awaiting = await r.stability.awaitingVerification!(env(), at(10));
    expect(awaiting).toHaveLength(1);
    const [unread] = await r.stability.verifyRepairs!(env(), awaiting, unknown, at(10), { simulated: false });
    expect(unread).toMatchObject({ outcome: "unverifiable", attemptStatus: "failed" });
    expect(unread.incident).toBeUndefined();
    const [simulated] = await r.stability.verifyRepairs!(env(), awaiting, good, at(11), { simulated: true });
    expect(simulated).toMatchObject({ outcome: "unverifiable" });
    expect((await stab.getStabilityIncident(ctx.db, ws, r.incidentId))?.status).not.toBe("resolved");
  });

  it("verification is tenant scoped", async () => {
    const r = await repaired("succeeded");
    const other = { ...env(), workspaceId: newWorkspace() };
    expect(await r.stability.awaitingVerification!(other, at(10))).toEqual([]);
  });
});
