/** Actual J1/J2 operations. Local fixtures are owned exclusively and always settled. */
import { existsSync, mkdtempSync, chmodSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { sourceBinding, privateLocation, assertPrivate } from "../../deploy/installation.mjs";
import { readState, cleanup as cleanupStack } from "../../acceptance/default-stack/runtime.mjs";
import { Config, privateFile, prerequisites, operator, login, browserRequest, jsonRequest, ok, action, nonce, until, kubeconfig, linkedAgent, adminHeaders, command, sha256, ensure } from "../../../tests/e2e/default/support.mjs";
import { enrollOperator } from "../../../tests/e2e/default/mfa.mjs";
import { assertLocalDocker, localPaths } from "../local-environment";
import { DRIVER_CHECKS, OPERATED_LABEL, OwnedCleanup, receiptExit, validateOperatedReceipt, type DriverScenario, type OperatedReceipt } from "./protocol";

export interface DriverInput { scenarioId: DriverScenario; runId: string; sourceCommit: string; receiptFile: string; env: NodeJS.ProcessEnv }
type JourneyConfig = ReturnType<typeof Config.parse>;
type Stack = Awaited<ReturnType<typeof prerequisites>>;
export interface Tenant {
  owner: Page; approver: Page; workspaceId: string; project: { id: string; slug: string; name: string };
  environmentId: string; connectionId: string; ownerId: string; approverId: string;
  manifest: Record<string, unknown>; serviceId: string; witness: string; agent?: { token: string; credentialId: string };
  operationId?: string; deploymentId?: string;
}
export interface OperatedContext {
  config: JourneyConfig; stack: Stack; browser: Browser; scratch: string; input: DriverInput; cleanup: OwnedCleanup;
  readbacks: Record<string, string>; step(id: string, work: () => Promise<void>): Promise<void>;
}

export async function runOperated(input: DriverInput, work: (context: OperatedContext) => Promise<void>, limits: readonly string[]): Promise<number> {
  // No config, auth, filesystem, subprocess or network access before explicit opt-in.
  if (input.env.ZENITH_LOCAL_DRIVER_D4 !== "1" || input.env.ZENITH_LOCAL_JOINED_DRIVERS !== "1"
    || input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || input.env.ZENITH_DEFAULT_JOURNEY !== "1") return 2;
  ensure(!Object.keys(process.env).some(key => process.env[key] && (/^ZENITH_LIVE_/.test(key)
    || (/^(?:AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE)/.test(key) && key !== "AWS_EC2_METADATA_DISABLED"))), "cloud-credentials-refused");
  localPaths(input.env);
  ensure(input.env.ZENITH_LOCAL_RUN_ID === input.runId && Number(process.versions.node.split(".")[0]) === 22, "driver-run-binding");
  ensure(path.isAbsolute(input.receiptFile) && !existsSync(input.receiptFile), "fresh-receipt");
  privateFile(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE);
  const config = Config.parse(JSON.parse(privateFile(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE)));
  ensure(realpathSync(config.stackDirectory) === realpathSync(input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR!), "stack-config-binding");
  const source = sourceBinding();
  ensure(source.head === input.sourceCommit, "source-commit-binding");
  const receipt: OperatedReceipt = { schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId: input.scenarioId, runId: input.runId,
    sourceCommit: source.head, sourceDigest: source.contentSha256, checks: DRIVER_CHECKS[input.scenarioId].map(id => ({ id, status: "skipped" })),
    readbacks: {}, limits: ["Owned local operated rehearsal only. No live cloud, production signoff or commercial acceptance.", ...limits] };
  const cleanup = new OwnedCleanup();
  const step = async (id: string, fn: () => Promise<void>) => {
    const check = receipt.checks.find(item => item.id === id);
    ensure(check?.status === "skipped", "check-inventory");
    try { await fn(); check!.status = "passed"; } catch { check!.status = "failed"; throw new Error("Operated driver check failed"); }
  };
  try {
    let context!: OperatedContext;
    await step("preconditions", async () => {
      ensure(process.platform === "darwin" && process.arch === "arm64", "native-mac-required");
      privateLocation(input.receiptFile);
      assertPrivate(privateLocation(input.env.ZENITH_LOCAL_ROOT!), true);
      await assertLocalDocker(input.env);
      const state = readState(config.stackDirectory);
      ensure(state.profile === "lean" && JSON.stringify(state.source) === JSON.stringify(source), "exclusive-current-lean-stack");
      // The explicit D4 gate transfers this fresh disposable J1 installation's cleanup to this invocation.
      cleanup.add(async () => { await cleanupStack(state); });
      const targets = JSON.parse(privateFile(path.join(path.dirname(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE!), "targets.json")));
      const nodes = JSON.parse(await command("docker", ["inspect", "zenith-j2-control-plane"]));
      ensure(targets.schemaVersion === 1 && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.kind === "zenith-j2"
        && targets.status === "created" && nodes.length === 1 && targets.containerId === nodes[0].Id
        && nodes[0].Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "exclusive-kind-ownership");
      cleanup.add(async () => {
        const current = JSON.parse(await command("docker", ["inspect", targets.containerId]));
        ensure(current.length === 1 && current[0].Id === targets.containerId && current[0].Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "kind-cleanup-ownership");
        await command("kind", ["delete", "cluster", "--name", "zenith-j2"]);
        ensure(!(await command("kind", ["get", "clusters"])).split(/\s+/).includes("zenith-j2"), "kind-cleanup-absence");
        for (const name of ["deployer-old.json", "deployer-new.json", "kind-bootstrap.yaml", "observer.json", "journey.json"]) {
          const file = privateLocation(path.join(path.dirname(input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE!), name));
          if (existsSync(file)) { privateFile(file); rmSync(file); }
        }
      });
      const stack = await prerequisites(config, { commit: source.head, sourceDigest: source.contentSha256, dirty: source.dirty });
      kubeconfig(config.kind.kubeconfigFile, config);
      privateFile(config.kind.observerKubeconfigFile);
      const scratch = mkdtempSync(path.join(realpathSync(input.env.ZENITH_LOCAL_ROOT!), "drv4-")); chmodSync(scratch, 0o700);
      cleanup.add(async () => { rmSync(scratch, { recursive: true }); });
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ headless: true });
      cleanup.add(async () => { await browser.close(); });
      context = { config, stack, browser, scratch, input, cleanup, readbacks: receipt.readbacks, step };
    });
    await work(context);
    await step("source-stable", async () => { ensure(JSON.stringify(sourceBinding()) === JSON.stringify(source), "source-drift"); });
  } catch {
    // An exception between named steps is an attempted failure, not a skipped prerequisite.
    if (!receipt.checks.some(check => check.status === "failed")) {
      const pending = receipt.checks.find(check => check.id !== "owned-cleanup" && check.status === "skipped");
      if (pending) pending.status = "failed";
    }
  }
  finally {
    const clean = await cleanup.settle();
    receipt.checks.find(item => item.id === "owned-cleanup")!.status = clean && receipt.checks[0].status === "passed" ? "passed" : "failed";
    validateOperatedReceipt(receipt, input);
    writeFileSync(input.receiptFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  return receiptExit(receipt);
}

export async function createTenant(ctx: OperatedContext, letter: string): Promise<Tenant> {
  const { stack, browser, config, cleanup, input } = ctx;
  const users: string[] = [];
  cleanup.add(async () => {
    let failed = false;
    for (const id of users.reverse()) {
      try { ok(await jsonRequest(stack.supabaseUrl + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: adminHeaders(stack) })); }
      catch { failed = true; }
    }
    ensure(!failed, "auth-cleanup");
  });
  const owner = await (await browser.newContext()).newPage(), approver = await (await browser.newContext()).newPage();
  const a = await operator(stack, config.mailpitUrl, `drv4-${letter}-owner`, users);
  const b = await operator(stack, config.mailpitUrl, `drv4-${letter}-approver`, users);
  await login(owner, stack, a); await login(approver, stack, b);
  const workspace = ok(await browserRequest(owner, "/api/workspace", { name: `DRV4 ${input.runId} ${letter}` })).workspace;
  const invite = ok(await browserRequest(owner, "/api/workspace/invites", { workspaceId: workspace.id, email: b.email, role: "admin" })).invite;
  const accepted = ok(await browserRequest(approver, "/api/workspace/invites/" + invite.id + "/accept", {}));
  ensure(accepted.member?.id === b.id && accepted.member?.role === "admin", "approver-member");
  await enrollOperator(owner, stack); await enrollOperator(approver, stack);
  const name = `DRV4 ${input.runId} ${letter}`;
  const created = await action(owner, "project.create", { name, withEnvironment: false });
  return { owner, approver, ownerId: a.id, approverId: b.id, workspaceId: workspace.id,
    project: { id: created.projectId, slug: created.slug, name }, environmentId: "", connectionId: "",
    manifest: {}, serviceId: `witness-${letter}`, witness: nonce() };
}

export async function connectKind(ctx: OperatedContext, tenant: Tenant): Promise<void> {
  const { config, stack } = ctx;
  const { owner, project, serviceId, witness } = tenant;
  tenant.manifest = { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
    providerConfig: { kubernetes: { namespace: config.kind.namespace } }, services: [{ id: serviceId, name: serviceId, kind: "web",
      source: { type: "image", image: config.kind.image }, size: "small", replicas: 1, port: 8080, healthPath: "/", ownership: "managed",
      env: [{ key: "WITNESS_NONCE", value: witness }] }], resources: [], routes: [], bindings: [] };
  await action(owner, "project.updateManifest", { projectId: project.id, manifest: tenant.manifest });
  const credentialRef = "vault:DRV4_KUBE";
  await action(owner, "system.setSecret", { projectId: project.id, serviceId, key: "DRV4_KUBE", secretRef: credentialRef, secretValue: privateFile(config.kind.kubeconfigFile) });
  await action(owner, "project.updateManifest", { projectId: project.id, manifest: tenant.manifest });
  const target = kubeconfig(config.kind.kubeconfigFile, config);
  tenant.connectionId = (await action(owner, "connection.createKubernetes", { label: project.name, server: config.kind.server,
    caData: target.caData, namespaces: [config.kind.namespace], credentialRef, scopedGuest: false })).connectionId;
  await owner.goto(stack.apiUrl + "/platform/connections");
  const card = owner.getByRole("listitem").filter({ hasText: project.name });
  const response = owner.waitForResponse(value => value.url().endsWith("/connections/" + tenant.connectionId + "/verify") && value.request().method() === "POST");
  await card.getByRole("button", { name: "Verify", exact: true }).click(); ensure((await response).ok(), "kind-connection-verified");
  tenant.environmentId = (await action(owner, "env.create", { projectId: project.id, name: "production", class: "production", connectionId: tenant.connectionId, approvalRequired: true })).environmentId;
  tenant.agent = await linkedAgent(owner, stack, project, tenant.workspaceId);
  ctx.cleanup.add(async () => { ok(await browserRequest(owner, "/api/integrations/agent/link/revoke", { credentialId: tenant.agent!.credentialId })); });
}

export const detailOf = async (tenant: Tenant, operationId: string) => ok(await browserRequest(tenant.owner, "/api/platform/v1/operations/" + operationId, undefined, "GET", tenant.workspaceId));
export async function approveOperation(ctx: OperatedContext, tenant: Tenant, operationId: string): Promise<void> {
  const detail = await detailOf(tenant, operationId);
  ensure(detail.operation.status === "awaiting_approval" && detail.decision?.approval?.separationOfDuties === true, "human-approval-required");
  await tenant.approver.goto(ctx.stack.apiUrl + "/platform/operations/" + operationId);
  const response = tenant.approver.waitForResponse(value => value.url().endsWith("/operations/" + operationId + "/approve") && value.request().method() === "POST");
  await tenant.approver.getByRole("button", { name: /^Approve / }).click();
  ensure((await response).ok(), "browser-human-approval");
  const recorded = await detailOf(tenant, operationId);
  ensure(recorded.operation.status === "approved" && recorded.approvals.some((value: { approverId: string; decision: string }) => value.approverId === tenant.approverId && value.decision === "approve"), "human-approval-readback");
}
export async function deployKind(ctx: OperatedContext, tenant: Tenant): Promise<void> {
  const result = await action(tenant.owner, "deploy.apply", {}, { projectId: tenant.project.id, environmentId: tenant.environmentId });
  ensure(result.operationId && result.deploymentId, "real-workflow-proposal");
  tenant.operationId = result.operationId; tenant.deploymentId = result.deploymentId;
  await approveOperation(ctx, tenant, result.operationId);
  await action(tenant.approver, "deploy.approve", { deploymentId: result.deploymentId }, { projectId: tenant.project.id, environmentId: tenant.environmentId });
  const inspected = await until(() => detailOf(tenant, result.operationId), (data: { operation: { status: string; approvalRound: number } }) => data.operation.status === "awaiting_approval" && data.operation.approvalRound > 0);
  ensure(/^[a-f0-9]{64}$/.test(inspected.operation.planDigest ?? "") && /^[a-f0-9]{64}$/.test(inspected.planReview?.semantics?.digest ?? ""), "immutable-plan-review");
  await approveOperation(ctx, tenant, result.operationId);
  const terminal = await until(() => detailOf(tenant, result.operationId), (value: { operation: { status: string } }) => ["succeeded", "failed", "uncertain", "denied", "expired"].includes(value.operation.status));
  ensure(terminal.operation.status === "succeeded", "deployment-terminal");
}
/** Read the real objects and served witness through the independent observer, never API projections. */
export async function observeKind(ctx: OperatedContext, tenant: Tenant): Promise<string> {
  type Deployment = { metadata: { name: string; uid: string; generation: number; annotations?: Record<string, string> }; spec: { replicas: number; template: { spec: { containers: { image: string }[] } } }; status: { availableReplicas: number; observedGeneration: number } };
  const base = ["--kubeconfig", ctx.config.kind.observerKubeconfigFile, "--context", ctx.config.kind.context, "-n", ctx.config.kind.namespace];
  const observed = await until(async () => JSON.parse(await command("kubectl", [...base, "get", "deployments", "-o", "json"])), (value: { items: Deployment[] }) =>
    value.items?.some((item: Deployment) => item.metadata?.annotations?.["zenith.dev/environment"] === tenant.environmentId && item.status?.availableReplicas === 1));
  const objects: Deployment[] = observed.items.filter((item: Deployment) => item.metadata?.annotations?.["zenith.dev/environment"] === tenant.environmentId);
  ensure(objects.length === 1 && objects[0].spec.replicas === 1 && objects[0].status.observedGeneration >= objects[0].metadata.generation
    && objects[0].spec.template.spec.containers[0].image === ctx.config.kind.image, "owned-kind-witness");
  const served = JSON.parse(await command("kubectl", [...base, "exec", "deployment/" + objects[0].metadata.name, "--", "/usr/local/bin/witness", "probe"]));
  ensure(served.kind === "zenith-default-journey" && served.nonce === tenant.witness, "served-witness");
  return sha256({ uid: objects[0].metadata.uid, generation: objects[0].metadata.generation, spec: objects[0].spec, served });
}
export async function runDriverCli(scenarioId: DriverScenario, driver: (input: DriverInput) => Promise<number>, args = process.argv.slice(2)): Promise<number> {
  const env = process.env;
  if (env.ZENITH_LOCAL_DRIVER_D4 !== "1") return 2;
  try {
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      ensure(["--receipt", "--run-id"].includes(args[i]) && args[i + 1] && !flags[args[i]], "driver-usage"); flags[args[i]] = args[i + 1];
    }
    ensure(flags["--receipt"] && flags["--run-id"], "driver-usage");
    return await driver({ scenarioId, env, runId: flags["--run-id"], sourceCommit: sourceBinding().head, receiptFile: flags["--receipt"] });
  } catch { process.stderr.write("Operated rehearsal refused or failed; inspect only the sanitized receipt.\n"); return 1; }
}
