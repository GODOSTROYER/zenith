/**
 * The deploy journey end to end, as the workflow calls it, on REAL pieces:
 *
 *   - the real OpenTofu engine (built-in `terraform_data` resources, local state;
 *     no cloud, no network) — plan → digest → final plan unchanged → apply;
 *   - the real platform control store (PGlite) behind `createPlatformPorts`;
 *   - the real product store (file store) behind `createProductPort`;
 *   - the real activities, graph expansion, compile and workspace assembly.
 *
 * Scripted: the capability broker (policy outcome, grants), the credential broker
 * (a fake AwsSession whose env carries canaries), and the drivers (they compile
 * to `terraform_data`; observe/verify answer "present"/"passed"). So this proves
 * the engine/store/activity wiring and the plan-digest safety net; it proves
 * nothing about AWS.
 *
 * Skipped, with a reason, when no `tofu` binary is available.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Manifest } from "@/lib/domain/types";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { proposeOperation } from "@/lib/controlplane/operations";
import type { OperationRecord } from "@/lib/controlplane/types";
import { createExecutionActivities } from "@/lib/execution/activities";
import { createPlatformPorts } from "@/lib/execution/platform";
import { TofuPlanChangedError } from "@/lib/execution/errors";
import { planWorkspace } from "@/lib/tofu/engine";
import { tempDataDir } from "../_support/data-dir";
import { builtinWorkspace, dataFragment, tofuOnPath } from "../tofu/_helpers";
import { CANARY_SECRET, CANARY_SESSION_KEY, connectionConfig } from "./fakes/fixtures";
import { FakeBroker, FakeCredentialBroker } from "./fakes/broker";
import { genericDrivers } from "./fakes/drivers";
import { FakeProber } from "./fakes/release";
import { PLAN_FILE_CANARY } from "./fakes/tofu";
import type { FakeOps } from "./fakes/store";

tempDataDir("zenith-act-journey-", { fast: true });
const { q, resetDb, save, readEvents } = await import("@/lib/db/store");
const { createProductPort } = await import("@/lib/execution/product-port");

const hasTofu = tofuOnPath();

const WS = "ws-journey";
const PROJECT = "proj-journey";
const ENVIRONMENT = "env-journey";
const PRODUCT_CONNECTION = "conn-journey";
const at = "2026-09-30T12:00:00.000Z";
const author = { type: "user" as const, id: "u1", name: "You" };

const bucketsManifest = (...names: string[]): Manifest => ({
  version: 1,
  services: [],
  resources: names.map((name) => ({ id: `res-${name}`, name, kind: "object_store" as const, config: {}, size: "small" as const, ownership: "managed" as const })),
  routes: [],
  bindings: [],
});

describe.skipIf(!hasTofu)("deploy journey on the real OpenTofu engine, platform store and product store", () => {
  let db: PlatformDbHandle;
  let dir: string;
  let statePath: string;
  let planDir: string;
  let compileSalt = "v1";
  const credentials = new FakeCredentialBroker();
  const prober = new FakeProber();
  let broker: FakeBroker;
  let activities: ReturnType<typeof createExecutionActivities>;
  let ports: ReturnType<typeof createPlatformPorts>;

  const deployment = (id: string, revisionId: string) => ({
    id,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    revisionId,
    status: "planning" as const,
    steps: [],
    outputs: [],
    changeSummary: "deploy",
    estCostDeltaUsd: 0,
    actor: author,
    createdAt: at,
  });

  async function newOperation(revisionId: string, deploymentId: string): Promise<OperationRecord> {
    const { operation } = await proposeOperation(db, {
      workspaceId: WS,
      principal: { kind: "user", id: "u1", name: "You" },
      proposal: {
        capability: "deployment.deploy",
        scope: { workspaceId: WS, projectId: PROJECT, environmentId: ENVIRONMENT },
        input: { revisionId, deploymentId },
        summary: `deploy ${revisionId}`,
        details: [],
        risk: "high",
      },
      status: "approved",
    });
    return operation;
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "zenith-act-journey-"));
    statePath = path.join(dir, "state", "terraform.tfstate");
    planDir = path.join(dir, "plans");

    resetDb({
      workspaces: [{ id: WS, name: "Journey", slug: "journey", createdAt: at }],
      connections: [{ id: PRODUCT_CONNECTION, workspaceId: WS, provider: "aws", label: "AWS", region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: at }],
      projects: [{ id: PROJECT, workspaceId: WS, name: "Journey", slug: "journey", workingManifest: bucketsManifest("assets"), createdAt: at, origin: { type: "blank" } }],
      environments: [
        {
          id: ENVIRONMENT,
          projectId: PROJECT,
          name: "staging",
          class: "staging",
          connectionId: PRODUCT_CONNECTION,
          region: "us-east-1",
          policies: { approvalRequired: false, allowStatefulDeletion: false },
          baseDomain: "journey.zenith.test",
          createdAt: at,
        },
      ],
      revisions: [
        { id: "rev-1", projectId: PROJECT, number: 1, manifest: bucketsManifest("assets"), message: "one", author, createdAt: at },
        { id: "rev-2", projectId: PROJECT, number: 2, manifest: bucketsManifest("assets", "uploads"), message: "two", author, createdAt: at },
      ],
      deployments: [deployment("dep-1", "rev-1"), deployment("dep-2", "rev-2")],
    });
    save();

    db = await openPlatformDb({ kind: "pglite" });
    ports = createPlatformPorts(db);
    const connection = await repos.connections.create(db, { workspaceId: WS, config: connectionConfig, createdBy: "u1", legacyConnectionId: PRODUCT_CONNECTION });
    await repos.connections.recordVerification(db, { workspaceId: WS, id: connection.id, ok: true });

    // the broker only needs operation lookups from the real ledger
    broker = new FakeBroker({ ops: new Map(), get: ports.ops.get } as unknown as FakeOps);
    activities = createExecutionActivities({
      ...ports,
      product: createProductPort(),
      broker,
      credentials,
      // each node compiles to a built-in terraform_data resource; `compileSalt` lets a test move the compiled configuration
      drivers: genericDrivers({ script: { compileExtra: () => ({ triggers_replace: [compileSalt] }) } }),
      // NO `tofu` here: the merged real engine is the default
      tofuWorkspace: { providerSet: () => "builtin", backend: () => ({ backend: { kind: "local", path: statePath } }) },
      fingerprintKey: "journey-fingerprint-key-0123456789",
      cost: { estimate: async () => null },
      prober,
      workerId: "journey-worker",
      planDir,
      limits: { heartbeatIntervalMs: 200 },
    });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it(
    "validates, plans, confirms the plan is unchanged, applies it, verifies, observes and finishes — and leaves nothing sensitive behind",
    async () => {
      const op = await newOperation("rev-1", "dep-1");
      const operationId = op.id;
      const step = (stepName: Parameters<typeof activities.recordStep>[0]["step"], status: Parameters<typeof activities.recordStep>[0]["status"], detail?: string) =>
        activities.recordStep({ operationId, step: stepName, status, detail });

      await activities.markOperation({ operationId, status: "running" });
      expect((await ports.ops.get(operationId))?.status).toBe("running");

      await step("validate", "running");
      const validation = await activities.validateDesiredState({ operationId });
      expect(validation).toMatchObject({ problems: [], nodes: 1 });
      await step("validate", "done", `${validation.nodes} node(s)`);
      expect((await ports.resources.list(WS, ENVIRONMENT)).map((r) => r.address)).toEqual(["object_store/assets"]);

      const lease = await activities.acquireLease({ operationId, scope: `env:${ENVIRONMENT}`, ttlMs: 300_000 });
      expect(lease.holder).toBe(`worker:journey-worker:${operationId}`);

      // plan: a real `tofu plan`
      await step("plan", "running");
      const plan = await activities.planInfrastructure({ operationId, lease });
      expect(plan).toMatchObject({ create: 1, update: 0, delete: 0, replace: 0, empty: false, destroysData: false });
      expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
      await step("plan", "done");
      expect(existsSync(path.join(planDir, `${plan.planDigest}.tfplan`))).toBe(true); // the plan file is in planDir
      expect(existsSync(statePath)).toBe(false); // planning changed nothing

      const evidence = await repos.evidence.list(db, WS, { operationId });
      const planRow = evidence.find((e) => e.kind === "tofu_plan")!;
      expect(planRow).toMatchObject({ digest: plan.planDigest });
      expect((planRow.summary.view as { resources: { address: string; action: string }[] }).resources).toEqual([expect.objectContaining({ address: "terraform_data.object_store_assets", action: "create" })]);
      expect((await repos.operations.get(db, WS, operationId))?.planDigest).toBe(plan.planDigest);

      // policy: the facts come from the plan we just made
      const policy = await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
      expect(policy.outcome).toBe("allow");
      expect(broker.reevaluations.at(-1)?.plan).toMatchObject({ create: 1, destroysData: false });
      expect((await activities.checkApproval({ operationId })).approved).toBe(false);

      // final plan: an independent re-plan has the SAME digest
      const final = await activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease });
      expect(final.planDigest).toBe(plan.planDigest);

      // apply: a real `tofu apply` of the verified plan
      await step("apply_infrastructure", "running", undefined);
      const applied = await activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease });
      expect(applied.applied).toBe(1);
      await step("apply_infrastructure", "done", `${applied.applied} change(s) applied`);
      expect(existsSync(statePath)).toBe(true);
      expect(existsSync(path.join(planDir, `${plan.planDigest}.tfplan`))).toBe(false); // removed after the apply
      expect((await ports.resources.list(WS, ENVIRONMENT))[0].status).toBe("active");

      // the world now equals the config: a new plan is empty
      const again = await activities.planInfrastructure({ operationId, lease });
      expect(again.empty).toBe(true);

      expect(await activities.verifyInfrastructure({ operationId })).toMatchObject({ status: "passed", checks: 1, failed: 0 });
      expect(await activities.verifyApplication({ operationId })).toMatchObject({ status: "passed", checks: 0 }); // no public route
      expect(await activities.observeEnvironment({ operationId })).toEqual({ drift: 0, unknown: 0 });

      await step("finalize", "running");
      await activities.markOperation({ operationId, status: "succeeded" });
      await step("finalize", "done");
      await activities.releaseLease({ lease });
      await step("release", "done");

      // ledger
      expect((await ports.ops.get(operationId))?.status).toBe("succeeded");
      const events = (await repos.events.list(db, WS, { operationId })).map((e) => e.type);
      for (const expected of ["operation.started", "lease.acquired", "resource.planned", "resource.applying", "resource.applied", "resource.verified", "resource.observed", "operation.succeeded", "deployment.healthy", "lease.released"]) {
        expect(events, expected).toContain(expected);
      }
      expect(await repos.leases.current(db, `env:${ENVIRONMENT}`)).toBeNull();

      // product store: the Deployment the UI follows
      const d = q.deployment("dep-1")!;
      expect(d.status).toBe("succeeded");
      expect(d.steps.map((s) => `${s.id}:${s.status}`)).toEqual(["step-validate:done", "step-plan:done", "step-apply_infrastructure:done", "step-finalize:done", "step-release:done"]);
      expect(q.environment(ENVIRONMENT)!.deployedRevisionId).toBe("rev-1");
      expect(readEvents("dep-1").some((e) => e.type === "status" && e.status === "succeeded")).toBe(true);

      // nothing sensitive anywhere that was persisted
      const stored = JSON.stringify({
        evidence: await repos.evidence.list(db, WS, { operationId }),
        events: await repos.events.list(db, WS, { operationId }),
        resources: await ports.resources.list(WS, ENVIRONMENT),
        operation: await ports.ops.get(operationId),
        deployment: d,
      });
      for (const secret of [CANARY_SECRET, CANARY_SESSION_KEY, PLAN_FILE_CANARY, "session-token-canary", "ASIATESTSESSION0001"]) expect(stored).not.toContain(secret);
    },
    300_000
  );

  it(
    "refuses to apply when the compiled configuration moved between approval and apply, and applies nothing",
    async () => {
      const op = await newOperation("rev-2", "dep-2");
      const operationId = op.id;
      await activities.markOperation({ operationId, status: "running" });
      await activities.validateDesiredState({ operationId });
      const lease = await activities.acquireLease({ operationId, scope: `env:${ENVIRONMENT}`, ttlMs: 300_000 });

      const approved = await activities.planInfrastructure({ operationId, lease });
      expect(approved).toMatchObject({ create: 1, replace: 0 }); // "uploads" is new; "assets" already exists

      compileSalt = "v2"; // someone changed what the drivers compile (and so the configuration) after the approval
      try {
        const err = await activities.finalPlan({ operationId, approvedPlanDigest: approved.planDigest, lease }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TofuPlanChangedError);
        expect((err as TofuPlanChangedError).code).toBe("plan_changed");
        expect((err as TofuPlanChangedError).approvedDigest).toBe(approved.planDigest);

        const applyErr = await activities.applyInfrastructure({ operationId, planDigest: approved.planDigest, lease }).catch((e: unknown) => e);
        expect(applyErr).toBeInstanceOf(TofuPlanChangedError);

        // nothing was applied: no apply evidence, the operation is not uncertain, "uploads" still does not exist
        const kinds = (await repos.evidence.list(db, WS, { operationId })).map((e) => e.kind);
        expect(kinds).not.toContain("tofu_apply");
        expect((await ports.ops.get(operationId))?.status).toBe("running");
        compileSalt = "v1";
        const stillPending = await activities.planInfrastructure({ operationId, lease });
        expect(stillPending.planDigest).toBe(approved.planDigest); // back to the approved config: the same plan, still unapplied
      } finally {
        compileSalt = "v1";
      }

      // and with the approved configuration restored, the approved plan applies
      const applied = await activities.applyInfrastructure({ operationId, planDigest: approved.planDigest, lease });
      expect(applied.applied).toBe(1);
      await activities.markOperation({ operationId, status: "succeeded" });
      await activities.releaseLease({ lease });
    },
    300_000
  );

  it(
    "refuses to apply when only the state moved (an out-of-band change between approval and apply)",
    async () => {
      // a fresh single-resource environment on its own state file, driven through the same activities
      const state2 = path.join(dir, "state2", "terraform.tfstate");
      const localActivities = createExecutionActivities({
        ...ports,
        product: createProductPort(),
        broker,
        credentials,
        drivers: genericDrivers(),
        tofuWorkspace: { providerSet: () => "builtin", backend: () => ({ backend: { kind: "local", path: state2 } }) },
        fingerprintKey: "journey-fingerprint-key-0123456789",
        cost: { estimate: async () => null },
        prober,
        workerId: "journey-worker-2",
        planDir: path.join(dir, "plans2"),
        limits: { heartbeatIntervalMs: 200 },
      });
      resetDb({
        workspaces: [{ id: WS, name: "Journey", slug: "journey", createdAt: at }],
        connections: [{ id: PRODUCT_CONNECTION, workspaceId: WS, provider: "aws", label: "AWS", region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: at }],
        projects: [{ id: PROJECT, workspaceId: WS, name: "Journey", slug: "journey", workingManifest: bucketsManifest("assets"), createdAt: at, origin: { type: "blank" } }],
        environments: [
          { id: ENVIRONMENT, projectId: PROJECT, name: "staging", class: "staging", connectionId: PRODUCT_CONNECTION, region: "us-east-1", policies: { approvalRequired: false, allowStatefulDeletion: false }, baseDomain: "journey.zenith.test", createdAt: at },
        ],
        revisions: [{ id: "rev-3", projectId: PROJECT, number: 3, manifest: bucketsManifest("solo"), message: "three", author, createdAt: at }],
        deployments: [deployment("dep-3", "rev-3")],
      });
      save();

      const op = await newOperation("rev-3", "dep-3");
      const operationId = op.id;
      await localActivities.markOperation({ operationId, status: "running" });
      await localActivities.validateDesiredState({ operationId });
      const lease = await localActivities.acquireLease({ operationId, scope: `env:${ENVIRONMENT}`, ttlMs: 300_000 });
      const approved = await localActivities.planInfrastructure({ operationId, lease });
      expect(approved.create).toBe(1);

      // somebody applies something else into the same state meanwhile
      const rogue = builtinWorkspace(state2, { "resource/rogue": dataFragment("rogue", "out-of-band") });
      const roguePlan = await planWorkspace(rogue);
      const { applyVerifiedPlan } = await import("@/lib/tofu/engine");
      await applyVerifiedPlan(rogue, { approvedDigest: roguePlan.plan.planDigest });

      const err = await localActivities.applyInfrastructure({ operationId, planDigest: approved.planDigest, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TofuPlanChangedError);
      expect((await repos.evidence.list(db, WS, { operationId })).map((e) => e.kind)).not.toContain("tofu_apply");
      await localActivities.releaseLease({ lease });
    },
    300_000
  );
});
