/** Real HTTP wrapper, broker and PGlite. Identity and workflow signal transport are explicit fakes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDataDir } from "../_support/data-dir";
import type { Harness } from "../capabilities/support";

tempDataDir("zenith-plan-approval-http-", { fast: true });
const { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, user, sessionFor } = await import("../capabilities/support");
const { makePlan } = await import("../execution/fakes/fixtures");
const { planEvidence } = await import("@/lib/execution/plan-evidence");
const { buildPlanFacts } = await import("@/lib/capabilities/evaluate");
const { createOperationsPort } = await import("@/lib/execution/platform");
const { repos } = await import("@/lib/controlplane/db");
const { resetDb } = await import("@/lib/db/store");
const { setPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
closeSharedPgliteAfterAll();
const identity = vi.hoisted(() => ({ id: "erin" }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...await original<typeof import("@/lib/supabase/env")>(), isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: identity.id, name: identity.id, email: `${identity.id}@zenith.test` }) }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => ({ subject: identity.id, email: `${identity.id}@zenith.test`, emailVerified: true }) }));

const { POST: approve } = await import("@/app/api/platform/v1/operations/[id]/approve/route");
const { POST: reject } = await import("@/app/api/platform/v1/operations/[id]/reject/route");
const { GET: detail } = await import("@/app/api/platform/v1/operations/[id]/route");
const plan = makePlan();
let h: Harness, op: { id: string; proposalDigest: string };
const signal = vi.fn(async (_id: string): Promise<{ delivered: true }> => ({ delivered: true }));
const refusedHeaders: Record<string, string>[] = [{ authorization: "Bearer integration" }, { authorization: "" }, { "x-zenith-actor": "navigator" }, { origin: "https://evil.test" }];

beforeEach(async () => {
  identity.id = "erin"; signal.mockReset(); signal.mockResolvedValue({ delivered: true });
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  h = await makeHarness({ kind: "pglite", engine: scriptedEngine("http-plan", () => requireApproval(1, "admin", true)) });
  setPlatformBrokerForTests(h.broker);
  setBridgeDepsForTests({ workflows: { startDeploy: async () => ({}), signalApproval: signal, cancelOperation: async () => ({ delivered: false, reason: "not_found" }) } });
  resetDb({ workspaces: [{ id: h.ids.wsA, name: "Atlas", slug: "atlas", createdAt: new Date().toISOString() }], members: ["alice", "erin"].map((id) => ({ id, workspaceId: h.ids.wsA, role: "admin" as const, name: id, email: `${id}@zenith.test` })) });
  op = (await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, input: {} }, user("alice"))).operation;
  await h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
  await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
  const evidence = planEvidence({ plan, facts: buildPlanFacts(plan)!, cost: {}, graphDigest: "a".repeat(64), stage: "plan" });
  await repos.evidence.insert(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary: evidence.summary, simulated: false });
  const ports = createOperationsPort(h.db!);
  await ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: plan.planDigest });
  await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "awaiting_approval" });
});
afterEach(() => { setPlatformBrokerForTests(null); setBridgeDepsForTests(null); vi.unstubAllEnvs(); });

function call(handler: typeof approve, body: unknown, headers: Record<string, string> = {}) {
  return handler(new NextRequest(`https://zenith.test/api/platform/v1/operations/${op.id}/approve`, { method: "POST", headers: { "content-type": "application/json", origin: "https://zenith.test", cookie: `zenith-workspace=${h.ids.wsA}`, ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: op.id }) });
}
describe("plan gate over browser REST", () => {
  it("GET returns the authoritative review, and a browser approves the reviewed digest in round one and signals", async () => {
    const read = await detail(new NextRequest(`https://zenith.test/api/platform/v1/operations/${op.id}`, { headers: { cookie: `zenith-workspace=${h.ids.wsA}` } }), { params: Promise.resolve({ id: op.id }) });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ operation: { approvalRound: 1 }, planReview: { planDigest: plan.planDigest, view: { planDigest: plan.planDigest }, cost: {}, decision: { outcome: "require_approval" } } });
    const reply = await call(approve, { proposalDigest: op.proposalDigest, planDigest: plan.planDigest });
    expect(reply.status).toBe(200); expect(await reply.json()).toMatchObject({ operation: { status: "approved", approvalRound: 1 }, signal: { delivered: true } });
    expect(signal).toHaveBeenCalledExactlyOnceWith(op.id);
  });
  it.each([undefined, "f".repeat(64)])("refuses the missing or stale digest %s without recording a plan approval or signalling", async (planDigest) => {
    const reply = await call(approve, { proposalDigest: op.proposalDigest, planDigest });
    expect(reply.status).toBe(409); expect(await reply.json()).toMatchObject({ error: { code: "digest_mismatch" } });
    expect(await h.store.listApprovals(h.ids.wsA, op.id)).toHaveLength(1); expect(signal).not.toHaveBeenCalled();
  });
  it.each(refusedHeaders)("refuses non-browser approval %j at a concrete plan gate", async (headers) => {
    const reply = await call(approve, { proposalDigest: op.proposalDigest, planDigest: plan.planDigest }, headers);
    expect(reply.status).toBe(403); expect(await h.store.listApprovals(h.ids.wsA, op.id)).toHaveLength(1); expect(signal).not.toHaveBeenCalled();
  });
  it("rejects without a readable plan digest and wakes the workflow", async () => {
    const reply = await call(reject, { proposalDigest: op.proposalDigest });
    expect(reply.status).toBe(200); expect(await reply.json()).toMatchObject({ operation: { status: "rejected" }, signal: { delivered: true } });
    expect(signal).toHaveBeenCalledExactlyOnceWith(op.id);
  });
  it("reports delivery failure without pretending the persisted approval failed or leaking transport errors", async () => {
    signal.mockRejectedValueOnce(new Error("TRANSPORT-SECRET-CANARY"));
    const reply = await call(approve, { proposalDigest: op.proposalDigest, planDigest: plan.planDigest });
    expect(reply.status).toBe(200); const body = await reply.json();
    expect(body).toMatchObject({ operation: { status: "approved" }, signal: { delivered: false, reason: "unavailable" } });
    expect(JSON.stringify(body)).not.toContain("TRANSPORT-SECRET-CANARY");
  });
});
