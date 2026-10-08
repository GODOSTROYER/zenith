/** Shared J1/J2 authority paths for DRV-3. Opt-in disposable Mac rehearsal only. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import { readPrepared, sourceBinding } from "../../deploy/installation.mjs";
import { readState, compose, docker, cleanup } from "../../acceptance/default-stack/runtime.mjs";
import { ports } from "../../acceptance/default-stack/config.mjs";
import { hostEnvironment } from "../../acceptance/default-stack/env.mjs";
import { seededEpoch } from "../../acceptance/maintenance/preconditions";
import { Config, privateFile, prerequisites, operator, login } from "../../../tests/e2e/default/support.mjs";
import {
  ensure, nonce, browserRequest, jsonRequest, ok, action, until, kubeconfig, linkedAgent, mcp, kindReadback,
} from "../../../tests/e2e/default/support.mjs";
import { enrollOperator } from "../../../tests/e2e/default/mfa.mjs";
import { openPlatformDb } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { defaultExec, classifyVitest } from "../acceptance-orchestrator";
import { assertLocalDocker, localPaths, waitFor } from "../local-environment";
import { requiredChecks, validateLocalReceipt, type LocalReceipt } from "../local-targets";

// J2's JS helper accepts JSON bodies; its inferred default-argument declaration
// omits that optional field. Preserve the actual helper contract explicitly.
const productRequest = jsonRequest as (url: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; data: unknown }>;
type OperationStatusView = { operation: { status: string; approvalRound: number } };

export type OperatedScenario = "upgrade" | "restore";
export interface DriverInput { scenarioId: OperatedScenario; runId: string; sourceCommit: string; receiptFile: string; env: NodeJS.ProcessEnv }

/** Always attempt every owned cleanup in dependency order, preserving failure. */
export async function finishOwned(actions: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) { try { await action(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new Error("operated:owned-cleanup-failed");
}
export function assertOperatedGate(input: DriverInput): void {
  localPaths(input.env);
  if (input.env.ZENITH_LOCAL_OPERATED !== "1" || input.env.ZENITH_LOCAL_JOINED_DRIVERS !== "1"
    || input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || input.env.ZENITH_DEFAULT_JOURNEY !== "1") throw new Error("operated:explicit-gates-required");
  if (input.runId !== input.env.ZENITH_LOCAL_RUN_ID || !/^[a-f0-9]{40}$/.test(input.sourceCommit)
    || !path.isAbsolute(input.receiptFile) || existsSync(input.receiptFile)) throw new Error("operated:input-binding");
}
export function receiptFor(input: DriverInput, checks: LocalReceipt["checks"]): LocalReceipt {
  const receipt: LocalReceipt = { schema: 1, scenarioId: input.scenarioId, runId: input.runId, sourceCommit: input.sourceCommit,
    evidenceLabel: "local_operated_rehearsal", checks,
    limits: ["Owned local operated rehearsal. No live cloud, production acceptance or release approval.",
      "Lean profile: one API and one worker; pauses are observable, no high availability claim.",
      "J2 kind target and real browser identities; local Kubernetes credentials stay in the tenant vault."] };
  return validateLocalReceipt(receipt, input);
}

export class OperatedSession {
  readonly facts: LocalReceipt["checks"] = [];
  readonly privateFiles: string[] = [];
  readonly finalizers: (() => Promise<void>)[] = [];
  state!: ReturnType<typeof readState>;
  prepared!: ReturnType<typeof readPrepared>;
  config!: z.infer<typeof Config>;
  stack!: Awaited<ReturnType<typeof prerequisites>>;
  browser?: Browser;
  a!: Page; b!: Page;
  db!: PlatformDb;
  environment!: NodeJS.ProcessEnv;
  workspaceId!: string;
  project!: { id: string; slug: string; name: string; connectionId?: string };
  environmentId!: string;
  linked!: Awaited<ReturnType<typeof linkedAgent>>;
  readonly marker = nonce();
  activeState!: ReturnType<typeof readState>;
  constructor(readonly input: DriverInput) {}
  async step(id: string, work: () => Promise<void>): Promise<void> {
    try { await work(); this.facts.push({ id, status: "passed" }); }
    catch { this.facts.push({ id, status: "failed" }); throw new Error("operated:" + id); }
  }
  privateJson(name: string, value: unknown): string {
    const file = path.join(this.input.env.ZENITH_LOCAL_ROOT!, `${this.input.scenarioId}-${name}.json`);
    writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); this.privateFiles.push(file); return file;
  }
  async prepare(): Promise<void> {
    ensure(process.platform === "darwin" && process.arch === "arm64" && process.versions.node.startsWith("22."), "native-mac-node22");
    await assertLocalDocker(this.input.env);
    const root = this.input.env.ZENITH_LOCAL_ROOT!;
    ensure(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink() && (lstatSync(root).mode & 0o077) === 0, "private-scratch");
    const file = this.input.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE;
    ensure(file && path.isAbsolute(file), "journey-config");
    this.config = Config.parse(JSON.parse(privateFile(file!)));
    ensure(this.config.stackDirectory === this.input.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "stack-config-binding");
    this.state = readState(this.config.stackDirectory);
    this.activeState = this.state;
    ensure(this.state.profile === "lean" && this.state.source.head === this.input.sourceCommit, "lean-source-binding");
    this.finalizers.push(async () => {
      const result = await cleanup(this.state);
      ensure(result.ownedResourcesRemaining === 0, "j1-absence");
    });
    const targetFile = path.join(path.dirname(file!), "targets.json");
    const targets = JSON.parse(privateFile(targetFile));
    const [node] = JSON.parse(await docker(["inspect", "zenith-j2-control-plane"]));
    ensure(targets.schemaVersion === 1 && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.status === "created"
      && targets.kind === "zenith-j2" && targets.containerId === node.Id && node.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "owned-j2-target");
    // Ownership is admitted before readiness/setup can fail. This invocation takes
    // custody of the fresh J1/J2 fixtures, including on every later failure.
    this.finalizers.unshift(async () => {
      const [current] = JSON.parse(await docker(["inspect", "zenith-j2-control-plane"]));
      ensure(current.Id === targets.containerId && current.Config.Labels?.["io.x-k8s.kind.cluster"] === "zenith-j2", "cleanup-kind-owner");
      await this.exec(["kind", "delete", "cluster", "--name", "zenith-j2"]);
      ensure(!(await this.exec(["kind", "get", "clusters"])).split(/\s+/).includes("zenith-j2"), "kind-absence");
    });
    this.prepared = readPrepared(path.join(this.state.directory, "installation"));
    this.environment = { ...this.input.env, ...hostEnvironment(this.state) };
    this.stack = await prerequisites(this.config, { commit: this.state.source.head, sourceDigest: this.state.source.contentSha256, dirty: this.state.source.dirty });
    const direct = new URL(this.prepared.environment.ZENITH_PLATFORM_MIGRATION_URL);
    ensure(direct.hostname === "supabase-db" && direct.port === "5432" && direct.pathname === "/postgres", "j1-direct-database");
    direct.hostname = "127.0.0.1"; direct.port = String(ports.db);
    this.environment.ZENITH_PLATFORM_DB_URL = direct.href;
    this.db = await openPlatformDb({ kind: "postgres", url: direct.href, max: 2, migrate: false });
    await seededEpoch(this.db); // J4's actual migration-seeded epoch, no repair.
    const counts = await this.db.query<{ n: number }>("select count(*)::int as n from platform.provider_connections");
    ensure(counts[0].n === 0, "fresh-driver-stack");
    kubeconfig(this.config.kind.kubeconfigFile, this.config);
    this.browser = await chromium.launch({ headless: true });
    this.a = await (await this.browser.newContext()).newPage(); this.b = await (await this.browser.newContext()).newPage();
    const users: string[] = [];
    const userA = await operator(this.stack, this.config.mailpitUrl, "a", users);
    const userB = await operator(this.stack, this.config.mailpitUrl, "b", users);
    await login(this.a, this.stack, userA); await login(this.b, this.stack, userB);
    await enrollOperator(this.a, this.stack); await enrollOperator(this.b, this.stack);
    this.workspaceId = ok(await browserRequest(this.a, "/api/workspace", { name: `DRV3 ${this.input.runId}` })).workspace.id;
    const invite = ok(await browserRequest(this.a, "/api/workspace/invites", { email: userB.email, role: "admin", workspaceId: this.workspaceId })).invite;
    ensure(ok(await browserRequest(this.b, `/api/workspace/invites/${invite.id}/accept`, {})).member.id === userB.id, "independent-admin");
    const name = `DRV3 witness ${this.input.runId}`;
    const project = await action(this.a, "project.create", { name, withEnvironment: false });
    this.project = { id: project.projectId, slug: project.slug, name };
    const manifest = { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
      providerConfig: { kubernetes: { namespace: this.config.kind.namespace } }, services: [{ id: "witness", name: "witness", kind: "web",
        source: { type: "image", image: this.config.kind.image }, size: "small", replicas: 1, port: 8080, healthPath: "/", ownership: "managed",
        env: [{ key: "WITNESS_NONCE", value: this.marker }] }], resources: [], routes: [], bindings: [] };
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    await action(this.a, "system.setSecret", { projectId: this.project.id, serviceId: "witness", key: "DRV3_KUBE", secretRef: "vault:DRV3_KUBE", secretValue: privateFile(this.config.kind.kubeconfigFile) });
    await action(this.a, "project.updateManifest", { projectId: this.project.id, manifest });
    this.project.connectionId = (await action(this.a, "connection.createKubernetes", { label: `DRV3 ${this.input.runId}`, server: this.config.kind.server,
      caData: kubeconfig(this.config.kind.kubeconfigFile, this.config).caData, namespaces: [this.config.kind.namespace], credentialRef: "vault:DRV3_KUBE", scopedGuest: false })).connectionId;
    await this.a.goto(this.stack.apiUrl + "/platform/connections");
    const card = this.a.getByRole("listitem").filter({ hasText: `DRV3 ${this.input.runId}` });
    const verified = this.a.waitForResponse(r => r.url().endsWith(`/connections/${this.project.connectionId}/verify`) && r.request().method() === "POST");
    await card.getByRole("button", { name: "Verify", exact: true }).click(); ensure((await verified).ok(), "connection-verify");
    this.environmentId = (await action(this.a, "env.create", { projectId: this.project.id, name: "production", class: "production", connectionId: this.project.connectionId, approvalRequired: true })).environmentId;
    this.linked = await linkedAgent(this.a, this.stack, this.project, this.workspaceId);
  }
  async exec(argv: readonly string[]): Promise<string> {
    const result = await defaultExec(argv, { cwd: process.cwd(), env: this.environment ?? this.input.env, timeoutMs: 1_080_000 });
    ensure(result.code === 0, "owned-command"); return result.stdout;
  }
  async gates(files: readonly string[], env: Partial<NodeJS.ProcessEnv> = {}): Promise<void> {
    const report = path.join(this.input.env.ZENITH_LOCAL_ROOT!, `${this.input.scenarioId}-gates.json`);
    ensure(!existsSync(report), "fresh-gate-report"); this.privateFiles.push(report);
    const run = await defaultExec([process.execPath, "node_modules/vitest/vitest.mjs", "run", ...files, "--project=node", "--no-file-parallelism", "--maxWorkers=2", "--reporter=json", `--outputFile=${report}`],
      { cwd: process.cwd(), env: { ...this.environment, ...env }, timeoutMs: 1_080_000 });
    ensure(classifyVitest(run.code, JSON.parse(readFileSync(report, "utf8"))).status === "passed", "strict-gate-result");
  }
  async detail(id: string) { return ok(await browserRequest(this.a, `/api/platform/v1/operations/${id}`, undefined, "GET", this.workspaceId)); }
  async approve(id: string): Promise<void> {
    const detail = await this.detail(id);
    ensure(detail.operation.status === "awaiting_approval" && detail.decision?.approval?.separationOfDuties === true, "human-review-required");
    await this.b.goto(this.stack.apiUrl + `/platform/operations/${id}`);
    const response = this.b.waitForResponse(r => r.url().endsWith(`/operations/${id}/approve`) && r.request().method() === "POST");
    await this.b.getByRole("button", { name: /^Approve / }).click();
    ensure((await response).ok(), "browser-approval");
    ensure((await this.detail(id)).approvals.some((v: { decision: string }) => v.decision === "approve"), "approval-readback");
  }
  async deployReview(): Promise<{ operationId: string; deploymentId: string }> {
    await this.a.goto(this.stack.apiUrl + `/p/${this.project.slug}/system?env=${this.environmentId}`);
    await this.a.getByRole("button", { name: /pending change.*Review/ }).click();
    await this.a.getByLabel("Type production to confirm deploying to production", { exact: true }).fill("production");
    const response = this.a.waitForResponse(r => r.url().endsWith("/api/actions/deploy.apply") && r.request().method() === "POST");
    await this.a.getByRole("button", { name: "Request approval for production", exact: true }).click();
    const answer = await (await response).json();
    ensure(answer.result?.ok && answer.result.data.operationId, "browser-deploy");
    const result = answer.result.data;
    await this.approve(result.operationId);
    await action(this.b, "deploy.approve", { deploymentId: result.deploymentId }, { projectId: this.project.id, environmentId: this.environmentId });
    const review = await until(() => this.detail(result.operationId), (v: OperationStatusView) => v.operation.status === "awaiting_approval" && v.operation.approvalRound > 0);
    ensure(review.operation.planDigest && review.planReview?.semantics?.digest, "immutable-plan-review");
    return result;
  }
  async completeDeploy(id: string): Promise<void> {
    await this.approve(id);
    const terminal = await until(() => this.detail(id), (v: OperationStatusView) => ["succeeded", "failed", "uncertain"].includes(v.operation.status));
    ensure(terminal.operation.status === "succeeded", "deployment-terminal");
    await kindReadback(this.config, 1, this.marker);
  }
  async proposeScale(replicas: number): Promise<string> {
    const proposed = ok(await productRequest(this.stack.apiUrl + "/api/platform/v1/capabilities/propose", { method: "POST",
      headers: { authorization: "Bearer " + this.linked.token, "x-zenith-workspace": this.workspaceId },
      body: { capability: "service.scale", scope: { workspaceId: this.workspaceId, projectId: this.project.id, environmentId: this.environmentId, resourceId: "witness" },
        input: { operation: "scale", serviceId: "witness", replicas }, idempotencyKey: nonce() } }));
    ensure(proposed.operation.status === "awaiting_approval", "rest-approval-gate"); return proposed.operation.id;
  }
  async execute(id: string, allowError = false) {
    return mcp(this.stack, this.linked.token, "tools/call", { name: "zenith_execute_approved_operation",
      arguments: { workspaceId: this.workspaceId, operationId: id, expectedDigest: (await this.detail(id)).operation.proposalDigest } }, allowError);
  }
  async scaleComplete(id: string, replicas: number): Promise<void> {
    await this.execute(id);
    const terminal = await until(() => this.detail(id), (v: OperationStatusView) => ["succeeded", "failed", "uncertain"].includes(v.operation.status));
    ensure(terminal.operation.status === "succeeded", "scale-terminal"); await kindReadback(this.config, replicas, this.marker);
  }
  async replacement(images?: { api: string; worker: string; migration: string }, database?: string): Promise<ReturnType<typeof readState>> {
    const text = privateFile(path.join(this.state.directory, "installation/stack.compose.json"));
    // privateFile trims its return; hash the exact raw file instead.
    ensure(createHash("sha256").update(readFileSync(path.join(this.state.directory, "installation/stack.compose.json"))).digest("hex") === this.activeState.compositionSha256, "composition-drift");
    const document = JSON.parse(text);
    for (const [service, image] of [["api", images?.api], ["execution-worker", images?.worker], ["platform-migrate", images?.migration]]) {
      if (image) document.services[service!].image = image;
      if (database) {
        const pooled = new URL(this.prepared.environment.SUPABASE_DB_URL); pooled.pathname = `/${database}`;
        const direct = new URL(this.prepared.environment.ZENITH_PLATFORM_MIGRATION_URL); direct.pathname = `/${database}`;
        Object.assign(document.services[service!].environment, { SUPABASE_DB_URL: pooled.href, ZENITH_PLATFORM_DB_URL: service === "platform-migrate" ? direct.href : pooled.href,
          ...(service === "platform-migrate" ? { ZENITH_PLATFORM_MIGRATION_URL: direct.href } : {}), ZENITH_PLATFORM_DB_MAX: "2" });
      }
    }
    // runtime.compose preserves all J1 labels/network/health/limits and verifies
    // this invocation's private composition bytes before each Docker operation.
    const file = path.join(this.state.directory, "installation/stack.compose.json");
    this.privateFiles.push(file); // removed by J1 cleanup, not by file finalizer
    writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    this.activeState = { ...this.state, compositionSha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
    return this.activeState;
  }
  async healthy(state: ReturnType<typeof readState>, service: string, image?: string): Promise<void> {
    await waitFor(async () => {
      const id = (await compose(state, ["ps", "-q", service])).trim(); if (!id) return false;
      const [item] = JSON.parse(await docker(["inspect", id]));
      return item.Config.Labels?.["io.zenith.installation"] === this.state.applicationInstallationId
        && item.State.Health?.Status === "healthy" && (!image || item.Config.Image === image);
    }, 360_000);
  }
  async finish(): Promise<void> {
    await finishOwned([
      async () => { if (this.browser) await this.browser.close(); },
      ...this.finalizers,
      async () => { if (this.db) await this.db.close(); },
      async () => { for (const file of this.privateFiles) if (!file.startsWith(this.state?.directory + path.sep) && existsSync(file)) unlinkSync(file); },
    ]);
  }
}

export async function driverCli(scenarioId: OperatedScenario, run: (input: DriverInput) => Promise<number>, argv = process.argv.slice(2), env = process.env): Promise<number> {
  // Standalone drivers share the runner's explicit gates. No gate means no I/O.
  if (env.ZENITH_LOCAL_OPERATED !== "1") return 2;
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !["--run-id", "--source-commit", "--receipt"].includes(key) || !value || key in values) return 2;
    values[key] = value;
  }
  if (!values["--run-id"] || !values["--source-commit"] || !values["--receipt"]) return 2;
  try { return await run({ scenarioId, runId: values["--run-id"], sourceCommit: values["--source-commit"], receiptFile: values["--receipt"], env }); }
  catch { process.stderr.write("Operated driver refused; no evidence accepted.\n"); return 1; }
}

export async function operatedRun(input: DriverInput, work: (session: OperatedSession) => Promise<void>): Promise<number> {
  assertOperatedGate(input); // no credentials, engines or files before opt-in
  const session = new OperatedSession(input);
  let failed = false;
  try {
    await session.step("preconditions", () => session.prepare());
    await work(session);
    await session.step("source-bound", async () => ensure(JSON.stringify(sourceBinding()) === JSON.stringify(session.state.source), "source-drift"));
  } catch { failed = true; }
  finally {
    try { await session.step("cleanup", () => session.finish()); } catch { failed = true; }
  }
  for (const id of requiredChecks(input.scenarioId)) if (!session.facts.some(c => c.id === id)) session.facts.push({ id, status: "skipped" });
  const receipt = receiptFor(input, session.facts);
  writeFileSync(input.receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  return failed || receipt.checks.some(c => c.status !== "passed") ? 1 : 0;
}
