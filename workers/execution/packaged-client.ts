/**
 * Opt-in, image-local acceptance client. Uses production stores, policy,
 * signer, codec and Temporal client; never supplies replacement activities.
 * Only the disposable harness network/database/file store are accepted.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { importJWK, jwtVerify } from "jose";
import { platformDb, openPlatformDb, migratePlatformDb, resetPlatformDbForTests, repos } from "@/lib/controlplane/db";
import { resetDb } from "@/lib/db/store";
import { platformBroker } from "@/lib/capabilities/platform";
import { getControlSigner } from "@/lib/credentials/signing";
import { ensurePlatformApp } from "@/lib/platform/app";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { workflowClient, closeWorkflowClients } from "@/lib/workflows/client";
import { WORKFLOW_ID, WORKFLOW_TYPES, type ReconcileWorkflowResult, type WorkflowResult } from "@/lib/workflows/types";
import { validateExecutionConfiguration } from "./startup";
import { assertPackagedAcceptanceTarget, PACKAGED_PLAN_DIR } from "./packaged-target";
import { executionHolder } from "@/lib/execution/platform";
import { ZENITH_SSM_DOCUMENTS } from "@/lib/machines/transports/aws-ssm-docs";

const WS = "packaged-workspace";
const PROJECT = "packaged-project";
const ENVIRONMENT = "packaged-environment";
const HUMAN = "packaged-member";
const CONNECTION = "packaged-unconnected-provider";
const PLAN_DIR = PACKAGED_PLAN_DIR;
const PLAN_DIGESTS = { terminal: "a".repeat(64), active: "b".repeat(64), unowned: "c".repeat(64) };
const principal = { kind: "user" as const, id: HUMAN, name: "Packaged acceptance member" };
const scope = { workspaceId: WS, projectId: PROJECT, environmentId: ENVIRONMENT };

async function prepare(): Promise<Record<string, unknown>> {
  await validateExecutionConfiguration();
  const db = await openPlatformDb({ kind: "postgres", url: process.env.ZENITH_PLATFORM_DB_URL, migrate: false, max: 1 });
  try {
    const migrated = await migratePlatformDb(db);
    const createdAt = new Date().toISOString();
    resetDb({
      workspaces: [{ id: WS, name: "Packaged acceptance", slug: WS, ownerId: HUMAN, createdAt }],
      members: [{ id: HUMAN, workspaceId: WS, name: principal.name, email: "packaged@example.test", role: "admin" }],
      projects: [{ id: PROJECT, workspaceId: WS, name: "No deployed resources", slug: PROJECT, createdAt, origin: { type: "blank" },
        workingManifest: { version: 1, services: [], resources: [], routes: [], bindings: [] } }],
      environments: [{ id: ENVIRONMENT, projectId: PROJECT, name: "Read-only acceptance", class: "staging", connectionId: CONNECTION,
        region: "us-east-1", baseDomain: "packaged.example.test", createdAt,
        policies: { approvalRequired: true, allowStatefulDeletion: false } }],
      // Product metadata only: no verified provider connection or cloud credentials.
      connections: [{ id: CONNECTION, workspaceId: WS, provider: "aws", label: "No provider credentials", region: "us-east-1",
        status: "healthy", grantedPermissions: [], createdAt }],
    });
    await registerEnvironment(db, { environment: { ...scope, class: "staging", provider: "aws", region: "us-east-1" } });
    await mkdir(PLAN_DIR, { recursive: true, mode: 0o700 });
    for (const kind of ["terminal", "active"] as const) {
      const created = await repos.operations.create(db, { workspaceId: WS, principal,
        proposal: { capability: "infrastructure.observe", scope, input: {}, summary: "Plan retention fixture", details: [], risk: "low",
          planDigest: PLAN_DIGESTS[kind] } });
      if (kind === "terminal") await repos.operations.transition(db, { workspaceId: WS, id: created.operation.id, from: ["proposed"], to: "cancelled" });
    }
    for (const digest of Object.values(PLAN_DIGESTS)) {
      const file = path.join(PLAN_DIR, `${digest}.tfplan`);
      await writeFile(file, "Acceptance retention sentinel; not an executable OpenTofu plan.\n", { mode: 0o600 });
      const old = new Date(Date.now() - 48 * 3600_000);
      await utimes(file, old, old);
    }
    return { prepared: true, appliedVersions: migrated.applied, productStore: "isolated-file-fixture", platformStore: "postgres" };
  } finally { await db.close(); }
}

async function operations(): Promise<Record<string, unknown>> {
  await validateExecutionConfiguration();
  const db = await platformDb();
  if (!(await ensurePlatformApp(db))) throw new Error("Packaged acceptance composition unavailable.");
  const broker = await platformBroker();
  const request = { capability: "infrastructure.observe", scope, input: {}, idempotencyKey: "packaged-read-refusal" };
  const authorization = await broker.authorizeRead(request, principal, { audience: "worker" });
  const signer = await getControlSigner();
  if (authorization.decision.outcome !== "allow" || !authorization.grant || !signer) throw new Error("Read policy/signing refused.");
  await jwtVerify(authorization.grant, await importJWK(signer.publicJwk(), "EdDSA"), { audience: "worker", issuer: "zenith-control" });
  const proposal = await broker.propose(request, principal);
  if (proposal.decision.outcome !== "allow") throw new Error("Read-only proposal policy refused.");
  await broker.beginExecution({ workspaceId: WS, operationId: proposal.operation.id, holder: executionHolder(proposal.operation.id), leaseMs: 300_000, audience: "worker" });
  const client = await workflowClient();
  const queue = process.env.ZENITH_WORKER_TASK_QUEUE!;
  const reconcile = await client.workflow.execute(WORKFLOW_TYPES.reconcile, {
    workflowId: `reconcile-${ENVIRONMENT}`, taskQueue: queue, workflowExecutionTimeout: "60s",
    args: [{ workspaceId: WS, environmentId: ENVIRONMENT, allowAutoRepair: false }],
  }) as ReconcileWorkflowResult;
  if (reconcile.status !== "observed" || reconcile.drift !== 0 || reconcile.unknown !== 0) throw new Error("Empty-environment reconcile failed.");
  const handle = await client.workflow.start(WORKFLOW_TYPES.dayTwo, { workflowId: WORKFLOW_ID(proposal.operation.id), taskQueue: queue,
    workflowExecutionTimeout: "90s", args: [{ operationId: proposal.operation.id, ...scope, capability: request.capability }] });
  const result = await handle.result() as WorkflowResult;
  const recorded = await repos.operations.get(db, WS, proposal.operation.id);
  // Native infrastructure.observe has no resource target in this fixture.
  // Its real activity must fail before opening a provider credential session.
  if (result.status !== "failed" || recorded?.status !== "failed" || !recorded.error?.includes("names no target resource")) {
    throw new Error("Read operation did not end with its expected safe no-target refusal.");
  }
  const decisions = await db.query<{ n: number }>("select count(*)::int as n from platform.policy_decisions where workspace_id = $1 and operation_id = $2", [WS, proposal.operation.id]);
  if (decisions[0].n < 2) throw new Error("Worker policy reevaluation was not persisted.");
  const history = await handle.fetchHistory();
  const activityTypes = history.events?.flatMap((event) => event.activityTaskScheduledEventAttributes?.activityType?.name ?? []) ?? [];
  for (const name of ["acquireLease", "evaluatePolicy", "executeCapability", "markOperation", "releaseLease"]) {
    if (!activityTypes.includes(name)) throw new Error("Required real worker activity was not scheduled.");
  }
  return { reconcile: { status: reconcile.status, drift: reconcile.drift, unknown: reconcile.unknown, scope: "no deployed resources" },
    operation: { workflowStatus: result.status, ledgerStatus: recorded.status, outcome: "expected no-target refusal", policyDecisions: decisions[0].n,
      activityTypes: [...new Set(activityTypes)], signedReadGrantVerified: true }, cloudWritesProven: false, browserApprovalPerformed: false };
}

async function assets(): Promise<Record<string, unknown>> {
  const exists = async (digest: string) => stat(path.join(PLAN_DIR, `${digest}.tfplan`)).then(() => true, () => false);
  for (let attempt = 0; attempt < 20 && await exists(PLAN_DIGESTS.terminal); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
  const terminalRemoved = !(await exists(PLAN_DIGESTS.terminal));
  const activeRetained = await exists(PLAN_DIGESTS.active);
  const unownedRetained = await exists(PLAN_DIGESTS.unowned);
  if (!terminalRemoved || !activeRetained || !unownedRetained) throw new Error("Packaged plan retention contract failed.");
  const data = await stat("/var/lib/zenith");
  const plans = await stat(PLAN_DIR);
  if (process.getuid?.() !== 10001 || data.uid !== 10001 || plans.uid !== 10001 || (plans.mode & 0o077) !== 0) throw new Error("Worker filesystem permissions failed.");
  return { uid: process.getuid?.(), arch: process.arch, node: process.version,
    tofu: execFileSync("tofu", ["version"], { encoding: "utf8" }).split("\n").slice(0, 2),
    policySha256: createHash("sha256").update(await readFile("policy/dist/policy.wasm")).digest("hex"),
    ssmDocuments: { count: Object.keys(ZENITH_SSM_DOCUMENTS).length,
      sha256: createHash("sha256").update(JSON.stringify(ZENITH_SSM_DOCUMENTS)).digest("hex") },
    dependencies: Object.fromEntries(await Promise.all(["@temporalio/worker", "@temporalio/client", "postgres", "jose"].map(async (name) => {
      const metadata = JSON.parse(await readFile(path.join("node_modules", name, "package.json"), "utf8")) as { version: string };
      return [name, metadata.version];
    }))),
    plans: { terminalRemoved, activeRetained, unownedRetained, sentinelFiles: true } };
}

async function main(): Promise<void> {
  try {
    assertPackagedAcceptanceTarget(process.env);
    const command = process.argv[2];
    const result = command === "prepare" ? await prepare() : command === "operations" ? await operations() : command === "assets" ? await assets() : undefined;
    if (!result) throw new Error("Unknown packaged acceptance command.");
    process.stdout.write(`PACKAGED_ACCEPTANCE ${JSON.stringify(result)}\n`);
  } finally {
    await closeWorkflowClients();
    await resetPlatformDbForTests();
  }
}

// This module is a dedicated packaged command, never imported by worker.ts.
if (process.argv[1] && /packaged-client\.(?:cjs|ts)$/.test(process.argv[1])) {
  main().catch(() => { process.stderr.write("Packaged acceptance client failed; check the current acceptance phase.\n"); process.exitCode = 1; });
}
