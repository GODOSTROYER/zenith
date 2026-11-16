/**
 * MCP v1 reader: tenant isolation across two workspaces (WS-SEC).
 *
 * The production-hardening audit found that no test called `callReader` /
 * `readerTools` with a credential from one workspace and an identifier from
 * another. This file is that test, for EVERY tool the reader publishes.
 *
 * What is under test is `callReader` in `src/lib/agent-access/zenith-reader.ts`
 * — the raw tool implementations, before `createReaderHandler` redacts the
 * result. Isolation must hold at this layer because redaction is defense in
 * depth, not the mechanism (docs/platform/ARCHITECTURE.md invariant 3).
 *
 * Principals (each a v1 `Credential`):
 *   alice   admin of alpha, credential scoped to alpha's project
 *   bob     admin of bravo, credential scoped to bravo's project
 *   poison  alice's identity, but the credential's `projectIds` LISTS BRAVO's
 *           project — a credential file or a buggy approval that recorded a
 *           foreign id. The reader must still refuse: it re-checks the
 *           project's workspace instead of trusting the grant's list.
 *   ghost   a subject that is not a member of the workspace it names
 *           (revoked membership, or a forged credential record)
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Credential, SelectedScope } from "@/lib/agent-access/security";
import { tempDataDir } from "../_support/data-dir";
import { assertNoCanaries, phantomId, refused, tenantMatrix, twoTenantFixture, type MatrixPrincipal, type MatrixTarget, type TenantMatrixResult } from "../_support/security";

tempDataDir("zenith-sec-v1-", { fast: true });

const fx = twoTenantFixture();
const { resetDb, appendEvent } = await import("@/lib/db/store");
const { callReader, readerTools, registerReaderProviders } = await import("@/lib/agent-access/zenith-reader");
const { registerAllActions } = await import("@/lib/actions/defs");

const { alpha, bravo } = fx;
const FUTURE = "2099-01-01T00:00:00.000Z";
const ALL_SCOPES: Credential["scopes"] = ["read", "plan", "export", "logs"];

const credential = (id: string, subject: string, workspaceId: string, projectIds: string[], environmentIds?: string[]): Credential => ({
  id,
  tokenHash: "0".repeat(64),
  subject,
  workspaceId,
  projectIds,
  ...(environmentIds ? { environmentIds } : {}),
  scopes: ALL_SCOPES,
  issuedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: FUTURE,
});

const credentials: Record<string, Credential> = {
  alice: credential("cred-alice", alpha.memberId, alpha.workspaceId, [alpha.projectId]),
  bob: credential("cred-bob", bravo.memberId, bravo.workspaceId, [bravo.projectId]),
  poison: credential("cred-poison", alpha.memberId, alpha.workspaceId, [alpha.projectId, bravo.projectId]),
  ghost: credential("cred-ghost", alpha.memberId, bravo.workspaceId, [bravo.projectId]),
};

type Home = typeof alpha;
const principals: MatrixPrincipal<Home>[] = [
  { id: "alice", workspaceId: alpha.workspaceId, meta: alpha },
  { id: "bob", workspaceId: bravo.workspaceId, meta: bravo },
  { id: "poison", workspaceId: alpha.workspaceId, meta: alpha },
  // `ghost` names bravo's workspace with alpha's member id: it owns nothing there
  { id: "ghost", workspaceId: bravo.workspaceId, ownAccess: "none", meta: bravo },
];

/** The scope headers a well-behaved client sends: workspace only, or nothing narrower. */
const selectedFor = (p: MatrixPrincipal): SelectedScope => ({ workspaceId: p.workspaceId });

beforeAll(() => {
  resetDb(fx.data);
  fx.events.forEach(appendEvent);
  registerReaderProviders();
  registerAllActions();
});

/**
 * Targets: each tenant's project, environment, deployment; a phantom of each
 * kind; and the MIXED targets an attacker actually tries — one of my own ids
 * paired with someone else's.
 */
const projectTargets = (): MatrixTarget[] => [
  { id: alpha.projectId, workspaceId: alpha.workspaceId, kind: "project" },
  { id: bravo.projectId, workspaceId: bravo.workspaceId, kind: "project" },
  { id: phantomId("prj"), workspaceId: null, kind: "project" },
];

interface EnvMeta {
  projectId: string;
  environmentId: string;
}
const environmentTargets = (): MatrixTarget<EnvMeta>[] => [
  { id: alpha.prodEnvId, workspaceId: alpha.workspaceId, kind: "environment", meta: { projectId: alpha.projectId, environmentId: alpha.prodEnvId } },
  { id: bravo.prodEnvId, workspaceId: bravo.workspaceId, kind: "environment", meta: { projectId: bravo.projectId, environmentId: bravo.prodEnvId } },
  // the phantom environment is named under THE CALLER'S OWN project (see `envArgs`)
  { id: phantomId("env"), workspaceId: null, kind: "environment", meta: { projectId: "", environmentId: phantomId("env") } },
];

/**
 * How the attacker names an environment:
 *  - `target-project`: the environment together with ITS OWN project (the
 *    straightforward IDOR: take somebody's ids wholesale);
 *  - `own-project`: the environment id under MY OWN project — the attack that
 *    only works if the resolver trusts the environment id by itself. A phantom
 *    environment is always requested under the caller's own project, so the
 *    foreign and phantom refusals are comparable.
 */
type EnvMode = "target-project" | "own-project";
const envArgs = (p: MatrixPrincipal<Home>, t: MatrixTarget, mode: EnvMode): EnvMeta => {
  const m = t.meta as EnvMeta;
  if (t.workspaceId === null || mode === "own-project") return { projectId: p.meta!.projectId, environmentId: m.environmentId };
  return m;
};

/** Bob's project named next to Alice's own environment, and vice versa. */
const mixedEnvironmentTargets = (): MatrixTarget<EnvMeta>[] => [
  { id: "mixed:alpha-project+bravo-env", workspaceId: bravo.workspaceId, kind: "environment", meta: { projectId: alpha.projectId, environmentId: bravo.prodEnvId } },
  { id: "mixed:bravo-project+alpha-env", workspaceId: alpha.workspaceId, kind: "environment", meta: { projectId: bravo.projectId, environmentId: alpha.prodEnvId } },
];

const deploymentTargets = (): MatrixTarget[] => [
  { id: alpha.deploymentId, workspaceId: alpha.workspaceId, kind: "deployment" },
  { id: bravo.deploymentId, workspaceId: bravo.workspaceId, kind: "deployment" },
  { id: phantomId("dep"), workspaceId: null, kind: "deployment" },
];

async function run(
  label: string,
  targets: MatrixTarget<unknown>[],
  tool: string,
  args: (p: MatrixPrincipal<Home>, t: MatrixTarget) => Record<string, unknown>,
  extra: { expectOwn?: "allowed" | "any" } = {}
): Promise<TenantMatrixResult> {
  return tenantMatrix<Home, unknown>({
    label,
    workspaces: [alpha.workspaceId, bravo.workspaceId],
    principals,
    targets: targets.map((t) => ({ ...t, expect: extra.expectOwn ?? t.expect })),
    // the reader throws AgentError with `code` and `status`, which the default classifier reads
    call: (p, t) => callReader(tool, args(p as MatrixPrincipal<Home>, t), credentials[p.id], selectedFor(p)),
  });
}

/**
 * `poison` and `ghost` are ATTACK principals: they must be refused for every
 * foreign target and are exempt from "own target must succeed" (ghost owns
 * nothing; poison's own project works, which the matrix confirms).
 */
const isolation = { canariesByWorkspace: fx.canariesByWorkspace } as const;

describe("MCP v1 reader: a credential from one workspace is worthless in the other", () => {
  it("has the tool inventory this suite was written against (a new tool must be added to the matrix)", () => {
    const covered = new Set([
      "zenith_get_context",
      "zenith_get_capabilities",
      "zenith_list_projects",
      "zenith_get_project",
      "zenith_get_manifest",
      "zenith_list_environments",
      "zenith_plan_deploy",
      "zenith_list_deployments",
      "zenith_get_deployment",
      "zenith_get_events",
      "zenith_get_findings",
      "zenith_get_drift",
      "zenith_export_project",
    ]);
    const published = readerTools.map((t) => t.name);
    const uncovered = published.filter((n) => !covered.has(n));
    expect(uncovered, `SECURITY TEST GAP: reader tool(s) ${uncovered.join(", ")} are published but not in the tenant matrix; add them to tests/security/mcp-v1-tenant-isolation.test.ts`).toEqual([]);
    const stale = [...covered].filter((n) => !published.includes(n));
    expect(stale, `matrix names tools that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });

  it("zenith_get_project", async () => {
    const m = await run("zenith_get_project", projectTargets(), "zenith_get_project", (_p, t) => ({ projectId: t.id }));
    m.assertIsolated({ ...isolation, ownMustSucceed: true });
  });

  it("zenith_get_manifest, working view (the environment argument is ignored by design; the project is the target)", async () => {
    const m = await run("zenith_get_manifest[working]", projectTargets(), "zenith_get_manifest", (_p, t) => ({ projectId: t.id, view: "working" }));
    m.assertIsolated(isolation);
  });

  it("zenith_get_manifest, deployed view (environment is the target, in both naming modes)", async () => {
    for (const mode of ["target-project", "own-project"] as const) {
      const m = await run(`zenith_get_manifest[deployed,${mode}]`, environmentTargets(), "zenith_get_manifest", (p, t) => ({ ...envArgs(p, t, mode), view: "deployed" }), { expectOwn: mode === "own-project" ? "any" : undefined });
      m.assertIsolated({ ...isolation, ownMustSucceed: mode === "target-project" });
    }
  });

  it("zenith_list_environments", async () => {
    const m = await run("zenith_list_environments", projectTargets(), "zenith_list_environments", (_p, t) => ({ projectId: t.id }));
    m.assertIsolated(isolation);
  });

  it("zenith_plan_deploy", async () => {
    for (const mode of ["target-project", "own-project"] as const) {
      const m = await run(`zenith_plan_deploy[${mode}]`, environmentTargets(), "zenith_plan_deploy", (p, t) => ({ ...envArgs(p, t, mode) }));
      m.assertIsolated({ ...isolation, ownMustSucceed: mode === "target-project" });
    }
  });

  it("zenith_list_deployments", async () => {
    for (const mode of ["target-project", "own-project"] as const) {
      const m = await run(`zenith_list_deployments[${mode}]`, environmentTargets(), "zenith_list_deployments", (p, t) => ({ ...envArgs(p, t, mode) }));
      m.assertIsolated({ ...isolation, ownMustSucceed: mode === "target-project" });
    }
  });

  it("zenith_get_deployment", async () => {
    const m = await run("zenith_get_deployment", deploymentTargets(), "zenith_get_deployment", (_p, t) => ({ deploymentId: t.id }));
    m.assertIsolated(isolation);
  });

  it("zenith_get_events", async () => {
    const m = await run("zenith_get_events", deploymentTargets(), "zenith_get_events", (_p, t) => ({ deploymentId: t.id }));
    m.assertIsolated(isolation);
  });

  it("zenith_get_findings", async () => {
    const m = await run("zenith_get_findings", projectTargets(), "zenith_get_findings", (_p, t) => ({ projectId: t.id }));
    m.assertIsolated(isolation);
  });

  it("zenith_get_drift", async () => {
    // drift needs a live provider read-back; the sandbox may refuse it for the caller's own environment
    for (const mode of ["target-project", "own-project"] as const) {
      const m = await run(`zenith_get_drift[${mode}]`, environmentTargets(), "zenith_get_drift", (p, t) => ({ ...envArgs(p, t, mode) }), { expectOwn: "any" });
      m.assertIsolated({ ...isolation, ownMustSucceed: false });
    }
  });

  it("zenith_export_project", async () => {
    for (const mode of ["target-project", "own-project"] as const) {
      const m = await run(`zenith_export_project[${mode}]`, environmentTargets(), "zenith_export_project", (p, t) => ({ ...envArgs(p, t, mode) }));
      m.assertIsolated({ ...isolation, ownMustSucceed: mode === "target-project" });
    }
  });

  it("mixed ids: my project with their environment, and theirs with mine, are refused by every environment-scoped tool", async () => {
    for (const tool of ["zenith_get_manifest", "zenith_plan_deploy", "zenith_list_deployments", "zenith_get_drift", "zenith_export_project"]) {
      const m = await run(`${tool}[mixed]`, mixedEnvironmentTargets(), tool, (_p, t) => ({ ...(t.meta as EnvMeta), ...(tool === "zenith_get_manifest" ? { view: "deployed" } : {}) }), { expectOwn: "any" });
      // both mixed targets are foreign to alice and bob alike (each pairs one id from each tenant)
      for (const c of m.cells) {
        if (c.principal.id === "poison" || c.principal.id === "ghost") continue;
        expect(c.outcome.kind, `${tool}: ${c.principal.id} with ${c.target.id} must be refused\n${m.table()}`).not.toBe("allowed");
      }
    }
  });

  it("list tools never return a foreign row, even for a credential that lists a foreign project", async () => {
    for (const who of ["alice", "poison"] as const) {
      const listed = (await callReader("zenith_list_projects", {}, credentials[who], selectedFor(principals.find((p) => p.id === who)!))) as { items: { id: string }[] };
      expect(listed.items.map((i) => i.id), `${who} listing`).toEqual([alpha.projectId]);
    }
  });

  it("no tool result for alice, on any call above or below, contains any canary planted in bravo (all encodings)", async () => {
    const alice = credentials.alice;
    const sel = selectedFor(principals[0]);
    const results: Record<string, unknown> = {};
    for (const tool of readerTools) {
      // give every tool BOTH tenants' ids; alice may only ever get her own
      for (const id of [alpha, bravo]) {
        const args = { projectId: id.projectId, environmentId: id.prodEnvId, deploymentId: id.deploymentId, view: "deployed" };
        const allowed = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
        const picked = Object.fromEntries(Object.entries(args).filter(([k]) => allowed.includes(k)));
        try {
          results[`${tool.name}(${id.key})`] = await callReader(tool.name, picked, alice, sel);
        } catch (error) {
          results[`${tool.name}(${id.key})`] = { refused: (error as Error).message };
        }
      }
    }
    assertNoCanaries(results, fx.canariesByWorkspace[bravo.workspaceId], "MCP v1 reader results for an alpha credential contain no bravo secret, in any encoding");
    // and the refusals themselves carry no foreign identifier
    assertNoCanaries(results, [bravo.projectId, bravo.prodEnvId, bravo.deploymentId, bravo.connectionId, bravo.memberId, bravo.workspaceId], "reader refusals and results never echo bravo's identifiers to alpha");
  });

  it("a refusal for a foreign id reads exactly like one for an id that never existed (no existence oracle)", async () => {
    const outcome = async (tool: string, args: Record<string, unknown>) => {
      try {
        await callReader(tool, args, credentials.alice, selectedFor(principals[0]));
        return refused("other_refusal", { message: "unexpectedly allowed" });
      } catch (e) {
        const err = e as { code?: string; status?: number; message: string };
        return { code: err.code, status: err.status, message: err.message };
      }
    };
    const pairs: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["zenith_get_project", { projectId: bravo.projectId }, { projectId: phantomId("prj") }],
      ["zenith_get_deployment", { deploymentId: bravo.deploymentId }, { deploymentId: phantomId("dep") }],
      ["zenith_get_events", { deploymentId: bravo.deploymentId }, { deploymentId: phantomId("dep") }],
      ["zenith_list_environments", { projectId: bravo.projectId }, { projectId: phantomId("prj") }],
      ["zenith_get_manifest", { projectId: alpha.projectId, environmentId: bravo.prodEnvId }, { projectId: alpha.projectId, environmentId: phantomId("env") }],
    ];
    for (const [tool, foreign, phantom] of pairs) {
      expect(await outcome(tool, foreign), `${tool}: foreign vs phantom`).toEqual(await outcome(tool, phantom));
    }
  });
});
