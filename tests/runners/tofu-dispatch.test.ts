/**
 * OpenTofu on a runner (`tofu.run`), control-plane side: payloads built from a TofuWorkspace, the plan
 * result normalized HERE, and the apply guard — an apply job is issued only with the `planFileSha256` of
 * a fresh plan whose normalized digest equals the approved digest.
 *
 * The fake runner plays the Go runner's part of the contract (RUNNER-PROTOCOL.md, `tofu.run`): it
 * recomputes `configDigest` from the files it was sent (independently of the code under test), returns
 * `{ exitCode, output, planJson, planFileSha256 }` for a plan, and accepts an apply only for the plan file
 * it produced. The binary plan file and real OpenTofu are NOT exercised here; `tests/tofu` covers the engine
 * and the Go module covers the runner.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { DispatchError, RunnerJobError } from "@/lib/runners/dispatch";
import { applyVerifiedOnRunner, assertApplyAllowed, buildTofuRunPayload, planOnRunner, type RunnerPlanResult, type RunnerTofuTarget } from "@/lib/runners/tofu-runner-dispatch";
import { TofuPlanChangedError } from "@/lib/tofu/types";
import { normalizePlan, TofuPlanFormatError, type ShowJson } from "@/lib/tofu/plan";
import { configDigestOf, lockDigestOf } from "@/lib/tofu/config-digest";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { builtinWorkspace, dataFragment } from "../tofu/_helpers";
import { FakeAgent, FakeRunnerService, OPERATION, createPlane, registerFakeAgent, runnerGrant, teardownPlane, type AgentResultBody, type DecodedJob, type Plane } from "./_support";

const planFixture = (): ShowJson => JSON.parse(readFileSync(path.resolve(__dirname, "../tofu/fixtures/plan-mixed.json"), "utf8"));
const digestVector = JSON.parse(readFileSync(path.resolve(__dirname, "../tofu/fixtures/config-digest-vector.json"), "utf8")) as { vectors: { name: string; files: { path: string; content: string; contentB64: string }[]; configDigest: string }[] };

let plane: Plane;
let agent: FakeAgent;
let service: FakeRunnerService | undefined;
let ws: TofuWorkspace;
beforeEach(async () => {
  plane = await createPlane("real");
  agent = await registerFakeAgent(plane, registerRunner);
  ws = builtinWorkspace("terraform.tfstate", { "resource/a": dataFragment("a", "hello"), "resource/b": dataFragment("b", { n: 1 }) });
});
afterEach(async () => {
  await service?.stop().catch(() => undefined);
  service = undefined;
  teardownPlane();
});

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The rule, written out independently of `configDigestOf`: sorted by path, path ‖ 0x00 ‖ hex(sha256(bytes)) ‖ 0x0A. */
function digestOfPayloadFiles(files: { path: string; contentB64: string }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    h.update(Buffer.concat([Buffer.from(f.path), Buffer.from([0]), Buffer.from(sha(Buffer.from(f.contentB64, "base64"))), Buffer.from([0x0a])]));
  }
  return h.digest("hex");
}

async function target(over: Partial<RunnerTofuTarget> = {}): Promise<RunnerTofuTarget> {
  return {
    workspaceId: "w-a",
    runnerId: agent.id,
    operationId: OPERATION,
    grant: await runnerGrant(plane, { runnerId: agent.id, workspaceId: "w-a", operationId: OPERATION, capability: "infrastructure.apply" }),
    planGrant: await runnerGrant(plane, { runnerId: agent.id, workspaceId: "w-a", operationId: OPERATION, capability: "infrastructure.plan" }),
    timeoutSec: 60,
    ...over,
  };
}

interface TofuJob {
  command: "plan" | "apply" | "show";
  files: { path: string; contentB64: string }[];
  lockfile: string;
  configDigest: string;
  planFileSha256?: string;
  destroy?: boolean;
}
const payloadOf = (job: DecodedJob): TofuJob => job.claims.payload as TofuJob;

/** A runner that keeps the plan files it produced, like the Go one (plans are single-use). */
function goLikeRunner(planJson: () => ShowJson, script: { apply?: AgentResultBody } = {}) {
  const retained = new Map<string, string>(); // planFileSha256 -> configDigest
  let planSeq = 0;
  return async (job: DecodedJob): Promise<AgentResultBody> => {
    const p = payloadOf(job);
    // the runner recomputes configDigest and refuses a mismatch (spec: tofu.run)
    if (digestOfPayloadFiles(p.files) !== p.configDigest) return { status: "rejected", error: "invalid_payload: configDigest mismatch", result: { reason: "invalid_payload" } };
    if (p.command === "plan") {
      const planFileSha256 = sha(`plan-file-${++planSeq}-${p.configDigest}`);
      retained.set(planFileSha256, p.configDigest);
      return { status: "succeeded", exitCode: 0, result: { command: "plan", exitCode: 0, output: "Plan: 1 to add, 0 to change, 0 to destroy.", truncated: false, durationMs: 5, planJson: planJson(), planFileSha256 } };
    }
    if (p.command === "apply") {
      if (!p.planFileSha256 || retained.get(p.planFileSha256) !== p.configDigest) return { status: "rejected", error: "not_allowed: no retained plan file for this configDigest and planFileSha256", result: { reason: "not_allowed" } };
      retained.delete(p.planFileSha256); // single-use
      return script.apply ?? { status: "succeeded", exitCode: 0, result: { command: "apply", exitCode: 0, output: "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.", truncated: false, durationMs: 9 } };
    }
    return { status: "failed", error: "show not scripted" };
  };
}

async function serve(handler: (job: DecodedJob) => AgentResultBody | Promise<AgentResultBody>): Promise<FakeRunnerService> {
  service = new FakeRunnerService(agent, { poll: pollRunner, result: resultRunner }, handler).start();
  return service;
}

// The raw fixture includes a URL-password echo. A local_only runner's signed result
// is scrubbed before sealing; approvals bind that returned projection, not the raw echo.
// This fixture expectation is independent of the production sanitizer.
function expectedCustodyPlan(j: ShowJson): ShowJson {
  const projected = structuredClone(j);
  const before = projected.resource_changes!.find((r) => r.address === "aws_db_instance.main")!.change!.before as Record<string, unknown>;
  if (typeof before.password !== "string" || typeof before.connection_string !== "string") throw new Error("The URL-password fixture is missing.");
  const echo = `:${before.password}@`;
  if (!before.connection_string.includes(echo)) throw new Error("The URL-password fixture no longer contains the sensitive echo.");
  before.connection_string = before.connection_string.replace(echo, ":[REDACTED:url-password]@");
  return projected;
}

const normalizedDigest = (j: ShowJson): string => normalizePlan(expectedCustodyPlan(j), { configDigest: ws.configDigest, lockDigest: ws.lockDigest, addressMap: ws.addressMap }).planDigest;

describe("buildTofuRunPayload", () => {
  it("base64-encodes the files sorted by path, carries the lockfile, and the configDigest a runner will recompute", () => {
    const p = buildTofuRunPayload(ws, "plan");
    expect(p.command).toBe("plan");
    expect(p.files.map((f) => f.path)).toEqual([...p.files.map((f) => f.path)].sort());
    expect(p.files.map((f) => Buffer.from(f.contentB64, "base64").toString("utf8"))).toEqual([...ws.files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => f.content));
    expect(p.lockfile).toBe(ws.lockfile);
    expect(p.configDigest).toBe(ws.configDigest);
    expect(digestOfPayloadFiles(p.files)).toBe(p.configDigest); // the Go runner's recomputation agrees
    expect(p).not.toHaveProperty("planFileSha256");
  });

  it("reproduces the shared golden vectors (tests/tofu/fixtures/config-digest-vector.json) through the payload path", () => {
    for (const v of digestVector.vectors) {
      const files = v.files.map((f) => ({ path: f.path, content: f.content }));
      if (files.length === 0) continue; // a payload needs at least one file
      const w: TofuWorkspace = { ...ws, files, configDigest: v.configDigest, lockfile: "", lockDigest: lockDigestOf("") };
      const p = buildTofuRunPayload(w, "plan");
      expect(p.configDigest, v.name).toBe(v.configDigest);
      for (const f of p.files) expect(f.contentB64, `${v.name}: ${f.path}`).toBe(v.files.find((x) => x.path === f.path)!.contentB64);
      expect(digestOfPayloadFiles(p.files), v.name).toBe(v.configDigest);
    }
  });

  it("carries planFileSha256 for apply/show and destroy for plan only", () => {
    const sha64 = "c".repeat(64);
    expect(buildTofuRunPayload(ws, "apply", { planFileSha256: sha64 })).toMatchObject({ command: "apply", planFileSha256: sha64 });
    expect(buildTofuRunPayload(ws, "plan", { destroy: true })).toMatchObject({ command: "plan", destroy: true });
    expect(buildTofuRunPayload(ws, "plan")).not.toHaveProperty("destroy");
  });

  it("refuses a workspace whose files or lockfile no longer match its digests", () => {
    const edited: TofuWorkspace = { ...ws, files: ws.files.map((f, i) => (i === 0 ? { ...f, content: `${f.content} ` } : f)) };
    expect(() => buildTofuRunPayload(edited, "plan")).toThrow(DispatchError);
    expect(() => buildTofuRunPayload({ ...ws, lockfile: `${ws.lockfile}# edited\n` }, "plan")).toThrow(/lockfile/);
    expect(() => buildTofuRunPayload({ ...ws, files: ws.files.slice(1) }, "plan")).toThrow(/configDigest/);
    expect(configDigestOf(ws.files)).toBe(ws.configDigest);
  });
});

describe("planOnRunner", () => {
  it("runs a plan job, normalizes the returned planJson HERE, and returns a masked plan whose digest matches local normalization", async () => {
    const svc = await serve(goLikeRunner(planFixture));
    const planned = await planOnRunner(ws, await target());
    expect(planned.plan.planDigest).toBe(normalizedDigest(planFixture()));
    const rawDigest = normalizePlan(planFixture(), { configDigest: ws.configDigest, lockDigest: ws.lockDigest, addressMap: ws.addressMap }).planDigest;
    expect(planned.plan.planDigest).not.toBe(rawDigest);
    expect(() => assertApplyAllowed(planned, { approvedDigest: rawDigest, ws, runnerId: agent.id })).toThrow(TofuPlanChangedError);
    expect(plane.events.find((e) => e.type === "runner.job.completed")?.data?.custody).toEqual({ credentialMaterialSanitized: true, kinds: ["url-password"] });
    expect(planned.plan).toMatchObject({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, tofuVersion: "1.12.5" });
    expect(planned.planFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(planned).toMatchObject({ runnerId: agent.id, configDigest: ws.configDigest, exitCode: 0, output: expect.stringContaining("Plan: 1 to add") });
    // the plan job carried the PLAN capability's grant and a payload the runner accepts
    expect(svc.seen).toHaveLength(1);
    expect(svc.seen[0].claims).toMatchObject({ kind: "tofu.run", capability: "infrastructure.plan", runnerId: agent.id });
    expect(payloadOf(svc.seen[0])).toMatchObject({ command: "plan", configDigest: ws.configDigest });
    expect(planned.plan.resourceChanges.length).toBeGreaterThan(0);
  });

  it("never lets a sensitive value out: not in the returned plan, not in the stored job row", async () => {
    await serve(goLikeRunner(planFixture));
    const planned = await planOnRunner(ws, await target());
    const dump = JSON.stringify(planned);
    for (const canary of ["CANARY-DB-PASSWORD-OLD-1", "CANARY-DB-PASSWORD-NEW-2"]) {
      expect(dump, canary).not.toContain(canary);
      expect(JSON.stringify(await plane.store.jobs.listForOperation("w-a", OPERATION)), `${canary} in the store`).not.toContain(canary);
    }
    expect(dump).not.toContain("planJson");
    expect(dump).toContain("(sensitive)");
  });

  it("the plan digest moves when a sensitive value changes (the fingerprint survives the runner hop)", async () => {
    const changed = planFixture();
    const rc = changed.resource_changes!.find((r) => r.address === "aws_db_instance.main")!;
    (rc.change!.after as Record<string, unknown>).password = "CANARY-DB-PASSWORD-ROTATED-3";
    await serve(goLikeRunner(() => changed));
    const planned = await planOnRunner(ws, await target());
    expect(planned.plan.planDigest).toBe(normalizedDigest(changed));
    expect(planned.plan.planDigest).not.toBe(normalizedDigest(planFixture()));
  });

  it("refuses a plan result the control plane cannot apply or read", async () => {
    for (const result of [{ planJson: planFixture() }, { planFileSha256: "not-a-digest", planJson: planFixture() }, { planFileSha256: "d".repeat(64) }, { planFileSha256: "d".repeat(64), planJson: [] }]) {
      await service?.stop();
      await serve(async () => ({ status: "succeeded", result: { command: "plan", exitCode: 0, output: "", ...result } }));
      await expect(planOnRunner(ws, await target())).rejects.toBeInstanceOf(DispatchError);
    }
    await service?.stop();
    const errored = { ...planFixture(), errored: true };
    await serve(async () => ({ status: "succeeded", result: { command: "plan", exitCode: 0, output: "", planFileSha256: "d".repeat(64), planJson: errored } }));
    await expect(planOnRunner(ws, await target())).rejects.toBeInstanceOf(TofuPlanFormatError);
  });

  it("a failed or rejected plan job throws a typed, non-uncertain error that carries the runner's redacted output", async () => {
    await serve(async () => ({ status: "failed", exitCode: 1, error: "tofu plan failed (exit 1)", result: { command: "plan", exitCode: 1, output: "Error: provider download failed" } }));
    const err = await planOnRunner(ws, await target()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJobError);
    expect(err).toMatchObject({ code: "runner_job_failed", uncertain: false });
    expect((err as RunnerJobError).awaited.result).toMatchObject({ output: expect.stringContaining("provider download failed") });
  });
});

describe("the apply guard", () => {
  const sha64 = "e".repeat(64);
  const planned = async (over: Partial<RunnerPlanResult> = {}): Promise<RunnerPlanResult> => {
    const plan = normalizePlan(planFixture(), { configDigest: ws.configDigest, lockDigest: ws.lockDigest, addressMap: ws.addressMap });
    return { plan, planFileSha256: sha64, runnerId: agent.id, configDigest: ws.configDigest, jobId: "job_1", exitCode: 0, output: "", ...over };
  };

  it("allows an apply only for this workspace, this runner, a well-formed plan file hash and the approved digest", async () => {
    const p = await planned();
    expect(() => assertApplyAllowed(p, { approvedDigest: p.plan.planDigest, ws, runnerId: agent.id })).not.toThrow();
  });

  it("throws TofuPlanChangedError when the digest moved, naming both digests", async () => {
    const p = await planned();
    try {
      assertApplyAllowed(p, { approvedDigest: "f".repeat(64), ws, runnerId: agent.id });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TofuPlanChangedError);
      expect(e).toMatchObject({ code: "plan_changed", approvedDigest: "f".repeat(64), currentDigest: p.plan.planDigest });
    }
  });

  it("refuses a plan from another runner, for another configuration, or with a malformed plan file hash", async () => {
    const p = await planned();
    const args = { approvedDigest: p.plan.planDigest, ws, runnerId: agent.id };
    expect(() => assertApplyAllowed({ ...p, runnerId: "run_other" }, args)).toThrow(/another runner/);
    expect(() => assertApplyAllowed({ ...p, configDigest: "0".repeat(64) }, args)).toThrow(/different workspace/);
    expect(() => assertApplyAllowed({ ...p, plan: { ...p.plan, configDigest: "0".repeat(64) } }, args)).toThrow(/different workspace/);
    for (const bad of ["", "xyz", sha64.toUpperCase(), sha64.slice(1)]) expect(() => assertApplyAllowed({ ...p, planFileSha256: bad }, args)).toThrow(/planFileSha256/);
  });
});

describe("applyVerifiedOnRunner", () => {
  it("plans afresh, compares digests, then applies exactly that plan file — two jobs, each with its own capability's grant", async () => {
    const svc = await serve(goLikeRunner(planFixture));
    const approved = normalizedDigest(planFixture());
    const applied = await applyVerifiedOnRunner(ws, { ...(await target()), approvedDigest: approved });
    expect(applied).toMatchObject({ exitCode: 0, output: expect.stringContaining("Apply complete!") });
    expect(applied.plan.planDigest).toBe(approved);
    expect(svc.seen.map((j) => [payloadOf(j).command, j.claims.capability])).toEqual([
      ["plan", "infrastructure.plan"],
      ["apply", "infrastructure.apply"],
    ]);
    // the apply names the plan file THE FRESH PLAN returned, and the workspace it was made for
    const planResult = (await plane.store.jobs.get("w-a", svc.seen[0].claims.jti))!;
    expect(planResult.status).toBe("succeeded");
    const applyPayload = payloadOf(svc.seen[1]);
    expect(applyPayload).toMatchObject({ command: "apply", configDigest: ws.configDigest });
    expect(applyPayload.planFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(applied.planJobId).toBe(svc.seen[0].claims.jti);
    expect(applied.applyJobId).toBe(svc.seen[1].claims.jti);
  });

  it("applies NOTHING when the plan moved since approval: a new approval is required, and no apply job exists", async () => {
    let n = 0;
    const moved = planFixture();
    (moved.resource_changes![1].change!.after as Record<string, unknown>).desired_count = 7; // the ECS service now scales differently
    const svc = await serve(goLikeRunner(() => (++n === 1 ? planFixture() : moved)));
    const approved = normalizedDigest(planFixture());
    // first fresh plan matches the approval...
    await applyVerifiedOnRunner(ws, { ...(await target()), approvedDigest: approved });
    // ...the second plan (the world moved) does not
    const err = await applyVerifiedOnRunner(ws, { ...(await target()), approvedDigest: approved }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TofuPlanChangedError);
    expect(err).toMatchObject({ approvedDigest: approved, currentDigest: normalizedDigest(moved) });
    const commands = svc.seen.map((j) => payloadOf(j).command);
    expect(commands).toEqual(["plan", "apply", "plan"]); // the refused attempt issued ONLY a plan
    expect((await plane.store.jobs.listForOperation("w-a", OPERATION)).filter((j) => j.kind === "tofu.run")).toHaveLength(3);
  });

  it("an apply with an unknown outcome is uncertain: it throws a RunnerJobError marked uncertain and is never retried", async () => {
    const svc = await serve(goLikeRunner(planFixture, { apply: { status: "timed_out", error: "the job exceeded its 60s timeout" } }));
    const err = await applyVerifiedOnRunner(ws, { ...(await target()), approvedDigest: normalizedDigest(planFixture()) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJobError);
    expect(err).toMatchObject({ code: "runner_job_uncertain", uncertain: true });
    expect(svc.seen.map((j) => payloadOf(j).command)).toEqual(["plan", "apply"]);
    // nothing re-dispatched the apply
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.seen.map((j) => payloadOf(j).command)).toEqual(["plan", "apply"]);
  });

  it("a failed apply is a definite failure, not uncertain", async () => {
    await serve(goLikeRunner(planFixture, { apply: { status: "failed", exitCode: 1, error: "tofu apply failed (exit 1)", result: { command: "apply", exitCode: 1, output: "Error: creating resource" } } }));
    const err = await applyVerifiedOnRunner(ws, { ...(await target()), approvedDigest: normalizedDigest(planFixture()) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "runner_job_failed", uncertain: false });
  });

  it("the runner itself refuses an apply it has no retained plan for (the guard's second line)", async () => {
    // a runner that "lost" its plan file (restart, expiry, or another runner's plan): it rejects; the control plane reports it, never retries
    const svc = await serve(async (job) => {
      const p = payloadOf(job);
      if (p.command === "plan") return { status: "succeeded", exitCode: 0, result: { exitCode: 0, output: "", planJson: planFixture(), planFileSha256: sha("x") } };
      return { status: "rejected", error: "not_allowed: no retained plan file for this configDigest and planFileSha256", result: { reason: "not_allowed" } };
    });
    const err = await applyVerifiedOnRunner(ws, { ...(await target()), approvedDigest: normalizedDigest(planFixture()) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "runner_job_rejected", uncertain: false });
    expect(svc.seen.map((j) => payloadOf(j).command)).toEqual(["plan", "apply"]);
  });

  it("destroy applies to the fresh plan only, never to the apply (the apply runs the retained file)", async () => {
    const svc = await serve(goLikeRunner(planFixture));
    await applyVerifiedOnRunner(ws, { ...(await target()), approvedDigest: normalizedDigest(planFixture()), destroy: true });
    expect(payloadOf(svc.seen[0])).toMatchObject({ command: "plan", destroy: true });
    expect(payloadOf(svc.seen[1])).not.toHaveProperty("destroy");
  });
});
