/**
 * PROD-MACH-03 direct REST joins: real HTTP/browser/principal guards, runbook
 * service, memory store and runtime Ed25519 signatures. External identity,
 * credential verification, boot/admission and composition are explicit test
 * adapters. No server, scheduler, machine step or provider is started here.
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Principal } from "@/lib/controlplane/types";
import type { PlatformRunbooks } from "@/lib/platform/runbooks";
import type { RunbookAction, RunbookRunRecord, RunbookScheduleRecord, RunbookVersionRecord } from "@/lib/machines/runbooks";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-runbook-routes-", { fast: true });
process.env.ZENITH_STORE = "file";
const adapters = vi.hoisted(() => ({
  platform: undefined as PlatformRunbooks | undefined,
  userId: "alice", liveSubject: "alice", emailVerified: true, identityUnavailable: false,
  token: "", scopes: ["read", "write"],
  verifyCredential: vi.fn<(header: string) => Promise<{ id: string; workspaceId: string; subject: string; label: string }>>(),
}));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...await original<typeof import("@/lib/supabase/env")>(), isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: adapters.userId, name: adapters.userId, email: `${adapters.userId}@zenith.test` }) }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => {
  if (adapters.identityUnavailable) throw new Error("identity adapter unavailable");
  return { subject: adapters.liveSubject, email: `${adapters.liveSubject}@zenith.test`, emailVerified: adapters.emailVerified };
} }));
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => ({ verify: adapters.verifyCredential }) }));
vi.mock("@/lib/platform/runbooks", () => ({ platformRunbooks: async () => {
  if (!adapters.platform) throw new Error("test composition absent");
  return adapters.platform;
} }));

const { resetDb } = await import("@/lib/db/store");
const { BrokerError } = await import("@/lib/capabilities/errors");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { MemoryRunbookStore, createRunbookService, verifyRunbookVersion, verifyAuditChain } = await import("@/lib/machines/runbooks");
const { POST: publish, GET: listRunbooks } = await import("@/app/api/platform/v1/runbooks/route");
const { POST: requestRun } = await import("@/app/api/platform/v1/runbooks/[id]/runs/route");
const { POST: createSchedule } = await import("@/app/api/platform/v1/runbooks/[id]/schedules/route");
const { POST: approveRun } = await import("@/app/api/platform/v1/runbooks/runs/[id]/approve/route");
const { POST: cancelRun } = await import("@/app/api/platform/v1/runbooks/runs/[id]/cancel/route");
const { GET: readRun } = await import("@/app/api/platform/v1/runbooks/runs/[id]/route");
const { GET: listRuns } = await import("@/app/api/platform/v1/runbooks/runs/route");
const { GET: listSchedules } = await import("@/app/api/platform/v1/runbooks/schedules/route");
const { POST: approveSchedule } = await import("@/app/api/platform/v1/runbooks/schedules/[id]/approve/route");
const { POST: scheduleState } = await import("@/app/api/platform/v1/runbooks/schedules/[id]/state/route");

const WS = "ws-route-a", OTHER = "ws-route-b";
const T0 = Date.UTC(2026, 9, 5, 2, 0, 0);
const TARGET = { transport: "zenithd", targetId: "machine-a", resourceId: "resource-a", environmentId: "environment-a" };
const DEFINITION = { schemaVersion: 1, name: "Restart approved service", steps: [{ id: "restart", title: "Restart", operation: "machine.service.restart", args: { unit: "fixture.service" } }] };
const SPEC = { cadence: { kind: "interval", everySec: 600, anchor: new Date(T0).toISOString() }, windows: [{ days: [1], startMinute: 120, endMinute: 240 }], maxRunDurationSec: 300, maxParallelTargets: 1 };
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Options = { method?: "GET" | "POST"; workspace?: string; headers?: Record<string, string>; raw?: string };
let store: InstanceType<typeof MemoryRunbookStore>, service: ReturnType<typeof createRunbookService>, signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
let clock: number;
let approvalWrites: MockInstance<InstanceType<typeof MemoryRunbookStore>["insertApproval"]>;

beforeEach(async () => {
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  adapters.userId = adapters.liveSubject = "alice"; adapters.emailVerified = true; adapters.identityUnavailable = false;
  adapters.token = `za_${randomBytes(24).toString("hex")}`; adapters.scopes = ["read", "write"];
  adapters.verifyCredential.mockReset();
  adapters.verifyCredential.mockImplementation(async (header) => {
    if (header !== `Bearer ${adapters.token}`) throw new BrokerError("unauthenticated", "Present a valid integration credential.");
    return { id: "integration-a", workspaceId: WS, subject: "alice", label: "Route fixture" };
  });
  resetDb({ workspaces: [WS, OTHER].map((id) => ({ id, name: id, slug: id, createdAt: new Date(T0).toISOString() })), members: [
    ...["alice", "erin", "viewer"].map((id) => ({ id, workspaceId: WS, role: id === "viewer" ? "viewer" as const : "admin" as const, name: id, email: `${id}@zenith.test` })),
    { id: "bob", workspaceId: OTHER, role: "admin", name: "bob", email: "bob@zenith.test" },
  ] });
  clock = T0; store = new MemoryRunbookStore();
  const key = await generateSigningJwk("EdDSA"); signer = LocalJwkSigner.fromJwk("runbook-route-runtime", key.privateJwk, { alg: "EdDSA" });
  // Explicit scoped role adapter, matching composition's action thresholds.
  // Integration scope checks remain separate from its accountable human role.
  const required: Record<RunbookAction, number> = { read: 0, publish: 1, request: 1, schedule: 1, cancel: 1, approve: 2 };
  service = createRunbookService({ store, signer, verificationKeys: async () => [signer.publicJwk()], allowedTransports: ["zenithd"], now: () => new Date(clock), authorize: async (p: Principal, workspaceId, action) => {
    const human = p.onBehalfOf ?? p.id;
    const rank = workspaceId === WS && ["alice", "erin"].includes(human) || workspaceId === OTHER && human === "bob" ? 2 : workspaceId === WS && human === "viewer" ? 0 : -1;
    return rank >= required[action] && (p.kind !== "integration" || adapters.scopes.includes(action === "read" ? "read" : "write"));
  } });
  adapters.platform = { store, service, executeDueRuns: async () => { throw new Error("route tests must not execute machine steps"); } };
  approvalWrites = vi.spyOn(store, "insertApproval");
});
afterEach(() => { adapters.platform = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function human(id: string) { adapters.userId = adapters.liveSubject = id; }
function call(handler: Handler, pathname: string, body?: unknown, options: Options = {}) {
  const method = options.method ?? "POST", workspace = options.workspace ?? WS;
  return handler(new NextRequest(`https://zenith.test/api/platform/v1/runbooks${pathname}`, { method,
    headers: { "content-type": "application/json", origin: "https://zenith.test", "sec-fetch-site": "same-origin", cookie: `zenith-workspace=${workspace}`, "x-zenith-workspace": workspace, ...options.headers },
    ...(method === "POST" ? { body: options.raw ?? JSON.stringify(body ?? {}) } : {}),
  }), { params: Promise.resolve({ id: pathname.split("/").filter(Boolean).find((part) => !["runs", "schedules"].includes(part)) ?? "" }) });
}
async function published(workspace = WS) {
  const response = await call(publish, "", { runbookId: "restart", definition: DEFINITION }, { workspace }); expect(response.status).toBe(201);
  return (await response.json() as { version: RunbookVersionRecord }).version;
}
async function requested(headers: Record<string, string> = {}, workspace = WS) {
  const response = await call(requestRun, "/restart/runs", { targets: [TARGET], maxRunDurationSec: 300 }, { headers, workspace }); expect(response.status).toBe(201);
  return (await response.json() as { run: RunbookRunRecord }).run;
}
async function scheduled(headers: Record<string, string> = {}, workspace = WS) {
  const response = await call(createSchedule, "/restart/schedules", { targets: [TARGET], spec: SPEC }, { headers, workspace }); expect(response.status).toBe(201);
  return (await response.json() as { schedule: RunbookScheduleRecord }).schedule;
}
async function snapshot() {
  return Promise.all([WS, OTHER].map(async (workspaceId) => {
    const [versions, runs, schedules] = await Promise.all([store.listRunbooks(workspaceId, 200), store.listRuns(workspaceId, 200), store.listSchedules(workspaceId, 200)]);
    const subjects = [...versions.map((v) => `runbook:${v.runbookId}`), ...runs.map((r) => `run:${r.id}`), ...schedules.map((s) => `schedule:${s.id}`)];
    return { workspaceId, versions, runs, schedules, audit: await Promise.all(subjects.map((subject) => store.listAudit(workspaceId, subject))) };
  }));
}
async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json(); expect(body).toMatchObject({ error: { code } }); return body;
}

describe("runbook route joins with real signing and service custody", () => {
  it("publishes signed immutable versions through the browser and lists only the caller workspace", async () => {
    const first = await published(); const second = await published();
    expect([first.version, second.version]).toEqual([1, 2]); expect(first.signature).not.toBe(second.signature);
    for (const version of [first, second]) await expect(verifyRunbookVersion({ workspaceId: WS, runbookId: version.runbookId, version: version.version, definition: version.definition, signature: version.signature }, [signer.publicJwk()])).resolves.toMatchObject({ ver: version.version, dig: version.definitionDigest });
    expect(await store.getVersion(WS, "restart", 1)).toEqual(first);
    human("bob"); const foreign = await published(OTHER); human("alice");
    const response = await call(listRunbooks, "", undefined, { method: "GET" }); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runbooks: [second] }); expect(await store.getVersion(OTHER, "restart", 1)).toEqual(foreign);
    const audit = await store.listAudit(WS, "runbook:restart"); expect(audit.map((row) => row.event)).toEqual(["runbook.published", "runbook.published"]); expect(verifyAuditChain(audit)).toBe(true);
  });

  it.each([
    ["bearer", { authorization: "Bearer integration" }], ["empty authorization", { authorization: "" }],
    ["navigator", { "x-zenith-actor": "navigator" }], ["actor key", { "x-zenith-actor-key": "caller" }],
    ["foreign origin", { origin: "https://other.test" }], ["cross-site", { "sec-fetch-site": "cross-site" }],
  ] as const)("refuses %s publishing before signed version or audit effects", async (_name, headers) => {
    await refused(await call(publish, "", { runbookId: "restart", definition: DEFINITION }, { headers }), 403, "browser_session_required");
    expect(await store.latestVersion(WS, "restart")).toBeNull(); expect(await store.listAudit(WS, "runbook:restart")).toEqual([]);
    expect(adapters.verifyCredential).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "mismatch", "unverified"] as const)("refuses %s live browser identity before publishing", async (mode) => {
    if (mode === "unavailable") adapters.identityUnavailable = true;
    if (mode === "mismatch") adapters.liveSubject = "erin";
    if (mode === "unverified") adapters.emailVerified = false;
    await refused(await call(publish, "", { runbookId: "restart", definition: DEFINITION }), mode === "unavailable" ? 503 : 401, mode === "unavailable" ? "policy_unavailable" : "unauthenticated");
    expect(await store.latestVersion(WS, "restart")).toBeNull(); expect(await store.listAudit(WS, "runbook:restart")).toEqual([]);
  });

  it("binds an integration-requested run to its accountable owner and an independent browser approval", async () => {
    const version = await published(); const run = await requested({ authorization: `Bearer ${adapters.token}` });
    expect(run).toMatchObject({ workspaceId: WS, status: "pending_approval", version: 1, definitionDigest: version.definitionDigest, requestedBy: "user:alice", requester: { kind: "integration", id: "integration-a", onBehalfOf: "alice" } });
    expect(adapters.verifyCredential).toHaveBeenCalledTimes(2);
    human("erin"); const before = await snapshot();
    await refused(await call(approveRun, `/runs/${run.id}/approve`, { bindingDigest: "f".repeat(64) }), 409, "digest_mismatch");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled();
    const response = await call(approveRun, `/runs/${run.id}/approve`, { bindingDigest: run.bindingDigest, ttlSec: 600 }); expect(response.status).toBe(200);
    const approved = (await response.json() as { run: RunbookRunRecord }).run; expect(approved).toEqual({ ...run, status: "approved" });
    const approval = await store.findValidApproval(WS, run.bindingDigest, new Date(clock));
    expect(approval).toMatchObject({ workspaceId: WS, bindingDigest: run.bindingDigest, requestedBy: "user:alice", approverId: "user:erin", expiresAt: run.deadlineAt });
    const audit = await store.listAudit(WS, `run:${run.id}`); expect(audit.map((row) => row.event)).toEqual(["run.requested", "run.approved"]); expect(verifyAuditChain(audit)).toBe(true);
    expect(await store.listSteps(WS, run.id)).toEqual([]);
  });

  it.each(["human", "integration owner"] as const)("refuses requester self-approval for a %s request without effects", async (mode) => {
    await published(); const run = await requested(mode === "human" ? {} : { authorization: `Bearer ${adapters.token}` }); const before = await snapshot();
    await refused(await call(approveRun, `/runs/${run.id}/approve`, { bindingDigest: run.bindingDigest }), 403, "role_insufficient");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled(); expect(await store.findValidApproval(WS, run.bindingDigest, new Date(clock))).toBeNull();
  });

  it.each(["run", "schedule"] as const)("refuses integration approval of a pending %s with no approval or transition", async (kind) => {
    await published(); const current = kind === "run" ? await requested() : await scheduled(); const before = await snapshot();
    await refused(await call(kind === "run" ? approveRun : approveSchedule, `/${kind === "run" ? "runs" : "schedules"}/${current.id}/approve`, { bindingDigest: current.bindingDigest }, { headers: { authorization: `Bearer ${adapters.token}` } }), 403, "browser_session_required");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled(); expect(adapters.verifyCredential).not.toHaveBeenCalled();
  });

  it("requires the reviewed schedule digest before activation and keeps pause, resume and cancellation scoped", async () => {
    await published(); const schedule = await scheduled({ authorization: `Bearer ${adapters.token}` }); expect(schedule.status).toBe("pending_approval");
    human("erin"); const before = await snapshot();
    await refused(await call(approveSchedule, `/schedules/${schedule.id}/approve`, { bindingDigest: "f".repeat(64) }), 409, "digest_mismatch");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled();
    const response = await call(approveSchedule, `/schedules/${schedule.id}/approve`, { bindingDigest: schedule.bindingDigest, ttlSec: 600 }); expect(response.status).toBe(200);
    expect((await response.json()).schedule).toMatchObject({ ...schedule, status: "active", nextDueAt: new Date(T0 + 600_000).toISOString() });
    for (const state of ["paused", "active", "cancelled"] as const) {
      const changed = await call(scheduleState, `/schedules/${schedule.id}/state`, { state }, { headers: { authorization: `Bearer ${adapters.token}` } }); expect(changed.status).toBe(200); expect(await changed.json()).toEqual({ state });
      expect((await store.getSchedule(WS, schedule.id))?.status).toBe(state);
    }
    const audit = await store.listAudit(WS, `schedule:${schedule.id}`); expect(audit.map((row) => row.event)).toEqual(["schedule.created", "schedule.approved", "schedule.paused", "schedule.active", "schedule.cancelled"]); expect(verifyAuditChain(audit)).toBe(true);
    expect(await store.listRuns(WS, 200)).toEqual([]);
  });

  it("refuses a schedule creator's self-approval and caps raw-exec browser approval at 24 hours", async () => {
    const raw = { schemaVersion: 1, name: "Explicit escape hatch", steps: [{ id: "command", title: "Command", operation: "machine.exec", args: { argv: ["echo", "approved-maintenance"], timeoutSec: 10 }, timeoutSec: 10 }] };
    expect((await call(publish, "", { runbookId: "restart", definition: raw })).status).toBe(201);
    const schedule = await scheduled(); const before = await snapshot();
    await refused(await call(approveSchedule, `/schedules/${schedule.id}/approve`, { bindingDigest: schedule.bindingDigest }), 403, "role_insufficient");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled();
    human("erin"); expect((await call(approveSchedule, `/schedules/${schedule.id}/approve`, { bindingDigest: schedule.bindingDigest, ttlSec: 7 * 86400 })).status).toBe(200);
    expect((await store.findValidApproval(WS, schedule.bindingDigest, new Date(clock)))?.expiresAt).toBe(new Date(T0 + 86400_000).toISOString());
    expect(await store.listRuns(WS, 200)).toEqual([]); expect(verifyAuditChain(await store.listAudit(WS, `schedule:${schedule.id}`))).toBe(true);
  });

  it("reads run custody and audit without writes, then cancellation records one real terminal transition", async () => {
    await published(); const run = await requested(); const before = await snapshot();
    const read = await call(readRun, `/runs/${run.id}`, undefined, { method: "GET", headers: { authorization: `Bearer ${adapters.token}` } }); expect(read.status).toBe(200);
    const body = await read.json(); expect(body.run).toEqual(run); expect(body.steps).toEqual([]); expect(verifyAuditChain(body.audit)).toBe(true); expect(await snapshot()).toEqual(before);
    const response = await call(cancelRun, `/runs/${run.id}/cancel`, { reason: "operator stop" }, { headers: { authorization: `Bearer ${adapters.token}` } }); expect(response.status).toBe(200);
    const cancelled = (await response.json()).run; expect(cancelled).toMatchObject({ ...run, status: "cancelled", cancelReason: "operator stop", cancelRequestedAt: new Date(T0).toISOString(), finishedAt: new Date(T0).toISOString() });
    expect(await store.getRun(WS, run.id)).toEqual(cancelled); expect(await store.listSteps(WS, run.id)).toEqual([]);
    expect((await store.listAudit(WS, `run:${run.id}`)).map((row) => row.event)).toEqual(["run.requested", "run.cancel_requested"]);
    const listed = await call(listRuns, "/runs?status=cancelled", undefined, { method: "GET" }); expect(await listed.json()).toEqual({ runs: [cancelled] });
  });

  it("lists only workspace runs and schedules for a read-scoped integration and refuses its mutation", async () => {
    await published(); const run = await requested(); const schedule = await scheduled();
    human("bob"); await published(OTHER); const foreignRun = await requested({}, OTHER); const foreignSchedule = await scheduled({}, OTHER); human("alice"); adapters.scopes = ["read"];
    const headers = { authorization: `Bearer ${adapters.token}` }, before = await snapshot();
    for (const [handler, pathname, expected] of [[listRuns, "/runs", { runs: [run] }], [listSchedules, "/schedules", { schedules: [schedule] }]] as const) {
      const response = await call(handler, pathname, undefined, { method: "GET", headers }); expect(response.status).toBe(200); expect(await response.json()).toEqual(expected);
    }
    await refused(await call(cancelRun, `/runs/${run.id}/cancel`, {}, { headers }), 403, "role_insufficient");
    expect(await snapshot()).toEqual(before); expect(await store.getRun(OTHER, foreignRun.id)).toEqual(foreignRun); expect(await store.getSchedule(OTHER, foreignSchedule.id)).toEqual(foreignSchedule);
  });

  it.each(["read", "approve", "cancel", "schedule approval", "schedule state", "run request", "schedule request"] as const)("makes foreign and missing %s identifiers indistinguishable without effects", async (kind) => {
    await published(); human("bob"); await published(OTHER); const run = await requested({}, OTHER), schedule = await scheduled({}, OTHER); human("erin");
    const before = await snapshot();
    const invoke = (id: string) => {
      if (kind === "read") return call(readRun, `/runs/${id}`, undefined, { method: "GET" });
      if (kind === "approve") return call(approveRun, `/runs/${id}/approve`, { bindingDigest: run.bindingDigest });
      if (kind === "cancel") return call(cancelRun, `/runs/${id}/cancel`, {});
      if (kind === "schedule approval") return call(approveSchedule, `/schedules/${id}/approve`, { bindingDigest: schedule.bindingDigest });
      if (kind === "schedule state") return call(scheduleState, `/schedules/${id}/state`, { state: "paused" });
      if (kind === "run request") return call(requestRun, `/${id}/runs`, { targets: [TARGET] });
      return call(createSchedule, `/${id}/schedules`, { targets: [TARGET], spec: SPEC });
    };
    // Runbook ids exist only in OTHER for these two request comparisons.
    if (kind === "run request" || kind === "schedule request") {
      human("bob"); expect((await call(publish, "", { runbookId: "foreign-only", definition: DEFINITION }, { workspace: OTHER })).status).toBe(201); human("erin");
    }
    const baseline = kind.endsWith("request") ? await snapshot() : before;
    const foreign = await invoke(kind.endsWith("request") ? "foreign-only" : kind.startsWith("schedule") ? schedule.id : run.id), missing = await invoke("missing-id");
    expect(foreign.status).toBe(["cancel", "schedule state"].includes(kind) ? 409 : 404); expect(missing.status).toBe(foreign.status); expect(await foreign.json()).toEqual(await missing.json());
    expect(await snapshot()).toEqual(baseline); expect(approvalWrites).not.toHaveBeenCalled();
  });

  it("refuses a valid credential naming a different workspace and an unverified credential before effects", async () => {
    await published(); const before = await snapshot();
    await refused(await call(requestRun, "/restart/runs", { targets: [TARGET] }, { workspace: OTHER, headers: { authorization: `Bearer ${adapters.token}` } }), 404, "not_found");
    await refused(await call(requestRun, "/restart/runs", { targets: [TARGET] }, { headers: { authorization: "Bearer invalid" } }), 401, "unauthenticated");
    expect(await snapshot()).toEqual(before); expect(await store.listRuns(WS, 200)).toEqual([]);
  });

  it("lets a scoped viewer read but refuses publish, request and approval effects", async () => {
    await published(); const run = await requested(); human("viewer"); const before = await snapshot();
    expect((await call(readRun, `/runs/${run.id}`, undefined, { method: "GET" })).status).toBe(200);
    for (const [handler, pathname, body] of [[publish, "", { runbookId: "restart", definition: DEFINITION }], [requestRun, "/restart/runs", { targets: [TARGET] }], [approveRun, `/runs/${run.id}/approve`, { bindingDigest: run.bindingDigest }]] as const) await refused(await call(handler, pathname, body), 403, "role_insufficient");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled();
  });

  it("refuses approval after the real run deadline without inserting an approval or changing custody", async () => {
    await published(); const run = await requested(); human("erin"); clock = Date.parse(run.deadlineAt); const before = await snapshot();
    await refused(await call(approveRun, `/runs/${run.id}/approve`, { bindingDigest: run.bindingDigest }), 409, "invalid_state");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled();
  });

  it.each(["publish extra", "definition extra", "run extra", "schedule extra", "run approval extra", "schedule approval extra", "approval ttl", "cancel extra", "state extra", "state value", "malformed JSON", "oversized body", "invalid status"] as const)("rejects strict %s input without mutation or submitted-value leakage", async (mode) => {
    await published(); const run = await requested(), schedule = await scheduled(); human("erin"); const before = await snapshot();
    let response: Response;
    const unknown = { unexpected: "BODY-VALUE-CANARY" };
    switch (mode) {
      case "publish extra": response = await call(publish, "", { runbookId: "restart", definition: DEFINITION, ...unknown }); break;
      case "definition extra": response = await call(publish, "", { runbookId: "restart", definition: { ...DEFINITION, ...unknown } }); break;
      case "run extra": response = await call(requestRun, "/restart/runs", { targets: [TARGET], ...unknown }); break;
      case "schedule extra": response = await call(createSchedule, "/restart/schedules", { targets: [TARGET], spec: SPEC, ...unknown }); break;
      case "run approval extra": response = await call(approveRun, `/runs/${run.id}/approve`, { bindingDigest: run.bindingDigest, ...unknown }); break;
      case "schedule approval extra": response = await call(approveSchedule, `/schedules/${schedule.id}/approve`, { bindingDigest: schedule.bindingDigest, ...unknown }); break;
      case "approval ttl": response = await call(approveRun, `/runs/${run.id}/approve`, { bindingDigest: run.bindingDigest, ttlSec: "BODY-VALUE-CANARY" }); break;
      case "cancel extra": response = await call(cancelRun, `/runs/${run.id}/cancel`, unknown); break;
      case "state extra": response = await call(scheduleState, `/schedules/${schedule.id}/state`, { state: "paused", ...unknown }); break;
      case "state value": response = await call(scheduleState, `/schedules/${schedule.id}/state`, { state: "BODY-VALUE-CANARY" }); break;
      case "malformed JSON": response = await call(cancelRun, `/runs/${run.id}/cancel`, undefined, { raw: "{BODY-VALUE-CANARY" }); break;
      case "oversized body": response = await call(publish, "", { runbookId: "restart", definition: DEFINITION }, { headers: { "content-length": "65537" } }); break;
      case "invalid status": response = await call(listRuns, "/runs?status=BODY-VALUE-CANARY", undefined, { method: "GET" }); break;
    }
    const body = await refused(response, 400, "invalid_request"); expect(JSON.stringify(body)).not.toContain("BODY-VALUE-CANARY");
    expect(await snapshot()).toEqual(before); expect(approvalWrites).not.toHaveBeenCalled();
  });
});
