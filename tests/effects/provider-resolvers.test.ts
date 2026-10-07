/**
 * PROD-DUR-07: independent readback of GCP Cloud Build and Azure ACR Tasks launches, and the path from a lost
 * launch to an operator-confirmed, adopted build without a second launch. Sessions are in-memory doubles that
 * answer the same read URLs the real brokered sessions send; the ledger is the real control store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AzureSession, GcpSession } from "@/lib/credentials/types";
import * as store from "@/lib/controlplane/db/repos/external-effects";
import { resolutionBinding } from "@/lib/effects/binding";
import { startBuildOnce } from "@/lib/effects/build-launch";
import { EffectUnresolvedError, createEffectLedger } from "@/lib/effects/ledger";
import { ResolverRegistry, runReadback, type EffectResolver } from "@/lib/effects/readback";
import { azureBuildLaunchResolver } from "@/lib/effects/resolvers/azure-acr";
import { gcpBuildLaunchResolver } from "@/lib/effects/resolvers/gcp-cloudbuild";
import type { EffectRecord } from "@/lib/effects/types";
import { LANES, openLane } from "../controlplane/_support/harness";
import { HEX, seed, type Seed } from "./_support";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const read = (r: EffectResolver, effect: EffectRecord) => r.read({ effect, signal: new AbortController().signal });
const base = (over: Partial<EffectRecord>): EffectRecord => ({
  workspaceId: "ws_1", effectId: "fx_1", family: "build_launch", operationId: "op_1", environmentId: "env_1", provider: "gcp", dedupKey: "build:op_1:container_service/web",
  requestDigest: "a".repeat(64), target: {}, idempotencyToken: null, idempotencySupported: false, fenceScope: null, fenceEpoch: null, state: "uncertain", stateReason: null,
  providerReceipt: null, lateReceipt: null, readback: null, tombstoneReason: null, version: 2,
  createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(), uncertainAt: new Date().toISOString(), ...over,
});

/* ----------------------------------- GCP ----------------------------------- */

const TAG = "zenith-op-0123456789ab";
const gcpEffect = (over: Partial<EffectRecord> = {}) => base({ provider: "gcp", target: { tag: TAG, projectId: "zn-project-1", region: "us-central1" }, ...over });
function gcpSession(answer: (url: string) => Response, projectId = "zn-project-1") {
  const urls: string[] = [];
  const session = { provider: "gcp", projectId, region: "us-central1", expiresAt: "2099-01-01T00:00:00Z", childProcessEnv: () => ({}),
    authorizedFetch: async (url: string) => { urls.push(url); return answer(url); } } as unknown as GcpSession;
  return { session, urls };
}
const gcpResolver = (s: GcpSession) => gcpBuildLaunchResolver({ withSession: async (_e, _sig, fn) => fn(s) });
const gcpBuild = (id: string, over: Record<string, unknown> = {}) => ({ id, status: "WORKING", tags: ["zenith", TAG], createTime: new Date().toISOString(), ...over });

describe("GCP Cloud Build launch readback", () => {
  it("one build carrying the launch tag is present, found by a tag filter on this project and region", async () => {
    const { session, urls } = gcpSession(() => json({ builds: [gcpBuild("11111111-2222-3333-4444-555555555555")] }, 200, { "x-goog-request-id": "g-req" }));
    expect(await read(gcpResolver(session), gcpEffect())).toMatchObject({ outcome: "present", resourceId: "11111111-2222-3333-4444-555555555555", requestIds: ["g-req"], facts: { matches: 1, buildStatus: "WORKING" } });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/projects/zn-project-1/locations/us-central1/builds");
    expect(decodeURIComponent(urls[0])).toContain(`tags="${TAG}"`);
  });
  it("no build with the tag is absent; several are a mismatch; a page of unrelated builds does not count", async () => {
    expect(await read(gcpResolver(gcpSession(() => json({})).session), gcpEffect())).toMatchObject({ outcome: "absent", facts: { matches: 0 } });
    expect(await read(gcpResolver(gcpSession(() => json({ builds: [gcpBuild("11111111-2222-3333-4444-555555555555", { tags: ["zenith", "zenith-op-ffffffffffff"] })] })).session), gcpEffect())).toMatchObject({ outcome: "absent" });
    const two = gcpSession(() => json({ builds: [gcpBuild("11111111-2222-3333-4444-555555555555"), gcpBuild("11111111-2222-3333-4444-666666666666")] }));
    expect(await read(gcpResolver(two.session), gcpEffect())).toMatchObject({ outcome: "mismatch", facts: { matches: 2 } });
    const more = gcpSession(() => json({ builds: [gcpBuild("11111111-2222-3333-4444-555555555555")], nextPageToken: "t" }));
    expect((await read(gcpResolver(more.session), gcpEffect())).outcome).toBe("mismatch");
  });
  it("an unreadable answer, an HTTP error, a foreign project or missing identity is unavailable, never absent", async () => {
    expect((await read(gcpResolver(gcpSession(() => new Response("<html>", { status: 200 })).session), gcpEffect())).outcome).toBe("unavailable");
    expect(await read(gcpResolver(gcpSession(() => json({ error: {} }, 403)).session), gcpEffect())).toMatchObject({ outcome: "unavailable", facts: { httpStatus: 403 } });
    expect((await read(gcpResolver(gcpSession(() => json({}), "other-project-9").session), gcpEffect())).outcome).toBe("unavailable");
    const none = gcpSession(() => json({}));
    expect((await read(gcpResolver(none.session), gcpEffect({ target: { region: "us-central1" } }))).outcome).toBe("unavailable");
    expect((await read(gcpResolver(none.session), gcpEffect({ target: { tag: "bad tag\"; drop", projectId: "zn-project-1", region: "us-central1" } }))).outcome).toBe("unavailable");
    expect(none.urls).toEqual([]);
  });
});

/* ---------------------------------- Azure ---------------------------------- */

const ATAG = `zn-${"c".repeat(64)}`;
const SUB = "11111111-1111-1111-1111-111111111111";
const REGISTRY_ID = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/znreg`;
const azEffect = (over: Partial<EffectRecord> = {}) => base({ provider: "azure", target: { tag: ATAG, repository: "web", registryAddress: "container_registry/r", subscriptionId: SUB, region: "eastus" }, ...over });
function azSession(answers: { registries?: unknown[]; runs?: unknown[]; runsNext?: string }, subscriptionId = SUB) {
  const urls: string[] = [];
  const session = { provider: "azure", subscriptionId, region: "eastus", expiresAt: "2099-01-01T00:00:00Z", childProcessEnv: () => ({}),
    authorizedFetch: async (url: string) => {
      urls.push(url);
      if (url.includes("/resources?")) return json({ value: answers.registries ?? [{ id: REGISTRY_ID, name: "znreg", type: "Microsoft.ContainerRegistry/registries" }] }, 200, { "x-ms-request-id": "az-1" });
      if (url.includes("/runs?")) return json({ value: answers.runs ?? [], ...(answers.runsNext ? { nextLink: answers.runsNext } : {}) }, 200, { "x-ms-request-id": "az-2" });
      return json({ error: { code: "NotFound" } }, 404);
    } } as unknown as AzureSession;
  return { session, urls };
}
const azResolver = (s: AzureSession) => azureBuildLaunchResolver({ withSession: async (_e, _sig, fn) => fn(s) });
const run = (runId: string, over: Record<string, unknown> = {}) => ({ name: runId, properties: { runId, status: "Succeeded", createTime: new Date().toISOString(), outputImages: [{ registry: "znreg.azurecr.io", repository: "web", tag: ATAG, digest: `sha256:${"d".repeat(64)}` }], ...over } });

describe("Azure ACR Tasks launch readback", () => {
  it("one succeeded run that pushed the launch tag is present; the registry is found by its tag and the runs are filtered to builds", async () => {
    const { session, urls } = azSession({ runs: [run("cb1"), run("cb2", { outputImages: [{ repository: "web", tag: `zn-${"e".repeat(64)}` }] })] });
    expect(await read(azResolver(session), azEffect())).toMatchObject({ outcome: "present", resourceId: "cb1", requestIds: ["az-2"], facts: { matches: 1, registry: "znreg" } });
    expect(urls.some((u) => u.includes("/resources?") && decodeURIComponent(u).includes("container_registry/r"))).toBe(true);
    expect(urls.some((u) => u.includes(`${REGISTRY_ID}/runs?`) && decodeURIComponent(u).includes("QuickBuild"))).toBe(true);
  });
  it("no run since dispatch is absent; runs before the dispatch are ignored", async () => {
    expect(await read(azResolver(azSession({ runs: [] }).session), azEffect())).toMatchObject({ outcome: "absent", facts: { matches: 0 } });
    const old = run("old", { createTime: new Date(Date.now() - 3_600_000).toISOString(), status: "Failed", outputImages: [] });
    expect((await read(azResolver(azSession({ runs: [old] }).session), azEffect())).outcome).toBe("absent");
  });
  it("a running or failed run since dispatch exposes no tag, so absence cannot be shown", async () => {
    for (const status of ["Running", "Queued", "Failed", "Canceled"]) {
      const out = await read(azResolver(azSession({ runs: [run("r1", { status, outputImages: [] })] }).session), azEffect());
      expect(out.outcome, status).toBe("unavailable");
      expect(out.facts.unattributedRunsSinceDispatch).toBe(1);
    }
  });
  it("two runs with the tag are a mismatch; a registry that is not unique or a truncated list is unavailable", async () => {
    expect((await read(azResolver(azSession({ runs: [run("cb1"), run("cb2")] }).session), azEffect())).outcome).toBe("mismatch");
    const two = [{ id: REGISTRY_ID, name: "a", type: "Microsoft.ContainerRegistry/registries" }, { id: `${REGISTRY_ID}2`, name: "b", type: "Microsoft.ContainerRegistry/registries" }];
    expect((await read(azResolver(azSession({ registries: two }).session), azEffect())).outcome).toBe("unavailable");
    expect((await read(azResolver(azSession({ registries: [] }).session), azEffect())).outcome).toBe("unavailable");
    const endless = azSession({ runs: [run("cb1", { status: "Failed", outputImages: [] })], runsNext: "https://management.azure.com/next?x=1" });
    expect((await read(azResolver(endless.session), azEffect())).outcome).toBe("unavailable");
  });
  it("a foreign subscription session or missing identity is unavailable", async () => {
    expect((await read(azResolver(azSession({}, "22222222-2222-2222-2222-222222222222").session), azEffect())).outcome).toBe("unavailable");
    expect((await read(azResolver(azSession({}).session), azEffect({ target: { region: "eastus" } }))).outcome).toBe("unavailable");
  });
});

/* ------------- from a lost launch to an adopted build, on the control store ------------- */

describe.each(LANES)("lost non-AWS launch to confirmed adoption ($name)", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); });
  afterAll(async () => { await ctx.close(); });

  const ctxOf = (s: Seed, provider: string) => ({ provider, region: "us-central1", workspaceId: s.workspaceId, environmentId: s.environmentId, operationId: s.operationId, signal: new AbortController().signal, log: () => undefined, tags: {}, now: () => new Date(), session: { provider } }) as never;
  const input = { service: { address: "container_service/web" }, pipeline: { address: "build_pipeline/ci" }, registry: { address: "container_registry/r" }, source: { s3Key: "k", digest: HEX("a") }, idempotencyKey: "idem" } as never;

  it("records the readback identity with the effect, stores the provider id as the receipt, and returns the saved handle on a retry", async () => {
    const s = await seed(ctx.db);
    const HANDLE = JSON.stringify({ version: 1, id: "11111111-2222-3333-4444-555555555555", tag: TAG });
    const port = { startBuild: vi.fn(async () => ({ buildId: HANDLE })), launchIdentity: vi.fn(() => ({ tag: TAG, projectId: "zn-project-1" })) };
    expect(await startBuildOnce(ctx.db, ctxOf(s, "gcp"), input, port)).toEqual({ buildId: HANDLE });
    expect(await startBuildOnce(ctx.db, ctxOf(s, "gcp"), input, port)).toEqual({ buildId: HANDLE });
    expect(port.startBuild).toHaveBeenCalledTimes(1);
    const [e] = await createEffectLedger(ctx.db).list(s.workspaceId, { operationId: s.operationId });
    expect(e).toMatchObject({ state: "accepted", providerReceipt: { resourceId: "11111111-2222-3333-4444-555555555555" }, target: { tag: TAG, projectId: "zn-project-1", serviceAddress: "container_service/web" } });
  });

  it("a lost launch stays uncertain until readback plus an authorization, then the build is adopted and never launched again", async () => {
    const s = await seed(ctx.db);
    const lost = vi.fn(async (): Promise<never> => { throw new Error("Cloud Build launch could not be confirmed"); });
    const adopt = vi.fn(async (_c: unknown, _i: unknown, id: string) => ({ buildId: JSON.stringify({ version: 1, id, tag: TAG }) }));
    const port = { startBuild: lost, launchIdentity: () => ({ tag: TAG, projectId: "zn-project-1" }), adoptBuild: adopt };
    await expect(startBuildOnce(ctx.db, ctxOf(s, "gcp"), input, port)).rejects.toBeInstanceOf(EffectUnresolvedError);
    await expect(startBuildOnce(ctx.db, ctxOf(s, "gcp"), input, port)).rejects.toBeInstanceOf(EffectUnresolvedError);
    expect(lost).toHaveBeenCalledTimes(1);
    const [uncertain] = await createEffectLedger(ctx.db).list(s.workspaceId, { operationId: s.operationId });
    expect(uncertain.state).toBe("uncertain");
    // the independent readback finds it by tag
    const registry = new ResolverRegistry([gcpBuildLaunchResolver({ withSession: async (_e, _s2, fn) => fn(gcpSession(() => json({ builds: [gcpBuild("11111111-2222-3333-4444-777777777777")] })).session) })]);
    const read1 = await runReadback(ctx.db, registry, { workspaceId: s.workspaceId, effectId: uncertain.effectId, actor: "user:op" });
    expect(read1).toMatchObject({ state: "uncertain", readback: { outcome: "present", resourceId: "11111111-2222-3333-4444-777777777777" } });
    await expect(startBuildOnce(ctx.db, ctxOf(s, "gcp"), input, port)).rejects.toBeInstanceOf(EffectUnresolvedError);
    // an admin authorizes exactly that evidence
    await store.resolve(ctx.db, { workspaceId: s.workspaceId, effectId: uncertain.effectId, decision: "confirm_applied", bindingDigest: resolutionBinding(read1, "confirm_applied", read1.readback!.digest), approverId: "admin-1", reason: "the console shows the build" });
    const handle = await startBuildOnce(ctx.db, ctxOf(s, "gcp"), input, port);
    expect(JSON.parse(handle.buildId)).toMatchObject({ id: "11111111-2222-3333-4444-777777777777", tag: TAG });
    expect(adopt).toHaveBeenCalledOnce();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("without an adopt method a confirmed-but-handleless launch is still refused rather than guessed", async () => {
    const s = await seed(ctx.db);
    const port = { startBuild: async (): Promise<never> => { throw new Error("lost"); }, launchIdentity: () => ({ tag: TAG, projectId: "zn-project-1" }) };
    await expect(startBuildOnce(ctx.db, ctxOf(s, "azure"), input, port)).rejects.toBeInstanceOf(EffectUnresolvedError);
    const [e] = await createEffectLedger(ctx.db).list(s.workspaceId, { operationId: s.operationId });
    const rb = await store.recordReadback(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, readback: (await import("@/lib/effects/binding")).buildReadback({ outcome: "present", source: "t", observedAt: new Date().toISOString(), resourceId: "run1", facts: {} }), actor: "t" });
    await store.resolve(ctx.db, { workspaceId: s.workspaceId, effectId: e.effectId, decision: "confirm_applied", bindingDigest: resolutionBinding(rb, "confirm_applied", rb.readback!.digest), approverId: "admin-1", reason: "seen in the portal" });
    await expect(startBuildOnce(ctx.db, ctxOf(s, "azure"), input, port)).rejects.toBeInstanceOf(EffectUnresolvedError);
  });
});
