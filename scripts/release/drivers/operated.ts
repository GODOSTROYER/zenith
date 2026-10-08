/** Real operated J1/J2 plumbing. Every caller must opt in before credentials or engines are touched. */
import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { load as yamlLoad } from "js-yaml";
import { sourceBinding } from "../../deploy/installation.mjs";
import { readState, cleanup as cleanupStack } from "../../acceptance/default-stack/runtime.mjs";
import { Config, action, adminHeaders, browserRequest, command, ensure, jsonRequest, kindReadback, kubeconfig, linkedAgent, login, mcp, nonce, ok, operator, prerequisites, privateFile, sha256, until as journeyUntil } from "../../../tests/e2e/default/support.mjs";
import { enrollOperator } from "../../../tests/e2e/default/mfa.mjs";
import { localPaths, assertLocalDocker } from "../local-environment";
import { localEnvironment } from "../local-targets";
import { DRIVER_CHECKS, OwnedCleanup, driverPlan, operatedReceipt, observerBinding, type DriverScenario } from "./operated-contract";

export interface Detail {
  operation: { id: string; status: string; proposalDigest: string; planDigest?: string; approvalRound: number; workflowId?: string; fenceToken?: number };
  decision?: { approval?: { separationOfDuties?: boolean } };
  planReview?: { semantics?: { digest?: string } };
  approvals: { approverId: string; decision: string }[];
}
export interface Deployment {
  metadata: { uid: string; generation: number; annotations: Record<string, string>; labels: Record<string, string> };
  spec: { replicas: number; template: { metadata: { annotations?: Record<string, string> }; spec: { containers: { image: string; env?: { name: string; value?: string }[] }[] } } };
}
type JourneyConfig = ReturnType<typeof Config.parse>;
type Stack = Awaited<ReturnType<typeof prerequisites>>;

export class OperatedSession {
  readonly faults = new OwnedCleanup();
  readonly cleanup = new OwnedCleanup();
  readonly users: string[] = [];
  readonly witnessNonce = nonce();
  readonly readbacks: Record<string, string> = {};
  config!: JourneyConfig;
  stack!: Stack;
  a!: Page;
  b!: Page;
  browser?: Browser;
  workspaceId = "";
  environmentId = "";
  project?: { id: string; slug: string; name: string };
  linked?: { token: string; credentialId: string };
  private targetId?: string;
  private stackCleanup?: () => Promise<void>;

  async prepare(env: NodeJS.ProcessEnv, binding: ReturnType<typeof sourceBinding>): Promise<void> {
    this.config = Config.parse(JSON.parse(privateFile(env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE)));
    ensure(fs.realpathSync(this.config.stackDirectory) === fs.realpathSync(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR!), "stack-config-binding");
    const ownedStack = readState(this.config.stackDirectory);
    ensure(ownedStack.profile === "lean", "owned-lean-stack");
    this.stackCleanup = async () => { await cleanupStack(ownedStack); };
    const targetDirectory = path.dirname(fs.realpathSync(env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE!));
    ensure([this.config.kind.observerKubeconfigFile, this.config.kind.kubeconfigFile, this.config.kind.rotationKubeconfigFile].every(file => path.dirname(fs.realpathSync(file)) === targetDirectory), "owned-config-directory");
    const targets = JSON.parse(privateFile(path.join(targetDirectory, "targets.json"))) as { kind?: string; createdBy?: string; status?: string; containerId?: string };
    ensure(targets.kind === "zenith-j2" && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.status === "created" && /^[a-f0-9]{64}$/.test(targets.containerId ?? ""), "owned-kind-receipt");
    const [node] = JSON.parse(await command("docker", ["inspect", "zenith-j2-control-plane"])) as { Id: string; Config: { Labels: Record<string, string> } }[];
    ensure(node.Id === targets.containerId && node.Config.Labels["io.x-k8s.kind.cluster"] === "zenith-j2", "owned-kind-identity");
    this.targetId = node.Id;
    // This invocation takes responsibility for the fresh prepared J2 fixture. J1 is borrowed.
    this.cleanup.add(async () => {
      const clusters = await command("kind", ["get", "clusters"]);
      if (clusters.split(/\s+/).includes("zenith-j2")) {
        const [current] = JSON.parse(await command("docker", ["inspect", "zenith-j2-control-plane"])) as { Id: string; Config: { Labels: Record<string, string> } }[];
        ensure(current.Id === this.targetId && current.Config.Labels["io.x-k8s.kind.cluster"] === "zenith-j2", "cleanup-kind-identity");
        await command("kind", ["delete", "cluster", "--name", "zenith-j2"], { timeout: 120_000 });
      }
      ensure(!(await command("kind", ["get", "clusters"])).split(/\s+/).includes("zenith-j2"), "cleanup-kind-absence");
      const credentials = new OwnedCleanup();
      for (const name of ["observer.json", "deployer-old.json", "deployer-new.json", "kind-bootstrap.yaml"]) credentials.add(async () => {
        const file = path.join(targetDirectory, name);
        if (fs.existsSync(file)) { privateFile(file); fs.unlinkSync(file); }
      });
      await credentials.run();
    });
    const deployer = kubeconfig(this.config.kind.kubeconfigFile, this.config);
    const observer = observerBinding(yamlLoad(privateFile(this.config.kind.observerKubeconfigFile)), deployer.caData);
    const actual = observerBinding(yamlLoad(await command("kind", ["get", "kubeconfig", "--name", "zenith-j2"])), deployer.caData);
    ensure(observer === actual, "observer-exact-owned-cluster");
    this.stack = await prerequisites(this.config, { commit: binding.head, sourceDigest: binding.contentSha256, dirty: binding.dirty });
    const ready = await this.stack.modules.compose(this.stack.state, ["ps", "-q", "execution-worker"]);
    ensure(ready.trim() === this.stack.worker, "owned-worker");
    // A prepared target must be fresh; never run faults against another journey's workload.
    const objects = JSON.parse(await this.kubectl(["get", "deployments", "-o", "json"])) as { items: unknown[] };
    ensure(objects.items.length === 0, "fresh-kind-workload");
    kubeconfig(this.config.kind.kubeconfigFile, this.config);
    this.browser = await chromium.launch({ headless: true });
    this.a = await (await this.browser.newContext({ ignoreHTTPSErrors: false })).newPage();
    this.b = await (await this.browser.newContext({ ignoreHTTPSErrors: false })).newPage();
    // Register user/link cleanup before the first partially successful creation.
    this.cleanup.add(async () => {
      if (this.linked) ok(await browserRequest(this.a, "/api/integrations/agent/link/revoke", { credentialId: this.linked.credentialId }));
    });
    this.cleanup.add(async () => {
      const tasks = new OwnedCleanup();
      for (const id of this.users) tasks.add(async () => {
        ok(await jsonRequest(this.stack.supabaseUrl + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: adminHeaders(this.stack) }));
        const absent = await jsonRequest(this.stack.supabaseUrl + "/auth/v1/admin/users/" + id, { headers: adminHeaders(this.stack) });
        ensure(absent.status === 404, "cleanup-auth-absence");
      });
      await tasks.run();
    });
    const operatorA = await operator(this.stack, this.config.mailpitUrl, "a", this.users);
    const operatorB = await operator(this.stack, this.config.mailpitUrl, "b", this.users);
    await login(this.a, this.stack, operatorA); await login(this.b, this.stack, operatorB);
    await enrollOperator(this.a, this.stack); await enrollOperator(this.b, this.stack);
    const workspace = ok(await browserRequest(this.a, "/api/workspace", { name: "Zenith DRV2 " + nonce() })).workspace as { id: string };
    this.workspaceId = workspace.id;
    const invite = ok(await browserRequest(this.a, "/api/workspace/invites", { email: operatorB.email, role: "admin", workspaceId: workspace.id })).invite as { id: string };
    const accepted = ok(await browserRequest(this.b, "/api/workspace/invites/" + invite.id + "/accept", {}));
    ensure(accepted.member?.id === operatorB.id && accepted.member?.role === "admin", "independent-member");
  }

  async deploy(): Promise<void> {
    const name = "DRV2 witness " + nonce();
    const created = await action(this.a, "project.create", { name, withEnvironment: false });
    this.project = { id: created.projectId, slug: created.slug, name };
    const manifest = { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
      providerConfig: { kubernetes: { namespace: this.config.kind.namespace } },
      services: [{ id: "witness", name: "witness", kind: "web", source: { type: "image", image: this.config.kind.image },
        size: "small", replicas: 1, port: 8080, healthPath: "/", ownership: "managed", env: [{ key: "WITNESS_NONCE", value: this.witnessNonce }] }],
      resources: [], routes: [], bindings: [] };
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    await action(this.a, "system.setSecret", { projectId: this.project.id, serviceId: "witness", key: "DRV2_KUBE", secretRef: "vault:DRV2_KUBE", secretValue: privateFile(this.config.kind.kubeconfigFile) });
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    const target = kubeconfig(this.config.kind.kubeconfigFile, this.config);
    const connection = await action(this.a, "connection.createKubernetes", { label: name, server: this.config.kind.server,
      caData: target.caData, namespaces: [this.config.kind.namespace], credentialRef: "vault:DRV2_KUBE", scopedGuest: false });
    const verified = ok(await browserRequest(this.a, "/api/platform/v1/connections/" + connection.connectionId + "/verify", {}, "POST", this.workspaceId));
    ensure(verified.ok === true, "connection-verified");
    const environment = await action(this.a, "env.create", { projectId: this.project.id, name: "production", class: "production", connectionId: connection.connectionId, approvalRequired: true });
    this.environmentId = environment.environmentId;
    this.linked = await linkedAgent(this.a, this.stack, this.project, this.workspaceId);
    await this.a.goto(this.stack.apiUrl + "/p/" + this.project.slug + "/system?env=" + this.environmentId);
    await this.a.getByRole("button", { name: /pending change.*Review/ }).click();
    await this.a.getByLabel("Type production to confirm deploying to production", { exact: true }).fill("production");
    const response = this.a.waitForResponse(value => value.url().endsWith("/api/actions/deploy.apply") && value.request().method() === "POST");
    await this.a.getByRole("button", { name: "Request approval for production", exact: true }).click();
    const answer = await (await response).json();
    ensure(answer.result?.ok && answer.result.data.operationId && answer.result.data.deploymentId, "browser-deploy-proposal");
    const { operationId, deploymentId } = answer.result.data as { operationId: string; deploymentId: string };
    await this.approve(operationId);
    await action(this.b, "deploy.approve", { deploymentId }, { projectId: this.project.id, environmentId: this.environmentId });
    await until(() => this.detail(operationId), value => value.operation.status === "awaiting_approval" && value.operation.approvalRound > 0);
    await this.approve(operationId);
    await this.terminal(operationId);
    this.readbacks.baseline = await this.readback(1);
  }
  detail(id: string): Promise<Detail> { return browserRequest(this.a, "/api/platform/v1/operations/" + id, undefined, "GET", this.workspaceId).then(ok) as Promise<Detail>; }
  async approve(id: string): Promise<void> {
    const before = await this.detail(id);
    ensure(before.operation.status === "awaiting_approval" && before.decision?.approval?.separationOfDuties === true, "approval-required");
    const body = { proposalDigest: before.operation.proposalDigest, ...(before.operation.planDigest ? { planDigest: before.operation.planDigest } : {}), ...(before.planReview?.semantics?.digest ? { semanticsDigest: before.planReview.semantics.digest } : {}) };
    const self = await browserRequest(this.a, "/api/platform/v1/operations/" + id + "/approve", body, "POST", this.workspaceId);
    ensure(self.status === 403 && self.data.error?.code === "separation_of_duties", "self-approval-refused");
    await this.b.goto(this.stack.apiUrl + "/platform/operations/" + id);
    const response = this.b.waitForResponse(value => value.url().endsWith("/operations/" + id + "/approve") && value.request().method() === "POST");
    await this.b.getByRole("button", { name: /^Approve / }).click();
    const approvedResponse = await response;
    ensure(approvedResponse.ok() && (await approvedResponse.json()).operation?.status === "approved", "browser-approval");
    const after = await this.detail(id);
    ensure(after.operation.proposalDigest === before.operation.proposalDigest && after.approvals.some(value => value.approverId === this.users[1] && value.decision === "approve"), "independent-approved-digest");
  }
  async propose(replicas: number, surface: "rest" | "mcp" = "mcp"): Promise<string> {
    ensure(this.project && this.linked, "deployed-scope");
    if (surface === "rest") {
      const options = { method: "POST",
        headers: { authorization: "Bearer " + this.linked!.token, "x-zenith-workspace": this.workspaceId },
        body: { capability: "service.scale", scope: { workspaceId: this.workspaceId, projectId: this.project!.id, environmentId: this.environmentId, resourceId: "witness" },
          input: { operation: "scale", serviceId: "witness", replicas }, idempotencyKey: nonce() } };
      const result = ok(await jsonRequest(this.stack.apiUrl + "/api/platform/v1/capabilities/propose", options));
      ensure(result.operation?.status === "awaiting_approval", "rest-proposal-gated");
      return result.operation.id as string;
    }
    const result = await mcp(this.stack, this.linked!.token, "tools/call", { name: "zenith_scale_service",
      arguments: { target: { workspaceId: this.workspaceId, projectId: this.project!.id, environmentId: this.environmentId }, serviceId: "witness", replicas, idempotencyKey: nonce() } });
    ensure(result.data.status === "awaiting_approval" && result.data.executed === false, "mcp-proposal-gated");
    return result.data.operationId as string;
  }
  async execute(id: string): Promise<string> {
    const detail = await this.detail(id);
    const result = await mcp(this.stack, this.linked!.token, "tools/call", { name: "zenith_execute_approved_operation",
      arguments: { workspaceId: this.workspaceId, operationId: id, expectedDigest: detail.operation.proposalDigest } });
    ensure(result.data.workflow?.id, "durable-workflow");
    return result.data.workflow.id as string;
  }
  async terminal(id: string): Promise<Detail> {
    const result = await until(() => this.detail(id), value => ["succeeded", "failed", "denied", "uncertain", "cancelled", "expired"].includes(value.operation.status), 300_000);
    ensure(result.operation.status === "succeeded", "terminal-success-required");
    return result;
  }
  kubectl(args: string[]): Promise<string> { return command("kubectl", ["--kubeconfig", this.config.kind.observerKubeconfigFile, "--context", this.config.kind.context, "-n", this.config.kind.namespace, ...args]); }
  async deployment(): Promise<Deployment> {
    const object = JSON.parse(await this.kubectl(["get", "deployment", "witness", "-o", "json"])) as Deployment;
    ensure(object.metadata.labels["app.kubernetes.io/managed-by"] === "zenith" && object.metadata.annotations["zenith.dev/environment"] === this.environmentId && object.metadata.annotations["zenith.dev/resource"] === "service/witness", "owned-workload");
    ensure(object.spec.template.spec.containers[0].env?.some(value => value.name === "WITNESS_NONCE" && value.value === this.witnessNonce), "owned-workload-nonce");
    return object;
  }
  async readback(replicas: number): Promise<string> { await this.deployment(); return kindReadback(this.config, replicas, this.witnessNonce); }
  async finish(): Promise<void> {
    let failed = false;
    try { await this.faults.run(); } catch { failed = true; }
    // Drain the real worker before removing its provider target. Keep browser/API alive for revocation.
    if (this.stack) {
      try { await this.stack.modules.compose(this.stack.state, ["stop", "--timeout", "660", "execution-worker"]); }
      catch { failed = true; }
    }
    // Browser credentials remain alive until link/project/user cleanup finishes.
    try { await this.cleanup.run(); } catch { failed = true; }
    try { await this.browser?.close(); } catch { failed = true; }
    // The explicit DRV-2 gate transfers the disposable J1 stack to this run.
    // Its existing labelled cleanup also removes all local product/audit data.
    try { await this.stackCleanup?.(); } catch { failed = true; }
    if (failed) throw new Error("Owned operated cleanup incomplete");
  }
}

export type DriverStep = (id: string, work: () => Promise<void>) => Promise<void>;
export async function runOperated(input: { scenarioId: DriverScenario; receiptFile: string; env: NodeJS.ProcessEnv }, work: (session: OperatedSession, step: DriverStep) => Promise<void>): Promise<number> {
  if (driverPlan(input.scenarioId, input.env).missing.length) return 2;
  const { runId } = localPaths(input.env);
  ensure(process.platform === "darwin" && process.arch === "arm64" && process.versions.node.startsWith("22."), "native-mac-node22");
  const parent = fs.realpathSync(path.dirname(input.receiptFile));
  ensure(path.isAbsolute(input.receiptFile) && !fs.existsSync(input.receiptFile) && parent === path.dirname(input.receiptFile) && !parent.startsWith(path.resolve(process.cwd()) + path.sep) && parent !== process.cwd() && (fs.statSync(parent).mode & 0o077) === 0, "private-fresh-receipt");
  const binding = sourceBinding();
  // Existing J2 subprocess helpers read process.env. Contain them to the same closed local environment.
  const previousEnvironment = process.env;
  process.env = localEnvironment(input.env);
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  const session = new OperatedSession();
  const facts: { id: string; status: "passed" | "failed" | "skipped" }[] = [];
  const step: DriverStep = async (id, operation) => {
    ensure((DRIVER_CHECKS[input.scenarioId] as readonly string[]).includes(id) && !facts.some(fact => fact.id === id), "owned-step-inventory");
    try {
      if (id !== "cleanup") abort.signal.throwIfAborted();
      await operation();
      if (id !== "cleanup") abort.signal.throwIfAborted();
      facts.push({ id, status: "passed" });
    }
    catch { facts.push({ id, status: "failed" }); throw new Error("Operated step failed"); }
  };
  try { await step("prerequisites", async () => { await assertLocalDocker(process.env); await session.prepare(process.env, binding); }); await step("approved-workload", () => session.deploy()); await work(session, step); }
  catch { /* Only fixed vocabulary escapes; remaining checks become skipped. */ }
  finally {
    try { await step("cleanup", () => session.finish()); } catch { /* All registered cleanup has been attempted. */ }
    process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
    process.env = previousEnvironment;
    if (JSON.stringify(sourceBinding()) !== JSON.stringify(binding)) {
      const prerequisite = facts.find(fact => fact.id === "prerequisites");
      if (prerequisite) prerequisite.status = "failed";
    }
  }
  const receipt = operatedReceipt({ scenarioId: input.scenarioId, runId, sourceCommit: binding.head, sourceDigest: binding.contentSha256, dirty: binding.dirty, checks: facts, readbacks: session.readbacks });
  fs.writeFileSync(input.receiptFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return receipt.checks.some(check => check.status === "failed") ? 1 : receipt.checks.some(check => check.status !== "passed") ? 3 : 0;
}
/** Preserve the J2 polling implementation while supplying its generic TypeScript contract. */
export function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 180_000): Promise<T> { return journeyUntil(read, predicate, timeout); }
export { command, ensure, sha256 };
