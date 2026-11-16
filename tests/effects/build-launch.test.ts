/**
 * PROD-DUR-08: build launches use durable receipts and deduplicated retry, never blind replay; PROD-DUR-07: a
 * launch whose response was lost is resolved from independent evidence plus a fresh authorization.
 *
 * `startBuildOnce` is the GCP/Azure/Kubernetes/OCI path; the AWS helpers sit around the dedicated
 * `platform.build_launches` claim, whose acknowledgement is replaced here by a recording double (its own
 * authority, fence and approval behaviour is covered by tests/controlplane/build-launches.test.ts and
 * tests/platform/codebuild-launch-authority.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import type { BuildLaunch, BuildLaunchBinding } from "@/lib/controlplane/db/repos/build-launches";
import * as store from "@/lib/controlplane/db/repos/external-effects";
import { digest } from "@/lib/controlplane/digest";
import { resolutionBinding } from "@/lib/effects/binding";
import { awsBuildDedupKey, awsBuildEffectInput, confirmBuildFromExactRead, registerExistingLaunch, resolveUnreceiptedLaunch, startBuildOnce } from "@/lib/effects/build-launch";
import { EffectTombstonedError, EffectUnresolvedError, createEffectLedger } from "@/lib/effects/ledger";
import { StepFailedError } from "@/lib/execution/errors";
import { LANES, openLane } from "../controlplane/_support/harness";
import { HEX, insertAged, readback, receipt, seed, type Seed } from "./_support";

const acknowledge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/controlplane/db/repos/build-launches", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/controlplane/db/repos/build-launches")>()), acknowledge }));

const SERVICE = "container_service/web";
const bindingOf = (s: Seed): BuildLaunchBinding => ({
  workspaceId: s.workspaceId, operationId: s.operationId, environmentId: s.environmentId, serviceAddress: SERVICE, serviceSpecDigest: HEX("1"),
  pipelineAddress: "build_pipeline/ci", pipelineSpecDigest: HEX("2"), accountId: "123456789012", region: "us-east-1",
  projectArn: "arn:aws:codebuild:us-east-1:123456789012:project/zn", projectName: "zn", sourceBucket: "zn-src",
  sourceKey: `zenith/${s.environmentId}/web/${HEX("3")}.zip`, sourceDigest: HEX("3"), settingsDigest: HEX("4"), executedSettingsDigest: HEX("5"),
});
const launchOf = (s: Seed, over: Partial<BuildLaunch> = {}): BuildLaunch => ({
  workspace_id: s.workspaceId, operation_id: s.operationId, service_address: SERVICE, environment_id: s.environmentId, attempt_id: "att", binding: bindingOf(s),
  binding_digest: digest(bindingOf(s)), proposal_digest: HEX("6"), input_digest: HEX("7"), plan_digest: HEX("8"), phase: "dispatched", build_id: null, request_ids: null,
  terminal_status: null, provider_finished_at: null, observed_at: null, terminal_request_id: null, ...over,
});

describe.each(LANES)("build launch effects ($name)", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(() => { acknowledge.mockReset(); acknowledge.mockImplementation(async (_sql: unknown, launch: BuildLaunch, buildId: string, requestIds: string[]) => ({ ...launch, phase: "accepted", build_id: buildId, request_ids: requestIds })); });

  describe("startBuildOnce (providers without a launch claim table)", () => {
    const ctxOf = (s: Seed, provider = "gcp") => ({ provider, region: "us-central1", workspaceId: s.workspaceId, environmentId: s.environmentId, operationId: s.operationId, signal: new AbortController().signal, log: () => undefined, tags: {}, now: () => new Date(), session: { provider } }) as never;
    const inputOf = (digestHex = HEX("a"), key = "idem-1") => ({ service: { address: SERVICE }, pipeline: { address: "build_pipeline/ci" }, registry: { address: "container_registry/r" }, source: { s3Key: "k", digest: digestHex }, idempotencyKey: key }) as never;
    const HANDLE = JSON.stringify({ version: 1, id: "b-1", note: "x".repeat(700) });

    it("launches once and returns the saved long handle to every retry without calling the provider", async () => {
      const s = await seed(ctx.db);
      let calls = 0;
      const start = async () => { calls++; return { buildId: HANDLE }; };
      expect(await startBuildOnce(ctx.db, ctxOf(s), inputOf(), start)).toEqual({ buildId: HANDLE });
      expect(await startBuildOnce(ctx.db, ctxOf(s), inputOf(), start)).toEqual({ buildId: HANDLE });
      expect(await startBuildOnce(ctx.db, ctxOf(s), inputOf(), start)).toEqual({ buildId: HANDLE });
      expect(calls).toBe(1);
      const effect = await createEffectLedger(ctx.db).getByDedup(s.workspaceId, "build_launch", awsBuildDedupKey(s.operationId, SERVICE));
      expect(effect).toMatchObject({ state: "accepted", provider: "gcp", idempotencySupported: false });
    });

    it("a lost or unconfirmed launch is uncertain and no retry reaches the provider", async () => {
      const s = await seed(ctx.db);
      let calls = 0;
      const lost = async (): Promise<never> => { calls++; throw new Error("ACR build launch was not confirmed"); };
      await expect(startBuildOnce(ctx.db, ctxOf(s, "azure"), inputOf(), lost)).rejects.toBeInstanceOf(EffectUnresolvedError);
      await expect(startBuildOnce(ctx.db, ctxOf(s, "azure"), inputOf(), lost)).rejects.toBeInstanceOf(EffectUnresolvedError);
      expect(calls).toBe(1);
      expect(await createEffectLedger(ctx.db).getByDedup(s.workspaceId, "build_launch", awsBuildDedupKey(s.operationId, SERVICE))).toMatchObject({ state: "uncertain" });
    });

    it("a refusal before dispatch retires the effect and is not repeated under the same identity", async () => {
      const s = await seed(ctx.db);
      let calls = 0;
      const refuse = async (): Promise<never> => { calls++; throw new StepFailedError("Build inputs do not identify this workload's pipeline."); };
      await expect(startBuildOnce(ctx.db, ctxOf(s, "kubernetes"), inputOf(), refuse)).rejects.toBeInstanceOf(ApplicationFailure);
      await expect(startBuildOnce(ctx.db, ctxOf(s, "kubernetes"), inputOf(), refuse)).rejects.toBeInstanceOf(EffectTombstonedError);
      expect(calls).toBe(1);
    });

    it("refuses to reuse the identity for a different source", async () => {
      const s = await seed(ctx.db);
      const start = async () => ({ buildId: "h" });
      await startBuildOnce(ctx.db, ctxOf(s), inputOf(HEX("a")), start);
      await expect(startBuildOnce(ctx.db, ctxOf(s), inputOf(HEX("b")), start)).rejects.toMatchObject({ code: "conflict" });
    });

    it("without a control store or an operation it calls the port directly, exactly as before", async () => {
      const s = await seed(ctx.db);
      let calls = 0;
      const start = async () => { calls++; return { buildId: "direct" }; };
      expect(await startBuildOnce(undefined, ctxOf(s), inputOf(), start)).toEqual({ buildId: "direct" });
      const noOp = { ...(ctxOf(s) as object), operationId: undefined } as never;
      expect(await startBuildOnce(ctx.db, noOp, inputOf(), start)).toEqual({ buildId: "direct" });
      expect(calls).toBe(2);
    });
  });

  describe("AWS helpers around the durable launch claim", () => {
    const fence = { scope: "env:e", token: 1 };

    it("the effect input records the exact request, the idempotency token sent to CodeBuild, and the fence", async () => {
      const s = await seed(ctx.db);
      const b = bindingOf(s);
      const input = awsBuildEffectInput(b, "zn-op-abc123", fence);
      expect(input).toMatchObject({ family: "build_launch", provider: "aws", dedupKey: awsBuildDedupKey(s.operationId, SERVICE), requestDigest: digest(b),
        idempotencyToken: "zn-op-abc123", idempotencySupported: true, fence, target: { projectName: "zn", executedSettingsDigest: HEX("5"), sourceDigest: HEX("3") } });
    });

    it("an existing claim with no receipt becomes uncertain and is never replayed", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const input = awsBuildEffectInput(bindingOf(s), "tok", fence);
      await expect(resolveUnreceiptedLaunch(ctx.db, ledger, launchOf(s), input)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
      expect(await ledger.getByDedup(s.workspaceId, "build_launch", input.dedupKey)).toMatchObject({ state: "uncertain" });
      await expect(resolveUnreceiptedLaunch(ctx.db, ledger, launchOf(s), input)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
      expect(acknowledge).not.toHaveBeenCalled();
    });

    it("the provider's own saved receipt is adopted after a crash between acceptance and acknowledgement", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const input = awsBuildEffectInput(bindingOf(s), "tok", fence);
      const made = await ledger.begin({ ...input, fence: undefined });
      await ledger.recordAccepted(s.workspaceId, made.effect.effectId, { resourceId: "zn:00000000-0000-4000-8000-000000000001", requestIds: ["req-a"] });
      const launch = launchOf(s);
      const adopted = await resolveUnreceiptedLaunch(ctx.db, ledger, launch, input);
      expect(acknowledge).toHaveBeenCalledWith(ctx.db, launch, "zn:00000000-0000-4000-8000-000000000001", ["req-a"]);
      expect(adopted.build_id).toBe("zn:00000000-0000-4000-8000-000000000001");
    });

    it("a receipt without request ids, or a retired effect, is not adopted", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const input = awsBuildEffectInput(bindingOf(s), "tok", fence);
      const made = await ledger.begin({ ...input, fence: undefined });
      await ledger.recordAccepted(s.workspaceId, made.effect.effectId, { resourceId: "zn:00000000-0000-4000-8000-000000000002", requestIds: [] });
      await expect(resolveUnreceiptedLaunch(ctx.db, ledger, launchOf(s), input)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
      const t = await seed(ctx.db);
      const tin = awsBuildEffectInput(bindingOf(t), "tok", fence);
      const e = await ledger.begin({ ...tin, fence: undefined });
      await ledger.recordRejected(t.workspaceId, e.effect.effectId, "refused");
      await expect(resolveUnreceiptedLaunch(ctx.db, ledger, launchOf(t), tin)).rejects.toMatchObject({ code: "build_launch_unconfirmed" });
      expect(acknowledge).not.toHaveBeenCalled();
    });

    it("a lost response is resolved from readback evidence plus an authorization, then adopted without a second build", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const input = awsBuildEffectInput(bindingOf(s), "tok", fence);
      const uncertain = await insertAged(ctx.db, s, { state: "uncertain", dedupKey: input.dedupKey });
      // the operator path: independent readback, then an admin authorizes exactly that evidence
      const withReadback = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: uncertain.effectId, readback: readback({ resourceId: "zn:00000000-0000-4000-8000-000000000003", requestIds: ["rb-1"] }), actor: "user:op" });
      await expect(resolveUnreceiptedLaunch(ctx.db, ledger, launchOf(s), { ...input, requestDigest: HEX("b") })).rejects.toBeInstanceOf(Error);
      await store.resolve(ctx.db, { workspaceId: s.workspaceId, effectId: uncertain.effectId, decision: "confirm_applied", bindingDigest: resolutionBinding(withReadback, "confirm_applied", withReadback.readback!.digest), approverId: "admin-1", reason: "the console shows one build" });
      const launch = launchOf(s);
      const adopted = await resolveUnreceiptedLaunch(ctx.db, ledger, launch, { ...input, requestDigest: HEX("b") });
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledWith(ctx.db, launch, "zn:00000000-0000-4000-8000-000000000003", ["rb-1"]);
      expect(adopted.build_id).toBe("zn:00000000-0000-4000-8000-000000000003");
    });

    it("registers a pre-ledger launch that already has its receipt, once", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const input = awsBuildEffectInput(bindingOf(s), "tok", fence);
      const launch = launchOf(s, { phase: "accepted", build_id: "zn:00000000-0000-4000-8000-000000000004", request_ids: ["req-old"] });
      await registerExistingLaunch(ledger, launch, input);
      await registerExistingLaunch(ledger, launch, input);
      expect(await ledger.getByDedup(s.workspaceId, "build_launch", input.dedupKey)).toMatchObject({ state: "accepted", providerReceipt: { resourceId: "zn:00000000-0000-4000-8000-000000000004", requestIds: ["req-old"] } });
    });

    it("an exact independent read of the accepted build confirms it; a read of another build conflicts", async () => {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const input = awsBuildEffectInput(bindingOf(s), "tok", fence);
      const made = await ledger.begin({ ...input, fence: undefined });
      await ledger.recordAccepted(s.workspaceId, made.effect.effectId, receipt("zn:00000000-0000-4000-8000-000000000005", "req-1"));
      await confirmBuildFromExactRead(ledger, launchOf(s), { id: "zn:00000000-0000-4000-8000-000000000005", status: "IN_PROGRESS" }, "get-req");
      expect((await ledger.get(s.workspaceId, made.effect.effectId))!.state).toBe("confirmed");

      const t = await seed(ctx.db);
      const tin = awsBuildEffectInput(bindingOf(t), "tok", fence);
      const e = await ledger.begin({ ...tin, fence: undefined });
      await ledger.recordAccepted(t.workspaceId, e.effect.effectId, receipt("zn:00000000-0000-4000-8000-000000000006", "req-2"));
      await confirmBuildFromExactRead(ledger, launchOf(t), { id: "zn:00000000-0000-4000-8000-000000000099", status: "IN_PROGRESS" }, "get-req");
      expect((await ledger.get(t.workspaceId, e.effect.effectId))!.state).toBe("conflict");
    });

    it("confirmation is best effort: an unknown effect or a store error never fails the build wait", async () => {
      const s = await seed(ctx.db);
      await expect(confirmBuildFromExactRead(createEffectLedger(ctx.db), launchOf(s), { id: "x", status: "IN_PROGRESS" }, undefined)).resolves.toBeUndefined();
    });
  });
});
