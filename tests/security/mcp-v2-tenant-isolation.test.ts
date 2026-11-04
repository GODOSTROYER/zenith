/**
 * MCP v2 control tools: tenant isolation across two workspaces (WS-SEC).
 *
 * v2 is the reviewed-operations surface (`src/lib/agent-access/control/`): it
 * serves the v1 read tools AND the control tools — revisions, logs, incident
 * bundle, prepare/execute, operations. This file drives `invoke()` from
 * `control/runtime.ts` — the function every v2 transport (`/api/agent/v2/mcp`,
 * `/api/agent/v2/tools`) calls after authentication — with a principal from
 * workspace A and identifiers from workspace B, for every tool.
 *
 * The journal is an in-memory SQLite journal injected through the same global
 * the runtime reads (`__zenithAgentJournal`), so the suite runs on Windows and
 * in CI alike; the file journal's POSIX permission checks are not what is under
 * test here.
 *
 * Principals (v2 `Principal`):
 *   alice / bob   admins of alpha / bravo with credentials scoped to their own project
 *   poison        alice's identity whose grant LISTS bravo's project
 *   ghost         alice's subject claiming bravo's workspace (no membership there)
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/lib/agent-access/control/journal";
import { tempDataDir } from "../_support/data-dir";
import { assertNoCanaries, phantomId, tenantMatrix, twoTenantFixture, type MatrixPrincipal, type MatrixTarget, type TenantMatrixResult } from "../_support/security";

tempDataDir("zenith-sec-v2-", { fast: true });
process.env.ZENITH_AGENT_CONTROL = "1";
process.env.ZENITH_AGENT_WRITES = "1";
process.env.ZENITH_AGENT_ORIGIN = "http://localhost:3400";
delete process.env.ZENITH_STORE;
delete process.env.VERCEL;
delete process.env.ZENITH_SERVERLESS;

const ORIGIN = "http://localhost:3400";
const fx = twoTenantFixture();
const { resetDb, appendEvent } = await import("@/lib/db/store");
const { Journal, SqliteAgentJournal } = await import("@/lib/agent-access/control/journal");
const { invoke, catalog } = await import("@/lib/agent-access/control/runtime");
const { readerTools } = await import("@/lib/agent-access/zenith-reader");

const { alpha, bravo } = fx;
const FUTURE = "2099-01-01T00:00:00.000Z";
const SCOPES = ["read", "plan", "write", "logs", "export"];

const principal = (integrationId: string, subject: string, workspaceId: string, projectIds: string[]): Principal => ({ subject, integrationId, workspaceId, projectIds, scopes: SCOPES, expiresAt: FUTURE });

const who: Record<string, Principal> = {
  alice: principal("int-alice-01", alpha.memberId, alpha.workspaceId, [alpha.projectId]),
  bob: principal("int-bob-0001", bravo.memberId, bravo.workspaceId, [bravo.projectId]),
  poison: principal("int-poison-1", alpha.memberId, alpha.workspaceId, [alpha.projectId, bravo.projectId]),
  ghost: principal("int-ghost-01", alpha.memberId, bravo.workspaceId, [bravo.projectId]),
};

type Home = typeof alpha;
const principals: MatrixPrincipal<Home>[] = [
  { id: "alice", workspaceId: alpha.workspaceId, meta: alpha },
  { id: "bob", workspaceId: bravo.workspaceId, meta: bravo },
  { id: "poison", workspaceId: alpha.workspaceId, skipExistenceCheck: true, meta: alpha },
  { id: "ghost", workspaceId: bravo.workspaceId, ownAccess: "none", meta: bravo },
];

const call = (tool: string, args: Record<string, unknown>, p: MatrixPrincipal<Home>) =>
  invoke(tool, args, who[p.id], { workspaceId: p.workspaceId }, async () => who[p.id], ORIGIN);

const operationIds: Record<"alpha" | "bravo", string> = { alpha: "", bravo: "" };

beforeAll(async () => {
  (globalThis as { __zenithAgentJournal?: unknown }).__zenithAgentJournal = new SqliteAgentJournal(new Journal(":memory:"));
  resetDb(fx.data);
  fx.events.forEach(appendEvent);
  // one prepared operation per tenant, created by that tenant's own principal
  for (const [key, t, p] of [["alpha", alpha, "alice"], ["bravo", bravo, "bob"]] as const) {
    const op = (await invoke(
      "zenith_prepare_change",
      { kind: "deployment.deploy", target: { workspaceId: t.workspaceId, projectId: t.projectId, environmentId: t.stagingEnvId }, requestKey: `request-${key}-0001` },
      who[p],
      { workspaceId: t.workspaceId },
      async () => who[p],
      ORIGIN
    )) as { id: string };
    operationIds[key] = op.id;
  }
});

const workspaces = [alpha.workspaceId, bravo.workspaceId];
const isolation = { canariesByWorkspace: fx.canariesByWorkspace } as const;

/**
 * `target-workspace` names the foreign tenant's WORKSPACE id too, so the call is
 * refused at the workspace check for every foreign id whether or not it exists —
 * there is nothing for an existence comparison to compare. `own-workspace`
 * names my workspace with their leaf id, which differs from a phantom only in
 * existence, so the existence comparison applies there.
 */
const isolationFor = (mode: "target-workspace" | "own-workspace") => ({ ...isolation, noExistenceLeak: mode === "own-workspace" });

type Mode = "target-workspace" | "own-workspace";
/**
 * `target`-shaped arguments. `own-workspace` names MY workspace with THEIR
 * project — the attack that only works if the project id is trusted on its own.
 */
const targetOf = (p: MatrixPrincipal<Home>, t: MatrixTarget, mode: Mode, environmentId?: string) => ({
  workspaceId: t.workspaceId === null || mode === "own-workspace" ? p.workspaceId : t.workspaceId,
  projectId: t.id,
  ...(environmentId ? { environmentId } : {}),
});

const projectTargets = (): MatrixTarget[] => [
  { id: alpha.projectId, workspaceId: alpha.workspaceId, kind: "project" },
  { id: bravo.projectId, workspaceId: bravo.workspaceId, kind: "project" },
  { id: phantomId("prj"), workspaceId: null, kind: "project" },
];

async function matrix(label: string, targets: MatrixTarget[], fn: (p: MatrixPrincipal<Home>, t: MatrixTarget) => Promise<unknown>): Promise<TenantMatrixResult> {
  return tenantMatrix<Home, unknown>({ label, workspaces, principals, targets, call: (p, t) => fn(p as MatrixPrincipal<Home>, t) });
}

describe("MCP v2: the tool inventory is fully covered", () => {
  it("every tool the catalog can advertise is named in this suite (a new tool must be added to the matrix)", () => {
    const named = new Set([
      ...readerTools.map((t) => t.name),
      "zenith_prepare_change",
      "zenith_execute_operation",
      "zenith_get_operation",
      "zenith_list_operations",
      "zenith_get_operation_events",
      "zenith_list_revisions",
      "zenith_compare_revisions",
      "zenith_get_logs",
      "zenith_incident_bundle",
      "zenith_get_edit_fields",
      "zenith_get_app",
    ]);
    const advertised = catalog(who.alice).map((t) => t.name);
    const uncovered = advertised.filter((n) => !named.has(n));
    expect(uncovered, `SECURITY TEST GAP: v2 tool(s) ${uncovered.join(", ")} are advertised but not covered by tests/security/mcp-v2-tenant-isolation.test.ts`).toEqual([]);
    expect(advertised.length, "catalog(alice) should advertise the control tools (is ZENITH_AGENT_CONTROL/WRITES set?)").toBeGreaterThan(readerTools.length);
  });
});

describe("MCP v2 control tools: a credential from one workspace is worthless in the other", () => {
  for (const mode of ["target-workspace", "own-workspace"] as const) {
    it(`zenith_list_revisions [${mode}]`, async () => {
      const m = await matrix(`zenith_list_revisions[${mode}]`, projectTargets(), (p, t) => call("zenith_list_revisions", { target: targetOf(p, t, mode) }, p));
      m.assertIsolated(isolationFor(mode));
    });

    it(`zenith_compare_revisions [${mode}]: a foreign revision id under my own project is refused`, async () => {
      const revs = (t: Home) => ({ from: t.revisionIds[0], to: t.revisionIds[1] });
      const targets: MatrixTarget[] = [
        { id: alpha.revisionIds[0], workspaceId: alpha.workspaceId, kind: "revision", meta: revs(alpha) },
        { id: bravo.revisionIds[0], workspaceId: bravo.workspaceId, kind: "revision", meta: revs(bravo) },
        { id: phantomId("rev"), workspaceId: null, kind: "revision", meta: { from: phantomId("rev"), to: phantomId("rev") } },
      ];
      const owner = (t: MatrixTarget) => (t.workspaceId === alpha.workspaceId ? alpha : bravo);
      const m = await matrix(`zenith_compare_revisions[${mode}]`, targets, (p, t) => {
        const r = t.meta as { from: string; to: string };
        // target-workspace: the revisions together with their own project; own-workspace: under MY project
        const project = t.workspaceId === null || mode === "own-workspace" ? p.meta!.projectId : owner(t).projectId;
        const ws = t.workspaceId === null || mode === "own-workspace" ? p.workspaceId : t.workspaceId;
        return call("zenith_compare_revisions", { target: { workspaceId: ws, projectId: project }, fromRevisionId: r.from, toRevisionId: r.to }, p);
      });
      m.assertIsolated(isolationFor(mode));
    });

    it(`zenith_get_logs and zenith_incident_bundle [${mode}]: a foreign deployment id is refused`, async () => {
      const targets: MatrixTarget[] = [
        { id: alpha.deploymentId, workspaceId: alpha.workspaceId, kind: "deployment", meta: alpha },
        { id: bravo.deploymentId, workspaceId: bravo.workspaceId, kind: "deployment", meta: bravo },
        { id: phantomId("dep"), workspaceId: null, kind: "deployment" },
      ];
      for (const tool of ["zenith_get_logs", "zenith_incident_bundle"]) {
        const m = await matrix(`${tool}[${mode}]`, targets, (p, t) => {
          const home = (t.meta as Home | undefined) ?? p.meta!;
          const useOwn = t.workspaceId === null || mode === "own-workspace";
          const project = useOwn ? p.meta!.projectId : home.projectId;
          const env = useOwn ? p.meta!.prodEnvId : home.prodEnvId;
          const ws = useOwn ? p.workspaceId : t.workspaceId!;
          return call(tool, { target: { workspaceId: ws, projectId: project, environmentId: env }, deploymentId: t.id }, p);
        });
        m.assertIsolated(isolationFor(mode));
      }
    });

    it(`zenith_prepare_change [${mode}]: nothing is proposed against a foreign project or environment`, async () => {
      const targets: MatrixTarget[] = [
        { id: alpha.stagingEnvId, workspaceId: alpha.workspaceId, kind: "environment", meta: alpha },
        { id: bravo.stagingEnvId, workspaceId: bravo.workspaceId, kind: "environment", meta: bravo },
        { id: phantomId("env"), workspaceId: null, kind: "environment" },
      ];
      let n = 0;
      const m = await matrix(`zenith_prepare_change[${mode}]`, targets, (p, t) => {
        const home = (t.meta as Home | undefined) ?? p.meta!;
        const useOwn = t.workspaceId === null || mode === "own-workspace";
        return call(
          "zenith_prepare_change",
          {
            kind: "deployment.deploy",
            requestKey: `sec-prepare-${mode}-${++n}-${p.id}`,
            target: { workspaceId: useOwn ? p.workspaceId : t.workspaceId!, projectId: useOwn ? p.meta!.projectId : home.projectId, environmentId: t.id },
          },
          p
        );
      });
      m.assertIsolated(isolationFor(mode));
    });
  }

  it("zenith_prepare_change with a manifest.replace aimed at a foreign project is refused and stores nothing", async () => {
    const before = await call("zenith_list_operations", {}, principals[1]);
    await expect(
      call("zenith_prepare_change", { kind: "manifest.replace", requestKey: "sec-replace-0001", expectedHash: "00000000", manifest: { version: 1, services: [], resources: [], routes: [], bindings: [] }, target: { workspaceId: alpha.workspaceId, projectId: bravo.projectId } }, principals[0])
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(await call("zenith_list_operations", {}, principals[1])).toEqual(before);
  });
});

describe("MCP v2 operations: one principal's operation ids are worthless to another", () => {
  const operationTargets = (): MatrixTarget[] => [
    { id: operationIds.alpha, workspaceId: alpha.workspaceId, kind: "operation", expect: "any" },
    { id: operationIds.bravo, workspaceId: bravo.workspaceId, kind: "operation", expect: "any" },
    { id: "op_00000000-0000-4000-8000-000000000000", workspaceId: null, kind: "operation" },
  ];

  it("has created one operation per tenant to attack", () => {
    expect(operationIds.alpha).toMatch(/^op_/);
    expect(operationIds.bravo).toMatch(/^op_/);
  });

  for (const tool of ["zenith_get_operation", "zenith_get_operation_events"] as const) {
    it(`${tool}: cross-tenant reads are refused`, async () => {
      const m = await matrix(tool, operationTargets(), (p, t) => call(tool, { operationId: t.id }, p));
      // own targets must succeed for reads; execution is checked separately
      m.assertIsolated({ ...isolation, noExistenceLeak: false });
    });

    /**
     * FINDING SEC-F1 (low): `Journal.get` (and its Postgres twin, `journal-pg.ts`
     * `row()` + `scoped()`) fetches the operation by id ALONE and only then checks
     * the caller's scope against the operation's target. A foreign operation id is
     * therefore refused as `scope_denied` (403) while an id that never existed is
     * `operation_not_found` (404) — an existence oracle the tenant-isolation
     * invariant forbids, and the action-level suite
     * (tests/actions/workspace-isolation.test.ts) explicitly requires NOT to
     * exist. Exploitability is low (ids are `op_<uuid v4>`). The same lookup is
     * also not scoped by `workspace_id` in SQL, so the tenant check lives in
     * application code after the row is loaded: one missed call site away from a
     * cross-tenant read.
     * Fix (journal.ts, journal-pg.ts): look up `WHERE id = $1 AND workspace = $2
     * AND subject = $3` and answer `operation_not_found` for everything else.
     * FIXED (WS-SEC-POLICY): journal lookups are scoped by workspace and subject in
     * the query, so a foreign id and a phantom id both answer 404
     * `operation_not_found`; the invariant below is now a plain test.
     */
    it(`${tool}: a foreign operation id is indistinguishable from one that never existed (KNOWN FINDING SEC-F1)`, async () => {
      const m = await matrix(`${tool}[existence]`, operationTargets(), (p, t) => call(tool, { operationId: t.id }, p));
      m.assertIsolated({ ...isolation, noExistenceLeak: true });
    });
  }

  it("zenith_execute_operation: a foreign operation is never claimed, and nothing is dispatched", async () => {
    const m = await matrix("zenith_execute_operation", operationTargets(), (p, t) => call("zenith_execute_operation", { operationId: t.id }, p));
    // alpha's own (unapproved) operation is refused for a different reason (approval_required); foreign ones are refused as scope
    m.assertIsolated({ ...isolation, noExistenceLeak: false, ownMustSucceed: false });
    for (const c of m.cells) {
      if (c.ownership === "own") expect(c.outcome.kind === "allowed", `an unapproved operation must not execute (${c.principal.id} -> ${c.target.id})`).toBe(false);
    }
  });

  it("zenith_list_operations lists only the caller's own operations", async () => {
    for (const [p, own, other] of [[principals[0], operationIds.alpha, operationIds.bravo], [principals[1], operationIds.bravo, operationIds.alpha]] as const) {
      const listed = (await call("zenith_list_operations", {}, p)) as { items: { id: string }[] };
      const ids = listed.items.map((i) => i.id);
      expect(ids, `${p.id} should see its own operation`).toContain(own);
      expect(ids, `${p.id} must not see the other tenant's operation`).not.toContain(other);
    }
    // a credential that lists the foreign project still lists nothing foreign
    const poisoned = (await call("zenith_list_operations", {}, principals[2])) as { items: { id: string }[] };
    expect(poisoned.items.map((i) => i.id)).not.toContain(operationIds.bravo);
  });

  it("zenith_get_app refuses every app for a principal with no appIds, identically for real and imaginary ids", async () => {
    const refusal = async (appId: string) => {
      try {
        await call("zenith_get_app", { target: { workspaceId: alpha.workspaceId, projectId: alpha.projectId }, appId }, principals[0]);
        return "allowed";
      } catch (e) {
        return `${(e as { code?: string }).code}|${(e as { status?: number }).status}`;
      }
    };
    expect(await refusal("app_anything_0001")).toBe("app_scope_denied|403");
    expect(await refusal("app_anything_0002")).toBe(await refusal("app_anything_0001"));
  });
});

describe("MCP v2 also serves the v1 read tools: same isolation, same canaries", () => {
  it("every read tool, called with both tenants' ids by alice, returns nothing that belongs to bravo", async () => {
    const results: Record<string, unknown> = {};
    for (const tool of readerTools) {
      for (const t of [alpha, bravo]) {
        const props = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
        const all: Record<string, unknown> = { projectId: t.projectId, environmentId: t.prodEnvId, deploymentId: t.deploymentId, view: "deployed" };
        const args = Object.fromEntries(Object.entries(all).filter(([k]) => props.includes(k)));
        try {
          results[`${tool.name}(${t.key})`] = await call(tool.name, args, principals[0]);
        } catch (error) {
          results[`${tool.name}(${t.key})`] = { refused: (error as { message?: string }).message };
        }
      }
    }
    assertNoCanaries(results, fx.canariesByWorkspace[bravo.workspaceId], "MCP v2 results for an alpha principal contain no bravo secret");
    assertNoCanaries(results, [bravo.projectId, bravo.prodEnvId, bravo.deploymentId, bravo.memberId, bravo.workspaceId, bravo.connectionId], "MCP v2 results and refusals never echo bravo's identifiers to alpha");
    // the foreign calls were refused, the own calls were not
    for (const tool of readerTools) {
      const foreign = results[`${tool.name}(bravo)`] as { refused?: string } | undefined;
      const props = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
      if (props.some((k) => ["projectId", "environmentId", "deploymentId"].includes(k))) {
        expect(foreign?.refused, `${tool.name} with bravo's ids must be refused for alice`).toBeTypeOf("string");
      }
    }
  });

  it("zenith_get_context never reports another workspace's member or selection", async () => {
    const ctx = await call("zenith_get_context", {}, principals[0]);
    assertNoCanaries(ctx, [bravo.memberId, bravo.workspaceId, bravo.projectId], "zenith_get_context for alpha carries no bravo identifier");
  });
});
