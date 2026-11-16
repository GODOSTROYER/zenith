/**
 * Readback resolvers (PROD-DUR-07 / PROD-DUR-08). The AWS resolver is exercised against an in-memory CodeBuild
 * API double (the same read-only commands the real client sends); the cleanup resolver against injected
 * observation reads; `runReadback` against the real control store.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchGetBuildsCommand, ListBuildsForProjectCommand, type Build, type CodeBuildClient } from "@aws-sdk/client-codebuild";
import { digest } from "@/lib/controlplane/digest";
import * as store from "@/lib/controlplane/db/repos/external-effects";
import { executedSettingsDigest } from "@/lib/providers/aws/drivers/compute/codebuild-builds";
import { awsBuildLaunchResolver } from "@/lib/effects/resolvers/aws-codebuild";
import { NO_INDEPENDENT_READBACK, ResolverRegistry, cleanupObservationResolver, runReadback, type EffectResolver, type ObservationFact } from "@/lib/effects/readback";
import type { EffectRecord } from "@/lib/effects/types";
import { LANES, openLane } from "../controlplane/_support/harness";
import { insertAged, seed } from "./_support";

const ACCOUNT = "123456789012", REGION = "us-east-1", PROJECT = "zn-proj", BUCKET = "zn-src";
const SOURCE_DIGEST = "e".repeat(64);
const KEY = `zenith/env_1/web/${SOURCE_DIGEST}.zip`;

function build(id: string, over: Partial<Build> = {}): Build {
  return {
    id, arn: `arn:aws:codebuild:${REGION}:${ACCOUNT}:build/${id}`, projectName: PROJECT, startTime: new Date(), buildStatus: "IN_PROGRESS",
    source: { type: "S3", location: `${BUCKET}/${KEY}` },
    environment: { type: "LINUX_CONTAINER", image: "aws/codebuild/standard:7.0", computeType: "BUILD_GENERAL1_SMALL", environmentVariables: [{ name: "ZENITH_SOURCE_DIGEST", value: SOURCE_DIGEST, type: "PLAINTEXT" }] },
    serviceRole: `arn:aws:iam::${ACCOUNT}:role/zn-build`, timeoutInMinutes: 30, queuedTimeoutInMinutes: 60, ...over,
  } as Build;
}
const ID = (n: number) => `${PROJECT}:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** In-memory CodeBuild: pages of ids newest first, BatchGetBuilds over a map. Only read commands exist. */
function fakeCodeBuild(builds: Build[], pageSize = 100, alwaysMore = false): { client: CodeBuildClient; sent: string[] } {
  const sent: string[] = [];
  const byId = new Map(builds.map((b) => [b.id!, b]));
  const ordered = [...builds].sort((a, b) => b.startTime!.getTime() - a.startTime!.getTime()).map((b) => b.id!);
  const client = {
    async send(command: unknown) {
      if (command instanceof ListBuildsForProjectCommand) {
        sent.push("list");
        const start = Number(command.input.nextToken ?? 0);
        const ids = ordered.slice(start, start + pageSize);
        const more = alwaysMore || start + pageSize < ordered.length;
        return { ids, ...(more ? { nextToken: String(start + pageSize) } : {}), $metadata: { requestId: "list-req" } };
      }
      if (command instanceof BatchGetBuildsCommand) {
        sent.push("get");
        return { builds: (command.input.ids ?? []).map((id) => byId.get(id)).filter(Boolean), $metadata: { requestId: "get-req" } };
      }
      throw new Error(`unexpected command ${String((command as { constructor?: { name?: string } })?.constructor?.name)}`);
    },
  } as unknown as CodeBuildClient;
  return { client, sent };
}

function awsEffect(over: Partial<EffectRecord> = {}): EffectRecord {
  return {
    workspaceId: "ws_1", effectId: "fx_1", family: "build_launch", operationId: "op_1", environmentId: "env_1", provider: "aws", dedupKey: "build:op_1:container_service/web",
    requestDigest: "a".repeat(64), idempotencyToken: "zn-1", idempotencySupported: true, fenceScope: null, fenceEpoch: null, state: "uncertain", stateReason: null,
    providerReceipt: null, lateReceipt: null, readback: null, tombstoneReason: null, version: 2,
    createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(), uncertainAt: new Date().toISOString(),
    target: { accountId: ACCOUNT, region: REGION, projectName: PROJECT, projectArn: `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${PROJECT}`, sourceBucket: BUCKET, sourceKey: KEY, sourceDigest: SOURCE_DIGEST, executedSettingsDigest: executedSettingsDigest(build(ID(0))), serviceAddress: "container_service/web" },
    ...over,
  };
}

const resolverFor = (client: CodeBuildClient, others: string[] = [], maxPages?: number): EffectResolver =>
  awsBuildLaunchResolver({ withClient: async (_e, _s, fn) => fn(client), otherBuildIds: async () => new Set(others), maxPages });
const read = (r: EffectResolver, effect: EffectRecord) => r.read({ effect, signal: new AbortController().signal });

describe("AWS CodeBuild launch readback", () => {
  it("finds exactly one matching build after dispatch and reports it as present with its id", async () => {
    const { client, sent } = fakeCodeBuild([build(ID(1)), build(ID(2), { startTime: new Date(Date.now() - 3_600_000) })]);
    const found = await read(resolverFor(client), awsEffect());
    expect(found).toMatchObject({ outcome: "present", resourceId: ID(1), requestIds: ["get-req"], facts: { matches: 1, lookalikes: 0, project: PROJECT } });
    expect(sent.every((c) => c === "list" || c === "get")).toBe(true);
  });

  it("reports absent only after listing back past the dispatch time", async () => {
    const { client } = fakeCodeBuild([build(ID(2), { startTime: new Date(Date.now() - 3_600_000) })]);
    expect(await read(resolverFor(client), awsEffect())).toMatchObject({ outcome: "absent", facts: { matches: 0, reachedDispatchTime: true } });
    const empty = fakeCodeBuild([]);
    expect(await read(resolverFor(empty.client), awsEffect())).toMatchObject({ outcome: "absent" });
  });

  it("is unavailable, never absent, when the list is too long to reach the dispatch time", async () => {
    const recent = Array.from({ length: 6 }, (_, i) => build(ID(10 + i), { source: { type: "S3", location: "other/object.zip" } }));
    const { client } = fakeCodeBuild(recent, 2, true);
    const out = await read(resolverFor(client, [], 2), awsEffect());
    expect(out.outcome).toBe("unavailable");
    expect(out.reason).toMatch(/too long/);
  });

  it("a second matching build is a mismatch, not a guess", async () => {
    const { client } = fakeCodeBuild([build(ID(1)), build(ID(2))]);
    expect(await read(resolverFor(client), awsEffect())).toMatchObject({ outcome: "mismatch", facts: { matches: 2 } });
  });

  it("a look-alike with a different executed configuration is a mismatch", async () => {
    const other = build(ID(3), { serviceRole: `arn:aws:iam::${ACCOUNT}:role/someone-else` });
    expect(await read(resolverFor(fakeCodeBuild([other]).client), awsEffect())).toMatchObject({ outcome: "mismatch", facts: { lookalikes: 1, matches: 0 } });
  });

  it("ignores a build that another ledger effect or launch already owns", async () => {
    const { client } = fakeCodeBuild([build(ID(1))]);
    expect(await read(resolverFor(client, [ID(1)]), awsEffect())).toMatchObject({ outcome: "absent", facts: { matches: 0 } });
  });

  it("ignores builds from another project, another source, another digest, or started before dispatch", async () => {
    const { client } = fakeCodeBuild([
      build(ID(1), { projectName: "elsewhere" }),
      build(ID(2), { source: { type: "S3", location: `${BUCKET}/zenith/env_1/web/${"f".repeat(64)}.zip` } }),
      build(ID(3), { environment: { ...build(ID(3)).environment!, environmentVariables: [{ name: "ZENITH_SOURCE_DIGEST", value: "f".repeat(64), type: "PLAINTEXT" }] } }),
      build(ID(4), { arn: "arn:aws:codebuild:us-east-1:999999999999:build/x" }),
      build(ID(5), { startTime: new Date(Date.now() - 600_000) }),
    ]);
    expect(await read(resolverFor(client), awsEffect())).toMatchObject({ outcome: "absent", facts: { matches: 0, lookalikes: 0 } });
  });

  it("does not guess when the effect records too little identity", async () => {
    const { client, sent } = fakeCodeBuild([build(ID(1))]);
    const e = awsEffect({ target: { region: REGION } });
    expect(await read(resolverFor(client), e)).toMatchObject({ outcome: "unavailable" });
    expect(sent).toEqual([]);
  });
});

describe("cleanup readback from independent observations", () => {
  const ADDRESSES = ["Deployment/ns/api", "Deployment/ns/web"];
  const target = { environmentId: "env_1", planDigest: "p".repeat(64), addressCount: 2, addressesDigest: digest([...ADDRESSES].sort()) };
  const effect = (over: Partial<EffectRecord> = {}): EffectRecord => ({ ...awsEffect(), family: "cleanup_apply", provider: "kubernetes", target, createdAt: new Date(Date.now() - 3_600_000).toISOString(), uncertainAt: new Date(Date.now() - 3_000_000).toISOString(), ...over });
  const obs = (address: string, presence: ObservationFact["presence"], ageMs = 0, simulated = false): ObservationFact => ({ address, presence, observedAt: new Date(Date.now() - ageMs).toISOString(), simulated });
  const resolver = (rows: ObservationFact[], ...reviewed: [] | [string[] | undefined]) => cleanupObservationResolver({ reviewedAddresses: async () => reviewed.length ? reviewed[0] : ADDRESSES, latestObservations: async () => rows });

  it("all reviewed addresses observed missing after dispatch: the deletion is observed (present)", async () => {
    expect(await read(resolver(ADDRESSES.map((a) => obs(a, "missing"))), effect())).toMatchObject({ outcome: "present", facts: { missing: 2, present: 0, partial: false } });
  });

  it("all still present well after dispatch: not applied (absent)", async () => {
    expect(await read(resolver(ADDRESSES.map((a) => obs(a, "present"))), effect())).toMatchObject({ outcome: "absent", facts: { present: 2, partial: false } });
  });

  it("a partial deletion is reported as not completed, with partial set for the reviewer", async () => {
    expect(await read(resolver([obs(ADDRESSES[0], "missing"), obs(ADDRESSES[1], "present")]), effect())).toMatchObject({ outcome: "absent", facts: { missing: 1, present: 1, partial: true } });
  });

  it("an observation older than the dispatch, a simulated one, or an unknown one proves nothing", async () => {
    for (const rows of [
      ADDRESSES.map((a) => obs(a, "missing", 2 * 3_600_000)),
      ADDRESSES.map((a) => obs(a, "missing", 0, true)),
      ADDRESSES.map((a) => obs(a, "unknown")),
      [obs(ADDRESSES[0], "missing")],
    ]) expect((await read(resolver(rows), effect())).outcome).toBe("unavailable");
  });

  it("does not report not-applied from observations taken inside the settle window", async () => {
    const young = effect({ createdAt: new Date(Date.now() - 120_000).toISOString(), uncertainAt: new Date(Date.now() - 120_000).toISOString() });
    const out = await read(resolver(ADDRESSES.map((a) => obs(a, "present"))), young);
    expect(out.outcome).toBe("unavailable");
    expect(out.facts.settledAfter).toBeTypeOf("string");
  });

  it("refuses a reviewed address list that no longer matches the effect, or cannot be loaded", async () => {
    expect((await read(resolver(ADDRESSES.map((a) => obs(a, "missing")), ["Deployment/ns/other"]), effect())).outcome).toBe("unavailable");
    expect((await read(resolver(ADDRESSES.map((a) => obs(a, "missing")), undefined), effect())).outcome).toBe("unavailable");
  });
});

describe.each(LANES)("runReadback on the control store ($name)", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); });
  afterAll(async () => { await ctx.close(); });

  const finding = (outcome: "present" | "absent", extra: Record<string, unknown> = {}): EffectResolver => ({ family: "build_launch", provider: "aws", read: async () => ({ outcome, source: "fake.source", facts: { n: 1 }, ...(outcome === "present" ? { resourceId: "found" } : {}), ...extra }) });

  it("records what the resolver found against the effect, without changing an uncertain effect's state", async () => {
    const s = await seed(ctx.db);
    const e = await insertAged(ctx.db, s, { state: "uncertain" });
    const out = await runReadback(ctx.db, new ResolverRegistry([finding("present")]), { workspaceId: s.workspaceId, effectId: e.effectId, actor: "user:op" });
    expect(out).toMatchObject({ state: "uncertain", readback: { outcome: "present", source: "fake.source", resourceId: "found" } });
    expect((await store.listEvents(ctx.db, s.workspaceId, e.effectId)).map((x) => x.actor)).toContain("user:op");
  });

  it("a provider with no independent readback leaves unavailable evidence that says so", async () => {
    const s = await seed(ctx.db);
    const e = await insertAged(ctx.db, s, { state: "uncertain" });
    const out = await runReadback(ctx.db, new ResolverRegistry(), { workspaceId: s.workspaceId, effectId: e.effectId, actor: "user:op" });
    expect(out.readback).toMatchObject({ outcome: "unavailable", source: "none", reason: NO_INDEPENDENT_READBACK });
  });

  it("a failing read becomes unavailable evidence with a fixed reason, never the provider's message", async () => {
    const s = await seed(ctx.db);
    const e = await insertAged(ctx.db, s, { state: "uncertain" });
    const boom: EffectResolver = { family: "build_launch", provider: "aws", read: async () => { throw new Error("AccessDenied for arn:aws:iam::123456789012:role/secret-role req 7f"); } };
    const out = await runReadback(ctx.db, new ResolverRegistry([boom]), { workspaceId: s.workspaceId, effectId: e.effectId, actor: "user:op" });
    expect(out.readback?.outcome).toBe("unavailable");
    expect(JSON.stringify(out.readback)).not.toContain("secret-role");
  });

  it("does not touch a confirmed or retired effect", async () => {
    const s = await seed(ctx.db);
    const { effect } = await store.begin(ctx.db, { workspaceId: s.workspaceId, family: "build_launch", operationId: s.operationId, provider: "aws", dedupKey: `rb:${Math.random()}`, requestDigest: "a".repeat(64), idempotencySupported: false, actor: "t" });
    await store.recordRejected(ctx.db, { workspaceId: s.workspaceId, effectId: effect.effectId, reason: "refused", actor: "t" });
    const out = await runReadback(ctx.db, new ResolverRegistry([finding("present")]), { workspaceId: s.workspaceId, effectId: effect.effectId, actor: "user:op" });
    expect(out).toMatchObject({ state: "tombstoned", readback: null });
  });

  it("a foreign effect is not found", async () => {
    const s = await seed(ctx.db);
    const e = await insertAged(ctx.db, s, { state: "uncertain" });
    await expect(runReadback(ctx.db, new ResolverRegistry([finding("absent")]), { workspaceId: "ws_other", effectId: e.effectId, actor: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
});
