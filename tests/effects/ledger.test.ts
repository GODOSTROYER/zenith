/**
 * PROD-DUR-07 / PROD-DUR-08: the external-effect ledger on the real control store.
 * Runs on PGlite and, when ZENITH_TEST_PLATFORM_PG_URL is set, on real PostgreSQL.
 *
 * Covers: record-before-dispatch and dedup, stale fences, delayed responses after lease loss or tombstone,
 * lease renewal, provider rejection vs unknown outcome, readback, evidence-bound resolution, the database
 * trigger as the authority (bypass attempts), tenant scoping and the stale-pending sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as store from "@/lib/controlplane/db/repos/external-effects";
import * as leases from "@/lib/controlplane/db/repos/leases";
import { LeaseLostError } from "@/lib/controlplane/types";
import { createEffectLedger, EffectTombstonedError, EffectUnresolvedError } from "@/lib/effects/ledger";
import { projectedState, resolutionBinding, resolutionOptions } from "@/lib/effects/binding";
import { LANES, openLane, newWorkspace } from "../controlplane/_support/harness";
import { begin, insertAged, lease, readback, receipt, seed, HEX } from "./_support";

describe.each(LANES)("external effect ledger ($name)", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); });
  afterAll(async () => { await ctx.close(); });

  describe("record before dispatch, dedup by durable identity", () => {
    it("creates one pending effect per (family, dedupKey) and returns it to every later caller", async () => {
      const s = await seed(ctx.db);
      const first = await begin(ctx.db, s, { dedupKey: "build:one" });
      expect(first.created).toBe(true);
      expect(first.effect).toMatchObject({ state: "pending", family: "build_launch", idempotencySupported: true, idempotencyToken: "zn-test-token", version: 1 });
      const again = await begin(ctx.db, s, { dedupKey: "build:one" });
      expect(again.created).toBe(false);
      expect(again.effect.effectId).toBe(first.effect.effectId);
      const events = await store.listEvents(ctx.db, s.workspaceId, first.effect.effectId);
      expect(events.map((e) => e.kind)).toEqual(["begin"]);
    });

    it("refuses to reuse an identity for a different request", async () => {
      const s = await seed(ctx.db);
      await begin(ctx.db, s, { dedupKey: "build:two", requestDigest: HEX("a") });
      await expect(begin(ctx.db, s, { dedupKey: "build:two", requestDigest: HEX("c") })).rejects.toMatchObject({ code: "conflict" });
    });

    it("records the fence epoch, and a stale fence cannot create a NEW effect but an existing one is still returned", async () => {
      const s = await seed(ctx.db);
      const l = await lease(ctx.db, s);
      const made = await begin(ctx.db, s, { dedupKey: "build:fenced", fence: { scope: l.scope, token: l.fenceToken } });
      expect(made.effect).toMatchObject({ fenceScope: l.scope, fenceEpoch: l.fenceToken });
      await leases.release(ctx.db, l);
      await expect(begin(ctx.db, s, { dedupKey: "build:fresh", fence: { scope: l.scope, token: l.fenceToken } })).rejects.toBeInstanceOf(LeaseLostError);
      const found = await begin(ctx.db, s, { dedupKey: "build:fenced", fence: { scope: l.scope, token: l.fenceToken } });
      expect(found).toMatchObject({ created: false });
      expect(found.effect.effectId).toBe(made.effect.effectId);
    });
  });

  describe("dispatchOnce: at most one provider call per identity", () => {
    const input = (s: Awaited<ReturnType<typeof seed>>, key: string) => ({
      workspaceId: s.workspaceId, family: "build_launch" as const, operationId: s.operationId, environmentId: s.environmentId, provider: "aws",
      dedupKey: key, requestDigest: HEX("d"), idempotencySupported: false,
    });

    it("calls once, stores the receipt, and answers a retry from the receipt without calling the provider", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      let calls = 0;
      const call = async () => { calls++; return { value: "handle-1", receipt: receipt("handle-1", "req-9") }; };
      const first = await ledger.dispatchOnce(input(s, "d:once"), call);
      expect(first.kind).toBe("dispatched");
      expect(first.effect).toMatchObject({ state: "accepted", providerReceipt: { resourceId: "handle-1", requestIds: ["req-9"] } });
      const retry = await ledger.dispatchOnce(input(s, "d:once"), call);
      expect(retry.kind).toBe("deduplicated");
      expect(retry.effect.providerReceipt?.resourceId).toBe("handle-1");
      expect(calls).toBe(1);
    });

    it("an unknown failure (timeout, reset, abort) makes the effect uncertain and no later caller ever calls the provider", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      let calls = 0;
      const boom = async (): Promise<never> => { calls++; throw new Error("ECONNRESET"); };
      await expect(ledger.dispatchOnce(input(s, "d:lost"), boom)).rejects.toBeInstanceOf(EffectUnresolvedError);
      const effect = (await ledger.getByDedup(s.workspaceId, "build_launch", "d:lost"))!;
      expect(effect).toMatchObject({ state: "uncertain" });
      expect(effect.uncertainAt).not.toBeNull();
      await expect(ledger.dispatchOnce(input(s, "d:lost"), boom)).rejects.toBeInstanceOf(EffectUnresolvedError);
      expect(calls).toBe(1);
    });

    it("a definite refusal before acceptance tombstones the effect, and it is never repeated under the same identity", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      let calls = 0;
      const refused = async (): Promise<never> => { calls++; throw new Error("InvalidInputException"); };
      await expect(ledger.dispatchOnce(input(s, "d:rejected"), refused, () => "rejected")).rejects.toThrow("InvalidInputException");
      expect(await ledger.getByDedup(s.workspaceId, "build_launch", "d:rejected")).toMatchObject({ state: "tombstoned", tombstoneReason: "provider_rejected" });
      await expect(ledger.dispatchOnce(input(s, "d:rejected"), refused)).rejects.toBeInstanceOf(EffectTombstonedError);
      expect(calls).toBe(1);
    });

    it("two concurrent callers cannot both reach the provider", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      let calls = 0;
      const call = async () => { calls++; await new Promise((r) => setTimeout(r, 25)); return { value: 1, receipt: receipt("race", "r") }; };
      const results = await Promise.allSettled([ledger.dispatchOnce(input(s, "d:race"), call), ledger.dispatchOnce(input(s, "d:race"), call)]);
      expect(calls).toBe(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2 - results.filter((r) => r.status === "rejected").length);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(EffectUnresolvedError);
    });
  });

  describe("delayed responses never reopen an uncertain, conflicting or tombstoned effect", () => {
    it("a reply after the dispatcher was declared uncertain is recorded as a late receipt, stays uncertain, and is flagged stale-fence", async () => {
      const s = await seed(ctx.db);
      const l = await lease(ctx.db, s);
      const { effect } = await begin(ctx.db, s, { fence: { scope: l.scope, token: l.fenceToken } });
      await store.markUncertain(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, reason: "timeout", actor: "test" });
      await leases.release(ctx.db, l);
      const late = await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("late-1", "late-req"), actor: "test" });
      expect(late.state).toBe("uncertain");
      expect(late.providerReceipt).toBeNull();
      expect(late.lateReceipt).toMatchObject({ resourceId: "late-1", staleFence: true });
      // idempotent: the same late reply again changes nothing
      const again = await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("late-1", "late-req"), actor: "test" });
      expect(again.version).toBe(late.version);
    });

    it("a reply after revocation of the connection or approval (no live fence at all) is still stored", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s, { dedupKey: "revoked:1" });
      const accepted = await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("r-1"), actor: "test" });
      expect(accepted).toMatchObject({ state: "accepted", providerReceipt: { resourceId: "r-1" } });
    });

    it("a late receipt after a provider-rejection tombstone keeps the tombstone and is shown as a conflict", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await store.recordRejected(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, reason: "refused", actor: "test" });
      const late = await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("after-tombstone"), actor: "test" });
      expect(late.state).toBe("tombstoned");
      expect(late.lateReceipt?.resourceId).toBe("after-tombstone");
      expect(projectedState(late)).toBe("conflict");
      const listed = await store.list(ctx.db, s.workspaceId, { states: ["pending", "accepted", "uncertain", "conflict"], includeContradicted: true });
      expect(listed.map((e) => e.effectId)).toContain(effect.effectId);
      const events = await store.listEvents(ctx.db, s.workspaceId, effect.effectId);
      expect(events.map((e) => e.kind)).toContain("late_receipt_after_tombstone");
    });

    it("a second, different receipt for an accepted effect makes it a conflict", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("one"), actor: "test" });
      const same = await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("one"), actor: "test" });
      expect(same.state).toBe("accepted");
      const other = await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("two", "req-2"), actor: "test" });
      expect(other.state).toBe("conflict");
      expect(other.providerReceipt?.resourceId).toBe("one");
      expect(other.lateReceipt?.resourceId).toBe("two");
    });
  });

  describe("readback", () => {
    it("an exact present readback confirms an accepted effect", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("b-1"), actor: "test" });
      const confirmed = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, readback: readback({ resourceId: "b-1" }), actor: "test" });
      expect(confirmed.state).toBe("confirmed");
    });

    it("a readback naming a different object makes an accepted effect a conflict", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("b-1"), actor: "test" });
      const after = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, readback: readback({ resourceId: "other" }), actor: "test" });
      expect(after.state).toBe("conflict");
    });

    it("a readback never auto-resolves an uncertain effect; it only records evidence", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      const present = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback(), actor: "test" });
      expect(present.state).toBe("uncertain");
      expect(present.readback?.outcome).toBe("present");
    });

    it("an unavailable read does not replace earlier definitive evidence", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      const first = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ outcome: "absent", resourceId: undefined }), actor: "test" });
      const second = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ outcome: "unavailable", resourceId: undefined, reason: "throttled" }), actor: "test" });
      expect(second.readback?.digest).toBe(first.readback?.digest);
    });

    it("refuses a stale or future observation", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      await expect(store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ observedAt: new Date(Date.now() - 3_600_000).toISOString() }), actor: "t" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ observedAt: new Date(Date.now() + 3_600_000).toISOString() }), actor: "t" })).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("resolution needs evidence, the exact binding, and the fence/settle rules", () => {
    const resolveInput = (s: Awaited<ReturnType<typeof seed>>, e: { effectId: string }, decision: "confirm_applied" | "confirm_not_applied", bindingDigest: string) =>
      ({ workspaceId: s.workspaceId, effectId: e.effectId, decision, bindingDigest, approverId: "admin-1", reason: "checked the console" });
    const current = async (s: Awaited<ReturnType<typeof seed>>, id: string) => (await store.get(ctx.db, s.workspaceId, id))!;

    it("refuses to resolve before any readback exists", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_applied", HEX("1")))).rejects.toMatchObject({ code: "approval_required" });
    });

    it("confirm_applied adopts the readback as the receipt, on the exact reviewed binding", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      const withReadback = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ resourceId: "found-1", requestIds: ["rb-7"] }), actor: "t" });
      const binding = resolutionBinding(withReadback, "confirm_applied", withReadback.readback!.digest);
      const out = await store.resolve(ctx.db, resolveInput(s, e, "confirm_applied", binding));
      expect(out.effect).toMatchObject({ state: "confirmed", providerReceipt: { resourceId: "found-1", requestIds: ["rb-7"] } });
      expect(out.resolution).toMatchObject({ decision: "confirm_applied", approverId: "admin-1", effectVersion: withReadback.version });
      expect((await store.listResolutions(ctx.db, s.workspaceId, e.effectId))).toHaveLength(1);
    });

    it("an approval for an old binding is unusable after any later readback, receipt or state change", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      const r1 = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ resourceId: "x" }), actor: "t" });
      const stale = resolutionBinding(r1, "confirm_applied", r1.readback!.digest);
      await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ resourceId: "x", requestIds: ["fresh"] }), actor: "t" });
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_applied", stale))).rejects.toMatchObject({ code: "digest_mismatch" });
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_applied", HEX("0")))).rejects.toMatchObject({ code: "digest_mismatch" });
    });

    it("cannot confirm 'applied' from an absent readback, or 'not applied' from a present one", async () => {
      const s = await seed(ctx.db);
      const a = await insertAged(ctx.db, s, { state: "uncertain" });
      const absent = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: a.effectId, readback: readback({ outcome: "absent", resourceId: undefined }), actor: "t" });
      await expect(store.resolve(ctx.db, resolveInput(s, a, "confirm_applied", resolutionBinding(absent, "confirm_applied", absent.readback!.digest)))).rejects.toMatchObject({ code: "invalid_state" });
      const b = await insertAged(ctx.db, s, { state: "uncertain" });
      const present = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: b.effectId, readback: readback(), actor: "t" });
      await expect(store.resolve(ctx.db, resolveInput(s, b, "confirm_not_applied", resolutionBinding(present, "confirm_not_applied", present.readback!.digest)))).rejects.toMatchObject({ code: "invalid_state" });
    });

    it("refuses absence while the dispatching lease still holds its fence, including after a renewal", async () => {
      const s = await seed(ctx.db);
      const l = await lease(ctx.db, s);
      const e = await insertAged(ctx.db, s, { state: "uncertain", fence: { scope: l.scope, token: l.fenceToken } });
      const absent = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ outcome: "absent", resourceId: undefined }), actor: "t" });
      const binding = resolutionBinding(absent, "confirm_not_applied", absent.readback!.digest);
      expect(await store.isFenceLive(ctx.db, s.workspaceId, e.effectId)).toBe(true);
      expect(resolutionOptions(absent, true)[1]).toMatchObject({ decision: "confirm_not_applied", available: false });
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_not_applied", binding))).rejects.toMatchObject({ code: "invalid_state" });
      // renewal extends the same fence: still live, still refused
      const renewed = await leases.renew(ctx.db, l, 60_000);
      expect(renewed?.fenceToken).toBe(l.fenceToken);
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_not_applied", binding))).rejects.toMatchObject({ code: "invalid_state" });
      // once the holder is gone the call can no longer be in flight from it
      await leases.release(ctx.db, l);
      expect(await store.isFenceLive(ctx.db, s.workspaceId, e.effectId)).toBe(false);
      const out = await store.resolve(ctx.db, resolveInput(s, e, "confirm_not_applied", binding));
      expect(out.effect).toMatchObject({ state: "tombstoned", tombstoneReason: "operator_resolved_not_applied" });
    });

    it("a takeover (a newer fence) also supersedes the dispatcher", async () => {
      const s = await seed(ctx.db);
      const l = await lease(ctx.db, s, 1);
      await new Promise((r) => setTimeout(r, 15));
      const e = await insertAged(ctx.db, s, { state: "uncertain", fence: { scope: l.scope, token: l.fenceToken } });
      const next = await leases.acquire(ctx.db, { scope: l.scope, holder: "successor", ttlMs: 60_000, workspaceId: s.workspaceId });
      expect(next!.fenceToken).toBeGreaterThan(l.fenceToken);
      expect(await store.isFenceLive(ctx.db, s.workspaceId, e.effectId)).toBe(false);
      await leases.release(ctx.db, next!);
    });

    it("refuses absence inside the settle window", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain", ageMs: 60_000 });
      const absent = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ outcome: "absent", resourceId: undefined }), actor: "t" });
      expect(resolutionOptions(absent, false)[1].available).toBe(false);
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_not_applied", resolutionBinding(absent, "confirm_not_applied", absent.readback!.digest)))).rejects.toMatchObject({ code: "invalid_state" });
    });

    it("a late receipt blocks absence, and changes the binding of anything already reviewed", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      const absent = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ outcome: "absent", resourceId: undefined }), actor: "t" });
      const reviewed = resolutionBinding(absent, "confirm_not_applied", absent.readback!.digest);
      await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, receipt: receipt("surprise"), actor: "t" });
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_not_applied", reviewed))).rejects.toMatchObject({ code: "digest_mismatch" });
      const fresh = await current(s, e.effectId);
      expect(resolutionOptions(fresh, false)[1]).toMatchObject({ available: false });
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_not_applied", resolutionBinding(fresh, "confirm_not_applied", fresh.readback!.digest)))).rejects.toMatchObject({ code: "invalid_state" });
    });

    it("a conflict can be confirmed from a present readback of the same object only", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "conflict", receipt: receipt("recorded") });
      const other = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ resourceId: "different" }), actor: "t" });
      await expect(store.resolve(ctx.db, resolveInput(s, e, "confirm_applied", resolutionBinding(other, "confirm_applied", other.readback!.digest)))).rejects.toMatchObject({ code: "invalid_state" });
      const same = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback({ resourceId: "recorded", requestIds: ["again"] }), actor: "t" });
      const out = await store.resolve(ctx.db, resolveInput(s, e, "confirm_applied", resolutionBinding(same, "confirm_applied", same.readback!.digest)));
      expect(out.effect.state).toBe("confirmed");
    });

    it("an effect that is not waiting for resolution cannot be resolved", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await expect(store.resolve(ctx.db, resolveInput(s, effect, "confirm_applied", HEX("1")))).rejects.toMatchObject({ code: "invalid_state" });
    });
  });

  describe("the database trigger is the authority (bypass attempts)", () => {
    const raw = (sqlText: string, params: unknown[]) => ctx.db.query(sqlText, params);

    it("refuses to delete a ledger row or touch events and resolutions", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await expect(raw("delete from platform.external_effects where workspace_id = $1 and effect_id = $2", [s.workspaceId, effect.effectId])).rejects.toThrow();
      await expect(raw("update platform.external_effect_events set actor = 'x' where workspace_id = $1", [s.workspaceId])).rejects.toThrow();
      await expect(raw("delete from platform.external_effect_events where workspace_id = $1", [s.workspaceId])).rejects.toThrow();
    });

    it("refuses illegal state jumps written directly", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      // pending -> confirmed, pending -> conflict
      await expect(raw("update platform.external_effects set state = 'confirmed', version = version + 1 where workspace_id = $1 and effect_id = $2", [s.workspaceId, effect.effectId])).rejects.toThrow();
      await expect(raw("update platform.external_effects set state = 'conflict', version = version + 1 where workspace_id = $1 and effect_id = $2", [s.workspaceId, effect.effectId])).rejects.toThrow();
      // a version that does not advance by one
      await expect(raw("update platform.external_effects set state_reason = 'x' where workspace_id = $1 and effect_id = $2", [s.workspaceId, effect.effectId])).rejects.toThrow();
    });

    it("uncertain cannot be cleared by a plain update: no resolution row, no exit", async () => {
      const s = await seed(ctx.db);
      const e = await insertAged(ctx.db, s, { state: "uncertain" });
      await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: readback(), actor: "t" });
      const cur = (await store.get(ctx.db, s.workspaceId, e.effectId))!;
      await expect(raw("update platform.external_effects set state = 'confirmed', version = version + 1 where workspace_id = $1 and effect_id = $2", [s.workspaceId, e.effectId])).rejects.toThrow();
      await expect(raw("update platform.external_effects set state = 'tombstoned', tombstone_reason = 'operator_resolved_not_applied', version = version + 1 where workspace_id = $1 and effect_id = $2", [s.workspaceId, e.effectId])).rejects.toThrow();
      await expect(raw("update platform.external_effects set state = 'accepted', version = version + 1 where workspace_id = $1 and effect_id = $2", [s.workspaceId, e.effectId])).rejects.toThrow();
      // a hand-written resolution for the wrong evidence is refused too
      await expect(raw(
        `insert into platform.external_effect_resolutions (id, workspace_id, effect_id, effect_version, decision, readback_digest, binding_digest, approver_id, reason)
         values ('fxr_manual', $1, $2, $3, 'confirm_not_applied', $4, $4, 'someone', 'because')`,
        [s.workspaceId, e.effectId, cur.version, cur.readback!.digest])).rejects.toThrow();
      expect((await store.get(ctx.db, s.workspaceId, e.effectId))!.state).toBe("uncertain");
    });

    it("confirmed and tombstoned are terminal; receipts and identity are write-once", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, receipt: receipt("keep"), actor: "t" });
      await expect(raw(`update platform.external_effects set provider_receipt = '{"requestIds":["x"]}'::jsonb, version = version + 1 where workspace_id = $1 and effect_id = $2`, [s.workspaceId, effect.effectId])).rejects.toThrow();
      await expect(raw("update platform.external_effects set dedup_key = 'other', version = version + 1 where workspace_id = $1 and effect_id = $2", [s.workspaceId, effect.effectId])).rejects.toThrow();
      await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, readback: readback({ resourceId: "keep" }), actor: "t" });
      const done = (await store.get(ctx.db, s.workspaceId, effect.effectId))!;
      expect(done.state).toBe("confirmed");
      await expect(raw("update platform.external_effects set state = 'uncertain', uncertain_at = clock_timestamp(), version = version + 1 where workspace_id = $1 and effect_id = $2", [s.workspaceId, effect.effectId])).rejects.toThrow();
      // the store functions leave a terminal effect untouched
      expect((await store.markUncertain(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, reason: "again", actor: "t" })).state).toBe("confirmed");
      expect((await store.recordRejected(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, reason: "again", actor: "t" })).state).toBe("confirmed");
    });
  });

  describe("tenant scoping", () => {
    it("a foreign workspace sees nothing and changes nothing", async () => {
      const a = await seed(ctx.db);
      const b = await seed(ctx.db, newWorkspace());
      const { effect } = await begin(ctx.db, a, { dedupKey: "tenant:1" });
      expect(await store.get(ctx.db, b.workspaceId, effect.effectId)).toBeNull();
      expect(await store.getByDedup(ctx.db, b.workspaceId, "build_launch", "tenant:1")).toBeNull();
      expect(await store.list(ctx.db, b.workspaceId, { operationId: a.operationId })).toEqual([]);
      expect(await store.listEvents(ctx.db, b.workspaceId, effect.effectId)).toEqual([]);
      expect(await store.isFenceLive(ctx.db, b.workspaceId, effect.effectId)).toBe(false);
      const foreign = { workspaceId: b.workspaceId, effectId: effect.effectId, actor: "x" };
      await expect(store.recordAccepted(ctx.db, { ...foreign, receipt: receipt("x") })).rejects.toMatchObject({ code: "not_found" });
      await expect(store.markUncertain(ctx.db, { ...foreign, reason: "x" })).rejects.toMatchObject({ code: "not_found" });
      await expect(store.recordRejected(ctx.db, { ...foreign, reason: "x" })).rejects.toMatchObject({ code: "not_found" });
      await expect(store.recordReadback(ctx.db, { ...foreign, readback: readback() })).rejects.toMatchObject({ code: "not_found" });
      await expect(store.resolve(ctx.db, { workspaceId: b.workspaceId, effectId: effect.effectId, decision: "confirm_applied", bindingDigest: HEX("1"), approverId: "x", reason: "xxx" })).rejects.toMatchObject({ code: "not_found" });
      // an operation of another workspace cannot own an effect
      await expect(begin(ctx.db, { ...b, operationId: a.operationId }, { dedupKey: "tenant:cross" })).rejects.toBeInstanceOf(Error);
      expect((await store.get(ctx.db, a.workspaceId, effect.effectId))!.state).toBe("pending");
    });

    it("the same dedup key in two workspaces is two effects", async () => {
      const a = await seed(ctx.db);
      const b = await seed(ctx.db, newWorkspace());
      const x = await begin(ctx.db, a, { dedupKey: "shared:key" });
      const y = await begin(ctx.db, b, { dedupKey: "shared:key" });
      expect(x.created && y.created).toBe(true);
      expect(x.effect.effectId).not.toBe(y.effect.effectId);
    });
  });

  describe("stale pending sweep", () => {
    it("declares a pending effect whose lease is gone uncertain, never retries it, and leaves live holders alone", async () => {
      const s = await seed(ctx.db);
      const gone = await lease(ctx.db, s, 60_000);
      const abandoned = await insertAged(ctx.db, s, { state: "pending", fence: { scope: gone.scope, token: gone.fenceToken } });
      await leases.release(ctx.db, gone);
      const s2 = await seed(ctx.db);
      const live = await lease(ctx.db, s2, 60_000);
      const running = await insertAged(ctx.db, s2, { state: "pending", fence: { scope: live.scope, token: live.fenceToken } });
      const swept = await store.sweepStalePending(ctx.db, { olderThanMs: 1_000, limit: 200 });
      expect(swept.map((x) => x.effectId)).toContain(abandoned.effectId);
      expect(swept.map((x) => x.effectId)).not.toContain(running.effectId);
      expect(await store.get(ctx.db, s.workspaceId, abandoned.effectId)).toMatchObject({ state: "uncertain" });
      expect(await store.get(ctx.db, s2.workspaceId, running.effectId)).toMatchObject({ state: "pending" });
      await leases.release(ctx.db, live);
      // a second sweep finds nothing new for the abandoned one
      const again = await store.sweepStalePending(ctx.db, { olderThanMs: 1_000, limit: 200 });
      expect(again.map((x) => x.effectId)).not.toContain(abandoned.effectId);
    });

    it("never touches a recent pending effect", async () => {
      const s = await seed(ctx.db);
      const { effect } = await begin(ctx.db, s);
      await store.sweepStalePending(ctx.db, { olderThanMs: 600_000 });
      expect((await store.get(ctx.db, s.workspaceId, effect.effectId))!.state).toBe("pending");
    });
  });

  it("surfaces unresolved effects of an operation (pending, uncertain, conflict) for projections", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const ok = await begin(ctx.db, s, { dedupKey: "ok" });
    await store.recordAccepted(ctx.db, { workspaceId: s.workspaceId, effectId: ok.effect.effectId, receipt: receipt("ok"), actor: "t" });
    const unc = await insertAged(ctx.db, s, { state: "uncertain" });
    const open = await ledger.unresolvedForOperation(s.workspaceId, s.operationId);
    expect(open.map((e) => e.effectId)).toEqual([unc.effectId]);
  });
});
