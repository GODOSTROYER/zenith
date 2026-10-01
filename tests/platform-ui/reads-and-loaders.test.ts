/** Real broker/OPA and PGlite SQL. Session and bearer identity are explicit test fakes; no cloud is contacted. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import type { SessionUser } from "@/lib/auth/session";
import type { Environment, Member, Project, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";
import { closeSharedPgliteAfterAll, makeHarness, sharedDatabase, integrationOf, requestFor, user, type Harness } from "../capabilities/support";
import { node, observation, runtime, driftReport, investigation, plainEstimate } from "../screens/platform/fixtures";

tempDataDir("zenith-platform-ui-", { fast: true });
process.env.ZENITH_STORE = "file";
process.env.ZENITH_PLATFORM_ORIGIN = "https://zenith.test";
const state = vi.hoisted(() => ({ sql: null as PlatformDbHandle | null, user: { id: "alice", name: "Alice", email: "alice@zenith.test" } as SessionUser | null, bearer: null as { id: string; workspaceId: string; subject: string } | null }));
vi.mock("@/lib/controlplane/db", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db")>(), platformDb: async () => state.sql! }));
vi.mock("@/lib/auth/session", async (original) => ({ ...await original<typeof import("@/lib/auth/session")>(), getSessionUser: async () => state.user }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...await original<typeof import("@/lib/supabase/env")>(), isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductPageAccess: async () => undefined, requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => ({ verify: async () => state.bearer }) }));
vi.mock("@/lib/hosted/access/identity", async () => {
  const { HostedError } = await import("@/lib/hosted/contracts");
  return { verifyRequestIdentity: async () => {
    if (!state.user) throw new HostedError("sign_in_required", "Signed out");
    return { subject: state.user.id, email: state.user.email, emailVerified: true };
  } };
});

import { repos } from "@/lib/controlplane/db";
import { resetDb } from "@/lib/db/store";
import { setPlatformBrokerForTests } from "@/lib/capabilities/platform";
import * as actions from "@/lib/actions/core";
import { POST as awsAction } from "@/app/(product)/platform/connections/aws/action/route";
import { GET as resources } from "@/app/api/platform/v1/environments/[id]/resources/route";
import { GET as drift } from "@/app/api/platform/v1/environments/[id]/drift/route";
import { GET as incidents } from "@/app/api/platform/v1/environments/[id]/incidents/route";
import { loadEnvironment, loadInvestigations, loadOperation, loadOperations, loadPage, loadPolicy } from "@/app/(product)/platform/_lib/loaders";
import { boundedView, publicData } from "@/app/(product)/platform/_lib/read-models";

closeSharedPgliteAfterAll();
let h: Harness;
const at = "2026-09-01T00:00:00.000Z";
const canary = "AKIAIOSFODNN7EXAMPLE";
type Handler = typeof resources;
const routes = [{ name: "resources", handler: resources }, { name: "drift", handler: drift }, { name: "incidents", handler: incidents }];
async function call(handler: Handler, id = h.ids.envAProd, query = "", headers: Record<string, string> = {}) {
  return handler(new NextRequest(`https://zenith.test/api/platform/v1/environments/${id}/read${query}`, { headers: { cookie: `zenith-workspace=${h.ids.wsA}`, ...headers } }), { params: Promise.resolve({ id }) });
}
beforeEach(async () => {
  vi.restoreAllMocks();
  state.sql = await sharedDatabase("pglite");
  h = await makeHarness();
  state.user = { id: "alice", name: "Alice", email: "alice@zenith.test" };
  state.bearer = { id: h.ids.intRO, workspaceId: h.ids.wsA, subject: "bob" };
  setPlatformBrokerForTests(h.broker);
  resetDb({
    workspaces: [h.ids.wsA, h.ids.wsB].map((id) => ({ id, name: id, slug: id, createdAt: at } as Workspace)),
    members: ["alice", "bob", "carol"].map((id) => ({ id, workspaceId: h.ids.wsA, role: id === "alice" ? "admin" : id === "carol" ? "viewer" : "editor", name: id, email: `${id}@zenith.test` } as Member)),
    projects: [{ id: h.ids.projA, workspaceId: h.ids.wsA }, { id: h.ids.projB, workspaceId: h.ids.wsB }] as Project[],
    environments: [{ id: h.ids.envAProd, projectId: h.ids.projA, name: "Production", class: "production" }, { id: h.ids.envBProd, projectId: h.ids.projB, name: "Foreign", class: "production" }] as Environment[],
  });
});

describe("AWS browser action adapter", () => {
  function submit(headers: Record<string, string> = {}, body: unknown = { actionId: "connection.verifyAws", input: { connectionId: "conn-id" } }) {
    return awsAction(new NextRequest("https://zenith.test/platform/connections/aws/action", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://zenith.test", cookie: `zenith-workspace=${h.ids.wsA}`, "x-zenith-workspace": h.ids.wsA, ...headers }, body: JSON.stringify(body),
    }), { params: Promise.resolve({}) });
  }
  it("dispatches the existing human action in the reviewed workspace", async () => {
    const execute = vi.spyOn(actions, "runAction").mockResolvedValueOnce({ result: { ok: true, summary: "Test action reply" } });
    expect((await submit()).status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toBe("connection.verifyAws");
    expect(execute.mock.calls[0][1]).toMatchObject({ workspaceId: h.ids.wsA, actor: { type: "user", id: "alice" } });
  });
  const refusedHeaders: Record<string, string>[] = [{ authorization: "Bearer agent" }, { authorization: "" }, { origin: "https://other.test" }, { origin: "" }];
  it.each(refusedHeaders)("refuses bearer or non-browser origins %j before dispatch", async (headers) => {
    const execute = vi.spyOn(actions, "runAction");
    expect((await submit(headers)).status).toBe(403); expect(execute).not.toHaveBeenCalled();
  });
  it("requires a signed-in verified session", async () => {
    state.user = null;
    const execute = vi.spyOn(actions, "runAction");
    expect((await submit()).status).toBe(401); expect(execute).not.toHaveBeenCalled();
  });
  it("refuses a stale tab that names a workspace other than the action's cookie scope", async () => {
    const execute = vi.spyOn(actions, "runAction");
    expect((await submit({ "x-zenith-workspace": h.ids.wsB })).status).toBe(404); expect(execute).not.toHaveBeenCalled();
  });
  it("refuses any action outside the two AWS connection actions", async () => {
    const execute = vi.spyOn(actions, "runAction");
    expect((await submit({}, { actionId: "workspace.setAutonomy", input: {} })).status).toBe(400); expect(execute).not.toHaveBeenCalled();
  });
});

describe.each(routes)("$name read boundary", ({ handler }) => {
  it("requires a browser session or bearer credential with configured authentication", async () => {
    state.user = null;
    expect((await call(handler)).status).toBe(401);
  });
  it("returns the same 404 for foreign, missing and malformed environment ids", async () => {
    const foreign = await call(handler, h.ids.envBProd);
    const missing = await call(handler, "missing");
    const malformed = await call(handler, "invalid.id");
    expect([foreign.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(await malformed.json()).toEqual({ error: { code: "not_found", message: "The requested item was not found in a workspace you can act in.", fix: "Check that the ids belong to a workspace you are a member of." } });
  });
  it("supports read-scoped bearer callers without a browser session", async () => {
    state.user = null;
    const result = await call(handler, h.ids.envAProd, "", { authorization: "Bearer test-credential" });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(await result.json()).toMatchObject({ evidence: "contract" });
  });
  it("refuses a credential restricted to a different environment", async () => {
    state.user = null;
    state.bearer = { id: h.ids.intScoped, workspaceId: h.ids.wsA, subject: "bob" };
    const result = await call(handler, h.ids.envAProd, "", { authorization: "Bearer test-credential" });
    expect(result.status).toBe(404);
  });
  it("fails closed on policy deny and does not execute a store read", async () => {
    h.setEngine({ version: "deny", evaluate: async () => ({ decision: { outcome: "deny", reasons: [{ code: "denied", message: "Denied" }] }, policyVersion: "deny", inputDigest: "input", evaluatedAt: at }) });
    const query = vi.spyOn(state.sql!, "query");
    const result = await call(handler);
    expect(result.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
  });
  it("fails closed when policy cannot be evaluated", async () => {
    h.setEngine(async () => { throw new Error(canary); });
    const result = await call(handler);
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain(canary);
  });
  it("does not leak or log a raw store error on a read outage", async () => {
    vi.spyOn(state.sql!, "query").mockRejectedValueOnce(new Error(canary));
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await call(handler);
    expect(result.status).toBe(503); expect(await result.text()).not.toContain(canary); expect(logging).not.toHaveBeenCalled();
  });
});

describe("resource shape, output bounds and redaction", () => {
  it("keeps missing observations absent and labels contract evidence", async () => {
    await repos.resources.upsertDesired(state.sql!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, node: node() });
    const result = await call(resources);
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].observation).toBeUndefined();
    expect(body.rows[0].runtime).toBeUndefined();
    expect(body.evidence).toBe("contract");
  });
  it("joins actual latest observation and runtime, redacts values before HTTP, and never infers a match from masked values", async () => {
    const r = await repos.resources.upsertDesired(state.sql!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, node: node() });
    await repos.observations.appendObservation(state.sql!, { workspaceId: h.ids.wsA, resourceId: r.id, observation: observation({ native: { safe: "not public" }, simulated: true }) });
    await repos.observations.upsertRuntime(state.sql!, { workspaceId: h.ids.wsA, resourceId: r.id, runtime: runtime({ simulated: true }) });
    // Bypass repository validation to model legacy or malicious persisted rows.
    await state.sql!.query("update platform.resources set spec = $3::text::jsonb where workspace_id = $1 and id = $2", [h.ids.wsA, r.id, JSON.stringify({ password: "unshaped-test-secret", image: canary, secretRef: "vault:db" })]);
    await state.sql!.query("update platform.resource_observations set attributes = $3::text::jsonb, error = $4 where workspace_id = $1 and resource_id = $2", [h.ids.wsA, r.id, JSON.stringify({ password: { state: "known", value: "unshaped-test-secret", observedAt: at }, image: { state: "known", value: canary, observedAt: at }, replicas: { state: "unknown", reason: "access_denied" } }), canary]);
    const result = await call(resources);
    const text = await result.text();
    expect(text).not.toContain(canary); expect(text).not.toContain("unshaped-test-secret"); expect(text).not.toContain("not public");
    const body = JSON.parse(text);
    expect(body.rows[0].node.spec.secretRef).toBe("vault:db");
    expect(body.rows[0].observation.attributes.password).toMatchObject({ state: "unknown", reason: "not_inspected" });
    expect(body.rows[0].observation.attributes.image.state).toBe("unknown");
    expect(body.rows[0].observation.attributes.replicas).toEqual({ state: "unknown", reason: "access_denied" });
    expect(body.rows[0].runtime.simulated).toBe(true);
  });
  it("paginates a stable address order without mixing another tenant", async () => {
    for (const address of ["service/a", "service/b", "service/c"]) await repos.resources.upsertDesired(state.sql!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, node: node({ address }) });
    await repos.resources.upsertDesired(state.sql!, { workspaceId: h.ids.wsB, environmentId: h.ids.envBProd, node: node({ address: "service/foreign" }) });
    const first = await (await call(resources, h.ids.envAProd, "?limit=2")).json();
    expect(first.rows.map((r: { node: { address: string } }) => r.node.address)).toEqual(["service/a", "service/b"]);
    const second = await (await call(resources, h.ids.envAProd, `?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.rows.map((r: { node: { address: string } }) => r.node.address)).toEqual(["service/c"]);
    expect(second.nextCursor).toBeUndefined();
  });
  it.each(["?limit=201", "?limit=0", "?limit=no", "?cursor=***", "?cursor=a"])("rejects invalid pagination %s", async (query) => {
    expect((await call(resources, h.ids.envAProd, query)).status).toBe(400);
  });
  it("bounds deeply nested and oversized external data and refuses a megabyte response", () => {
    expect(publicData("x".repeat(3000))).toHaveLength(2048);
    expect(publicData(Array.from({ length: 300 }, () => "item"))).toHaveLength(200);
    expect(() => boundedView({ value: "x".repeat(1024 * 1024) })).toThrow("too large");
  });
});

describe("persisted drift and investigations", () => {
  it("reports no stored drift as unknown, not an invented clean report", async () => {
    expect(await (await call(drift)).json()).toEqual({ report: null, truncated: false, evidence: "contract" });
  });
  it("uses the persisted report and masks sensitive changed-field values", async () => {
    await repos.drift.insert(state.sql!, { workspaceId: h.ids.wsA, report: driftReport({ environmentId: h.ids.envAProd, computedAt: at, simulated: true, findings: [{ address: "resource/db", class: "changed", severity: "high", repairable: false, autoRepairEligible: false, explanation: "Observed difference", fields: [{ attribute: "password", desired: "unshaped-secret", observed: canary }] }] }) });
    const result = await call(drift); const body = await result.json();
    expect(body.report.computedAt).toBe(at); expect(body.report.simulated).toBe(true);
    expect(body.report.findings[0].fields[0]).toEqual({ attribute: "password", desired: "[redacted]", observed: "[redacted]" });
  });
  it("marks truncated reports explicitly", async () => {
    const base = driftReport({ environmentId: h.ids.envAProd });
    await repos.drift.insert(state.sql!, { workspaceId: h.ids.wsA, report: { ...base, findings: Array.from({ length: 205 }, () => base.findings[0]) } });
    const body = await (await call(drift)).json(); expect(body.report.findings).toHaveLength(200); expect(body.truncated).toBe(true);
  });
  it("reads stored investigations only from the authorized workspace and environment", async () => {
    await repos.incidents.insertInvestigation(state.sql!, investigation({ id: `${h.ids.wsA}_inv`, workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, simulated: true }));
    await repos.incidents.insertInvestigation(state.sql!, investigation({ id: `${h.ids.wsB}_inv`, workspaceId: h.ids.wsB, environmentId: h.ids.envBProd }));
    const body = await (await call(incidents)).json(); expect(body.investigations).toHaveLength(1); expect(body.investigations[0].simulated).toBe(true); expect(body.evidence).toBe("contract");
  });
  it("caps the investigation list and marks omitted runs", async () => {
    for (let index = 0; index < 22; index++) await repos.incidents.insertInvestigation(state.sql!, investigation({ id: `${h.ids.wsA}_inv_${index}`, workspaceId: h.ids.wsA, environmentId: h.ids.envAProd }));
    const body = await (await call(incidents)).json(); expect(body.investigations).toHaveLength(20); expect(body.truncated).toBe(true);
  });
  it("retains the investigation structure when a stored evidence bag is large or contains a secret", async () => {
    const inv = investigation({ id: `${h.ids.wsA}_inv`, workspaceId: h.ids.wsA, environmentId: h.ids.envAProd });
    await repos.incidents.insertInvestigation(state.sql!, inv);
    inv.evidence[0].data = { password: "unshaped-secret", huge: Array.from({ length: 300 }, () => ({ entries: Array.from({ length: 50 }, () => "x") })) };
    await state.sql!.query("update platform.investigations set document = $3::text::jsonb where workspace_id = $1 and id = $2", [h.ids.wsA, inv.id, JSON.stringify(inv)]);
    const response = await call(incidents); expect(response.status).toBe(200);
    const body = await response.json(); expect(JSON.stringify(body)).not.toContain("unshaped-secret"); expect(Array.isArray(body.investigations[0].hypotheses)).toBe(true); expect(Array.isArray(body.investigations[0].recentChanges)).toBe(true);
  });
});

describe("server page loaders", () => {
  it("resolves the active workspace and excludes foreign environment choices", async () => {
    const result = await loadPage(async () => "ok");
    expect(result).toMatchObject({ data: "ok", context: { workspaceId: h.ids.wsA, role: "admin", principal: { id: "alice" }, environments: [{ id: h.ids.envAProd }] } });
    if ("data" in result) expect(result.context.environments).toHaveLength(1);
  });
  it("does not substitute the demo admin for a signed-out person", async () => {
    state.user = null;
    expect(await loadPolicy()).toEqual({ error: "Sign in to view the platform.", missing: false });
  });
  it("reads and filters actual operation records without inventing estimates", async () => {
    const proposed = await h.broker.propose(requestFor(h, "service.restart"), user("bob"));
    expect(proposed.operation.status).toBe("awaiting_approval");
    const result = await loadOperations({ status: "awaiting_approval", environmentId: h.ids.envAProd });
    if (!("data" in result)) throw new Error(result.error);
    expect(result.data.items.map((o) => o.id)).toEqual([proposed.operation.id]);
    const detail = await loadOperation(proposed.operation.id);
    if (!("data" in detail)) throw new Error(detail.error);
    expect(detail.data.operation.proposalDigest).toBe(proposed.operation.proposalDigest);
    expect(detail.data.operation.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.data.estimate).toBeUndefined(); expect(detail.data.approvals).toEqual([]);
    expect(detail.data.events.length).toBeGreaterThan(0);
  });
  it("reads an operation's actual persisted cost estimate", async () => {
    const proposed = await h.broker.propose(requestFor(h, "infrastructure.apply"), user("bob"));
    await repos.cost.insert(state.sql!, { workspaceId: h.ids.wsA, operationId: proposed.operation.id, estimate: plainEstimate() });
    const result = await loadOperation(proposed.operation.id);
    expect(result).toMatchObject({ data: { estimate: { kind: "estimate", currency: "USD" } } });
  });
  it.each(["made-up", "running,failed"])("reports invalid status %s as an error", async (status) => {
    expect(await loadOperations({ status })).toMatchObject({ error: "Choose a known operation status." });
  });
  it("returns an honest unavailable page for foreign operations", async () => {
    expect(await loadOperation("missing")).toMatchObject({ missing: true });
  });
  it("loads environment defaults and honest empty persisted state", async () => {
    const result = await loadEnvironment(h.ids.envAProd);
    expect(result).toMatchObject({ data: { resources: { rows: [] }, drift: { report: null }, autonomy: { level: 2, defaulted: true, version: 0 } } });
    expect(await loadInvestigations(h.ids.envAProd)).toMatchObject({ data: { investigations: [] } });
  });
  it("reports a store outage without echoing the underlying error", async () => {
    const query = vi.spyOn(state.sql!, "query").mockRejectedValueOnce(new Error(canary));
    const result = await loadEnvironment(h.ids.envAProd);
    expect(result).toMatchObject({ error: "The platform could not be read. Restore the platform store and services, then reload." });
    expect(JSON.stringify(result)).not.toContain(canary); query.mockRestore();
  });
  it("returns policy defaults and authoritative viewer roles", async () => {
    state.user = { id: "carol", name: "Carol", email: "carol@zenith.test" };
    expect(await loadPolicy()).toMatchObject({ context: { role: "viewer" }, data: { version: 0, isDefault: true } });
  });
  it("refuses foreign environment reads through the broker", async () => {
    expect(await loadEnvironment(h.ids.envBProd)).toMatchObject({ missing: true });
  });
  it("checks integration scope through the real broker", async () => {
    await expect(h.broker.authorizeRead({ capability: "infrastructure.observe", scope: { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd }, input: {} }, integrationOf(h, "intScoped"))).rejects.toMatchObject({ code: "not_found" });
  });
});
