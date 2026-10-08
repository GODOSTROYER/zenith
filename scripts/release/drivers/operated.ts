/** Shared J1/J2 authority paths. Only the explicit Mac gate may open a browser/engine. */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import postgres from "postgres";
import { load as yamlLoad } from "js-yaml";
import { sourceBinding, privateLocation } from "../../deploy/installation.mjs";
import { hostEnvironment } from "../../acceptance/default-stack/env.mjs";
import { readState } from "../../acceptance/default-stack/runtime.mjs";
import { assertLocalDocker, localPaths } from "../local-environment";
import { OPERATED_LABEL, requiredChecks, validateLocalReceipt, type LocalReceipt } from "../local-targets";
import { Config, prerequisites, privateFile, operator, login, browserRequest, jsonRequest, adminHeaders,
  ok, action, until, kubeconfig, linkedAgent, command, nonce, ensure, mcp } from "../../../tests/e2e/default/support.mjs";
import { enrollOperator } from "../../../tests/e2e/default/mfa.mjs";

export type ScenarioId = "private-source" | "update-rollback";
type Stack = Awaited<ReturnType<typeof prerequisites>>;
type ConfigValue = ReturnType<typeof Config.parse>;
export const TERMINAL = ["succeeded", "failed", "uncertain", "denied", "rejected", "cancelled", "expired"];
export function enabled(env: Readonly<Record<string, string | undefined>>) {
  return env.ZENITH_LOCAL_DRV1 === "1" && env.ZENITH_LOCAL_TARGETS === "1"
    && env.ZENITH_DEFAULT_JOURNEY === "1" && env.ZENITH_ACCEPTANCE_DEFAULT_STACK === "1";
}
export function receiptFor(id: ScenarioId, source: { head: string; contentSha256: string; dirty: boolean }, runId: string,
  facts: LocalReceipt["checks"], limits: string[]): LocalReceipt {
  const known = requiredChecks(id);
  if (facts.some(f => !known.includes(f.id)) || new Set(facts.map(f => f.id)).size !== facts.length) throw new Error("Invalid operated facts");
  return validateLocalReceipt({ schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId: id, runId,
    sourceCommit: source.head, sourceDigest: source.contentSha256, dirty: source.dirty,
    checks: known.map(check => facts.find(f => f.id === check) ?? { id: check, status: "skipped" }),
    limits }, { scenarioId: id, runId, sourceCommit: source.head });
}
/** Cleanup is always attempted in authority -> effects -> credentials -> engines order, even after failures. */
export async function cleanupAll(tasks: readonly { id: string; run: () => Promise<void> }[]): Promise<string[]> {
  const failures: string[] = [];
  for (const task of tasks) { try { await task.run(); } catch { failures.push(task.id); } }
  return failures;
}
export interface OwnedObject {
  apiVersion: string; kind: string;
  metadata: { name: string; namespace?: string; uid?: string; annotations?: Record<string, string> };
}
/** Bind the observer to the actual owned container socket/CA, never a remote or exec-auth context. */
export function assertObserver(raw: unknown, target: { caData: string; containerId: string; recordedId: string; ports: { HostIp: string; HostPort: string }[] }) {
  const parsed = raw as { "current-context"?: string; contexts?: { name: string; context?: { cluster?: string; user?: string } }[];
    clusters?: { name: string; cluster?: { server?: string; "certificate-authority-data"?: string; "insecure-skip-tls-verify"?: boolean; "proxy-url"?: string } }[];
    users?: { name: string; user?: Record<string, unknown> }[] };
  ensure(target.containerId === target.recordedId && /^[a-f0-9]{64}$/.test(target.recordedId), "observer-container-identity");
  ensure(parsed?.["current-context"] === "kind-zenith-j2" && Array.isArray(parsed.contexts) && parsed.contexts.length === 1
    && Array.isArray(parsed.clusters) && parsed.clusters.length === 1 && Array.isArray(parsed.users) && parsed.users.length === 1, "observer-single-local-context");
  const context = parsed.contexts![0]!, cluster = parsed.clusters![0]!, user = parsed.users![0]!;
  ensure(context.name === "kind-zenith-j2" && context.context?.cluster === cluster.name && context.context?.user === user.name
    && cluster.cluster?.["certificate-authority-data"] === target.caData && !cluster.cluster?.["insecure-skip-tls-verify"]
    && !cluster.cluster?.["proxy-url"], "observer-context-ca-binding");
  const server = new URL(cluster.cluster!.server!);
  ensure(server.protocol === "https:" && server.hostname === "127.0.0.1" && !server.username && !server.password && !server.search && !server.hash
    && server.pathname === "/" && target.ports.some(port => port.HostIp === "127.0.0.1" && port.HostPort === server.port), "observer-owned-loopback-socket");
  const auth = user.user;
  ensure(auth && Object.keys(auth).sort().join(",") === "client-certificate-data,client-key-data"
    && [auth["client-certificate-data"], auth["client-key-data"]].every(value => typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value)), "observer-static-local-auth");
}
export function cleanupObjects(items: readonly OwnedObject[], environmentId: string, namespace: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(environmentId) || namespace !== "zenith-j2") throw new Error("Invalid owned scope");
  const allowed = new Set(["Deployment", "StatefulSet", "CronJob", "Job", "Service", "Ingress", "ConfigMap", "Secret", "PersistentVolumeClaim", "NetworkPolicy"]);
  return items.filter(item => item.metadata?.annotations?.["zenith.dev/environment"] === environmentId).map(item => {
    if (!allowed.has(item.kind) || item.metadata.namespace !== namespace || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(item.metadata.name)
      || !item.metadata.uid) throw new Error("Owned object inventory refused");
    return item;
  }).sort((a, b) => Number(["Secret", "PersistentVolumeClaim"].includes(a.kind)) - Number(["Secret", "PersistentVolumeClaim"].includes(b.kind)));
}

export class Operated {
  browser?: Browser; a?: Page; b?: Page; stack?: Stack; config?: ConfigValue;
  workspaceId = ""; project?: { id: string; slug: string; name: string; connectionId?: string };
  environmentId = ""; users: string[] = []; operations: string[] = []; linked?: Awaited<ReturnType<typeof linkedAgent>>;
  deployments: string[] = []; cleaners: { id: string; run: () => Promise<void> }[] = [];
  recoveries: { id: string; run: () => Promise<void> }[] = [];
  constructor(readonly scenario: ScenarioId, readonly env: NodeJS.ProcessEnv, readonly scratch: string) {}
  async start(source: ReturnType<typeof sourceBinding>) {
    const configFile = this.env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE;
    ensure(configFile && path.isAbsolute(configFile), "private-j2-config");
    this.config = Config.parse(JSON.parse(privateFile(configFile)));
    ensure(this.config.stackDirectory === this.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "j1-directory-join");
    await assertLocalDocker(this.env);
    this.stack = await prerequisites(this.config, { commit: source.head, sourceDigest: source.contentSha256, dirty: source.dirty });
    const target = kubeconfig(this.config.kind.kubeconfigFile, this.config);
    const targets = JSON.parse(privateFile(path.join(path.dirname(configFile!), "targets.json")));
    const [kindNode] = JSON.parse(await this.stack.modules.docker(["inspect", "zenith-j2-control-plane"]));
    ensure(targets.kind === "zenith-j2" && targets.createdBy === "J2-DEFAULT-JOURNEY" && targets.status === "created", "j2-target-journal");
    assertObserver(yamlLoad(privateFile(this.config.kind.observerKubeconfigFile)), { caData: target.caData, containerId: kindNode.Id,
      recordedId: targets.containerId, ports: kindNode.NetworkSettings.Ports["6443/tcp"] ?? [] });
    Object.assign(this.env, hostEnvironment(this.stack.state));
    // DNS/TLS trust remains the actual J1 CA. No browser certificate bypass.
    this.browser = await (await import("@playwright/test")).chromium.launch({ headless: true });
    this.a = await (await this.browser.newContext()).newPage(); this.b = await (await this.browser.newContext()).newPage();
    // Refuse browser navigation/fetch to any real provider. Private-source adds a LOCAL provider emulator route.
    const origins = new Set([this.stack.apiUrl, this.stack.supabaseUrl]);
    for (const page of [this.a, this.b]) await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return origins.has(url.origin) ? route.continue() : route.abort();
    });
    const userA = await operator(this.stack, this.config.mailpitUrl, "drv1-a", this.users);
    const userB = await operator(this.stack, this.config.mailpitUrl, "drv1-b", this.users);
    await login(this.a, this.stack, userA); await login(this.b, this.stack, userB);
    await enrollOperator(this.a, this.stack); await enrollOperator(this.b, this.stack);
    const workspace = ok(await browserRequest(this.a, "/api/workspace", { name: "DRV-1 " + this.scenario + " " + nonce() })).workspace;
    this.workspaceId = workspace.id;
    const invite = ok(await browserRequest(this.a, "/api/workspace/invites", { email: userB.email, role: "admin", workspaceId: workspace.id })).invite;
    ensure(ok(await browserRequest(this.b, "/api/workspace/invites/" + invite.id + "/accept", {})).member?.id === userB.id, "independent-membership");
    for (const page of [this.a, this.b]) await page.setExtraHTTPHeaders({ "x-zenith-workspace": workspace.id });
    const name = "DRV-1 " + this.scenario + " " + nonce();
    const project = await this.action("project.create", { name, withEnvironment: false });
    this.project = { id: project.projectId, slug: project.slug, name };
    await this.action("project.updateManifest", { projectId: this.project.id, manifest: this.manifest(nonce()) });
    await this.action("system.setSecret", { projectId: this.project.id, serviceId: "witness", key: "DRV_KUBE", secretRef: "vault:DRV_KUBE", secretValue: target.text });
    await this.action("project.updateManifest", { projectId: this.project.id, manifest: this.manifest(nonce()) });
    const connection = await this.action("connection.createKubernetes", { label: name, server: this.config.kind.server,
      caData: target.caData, namespaces: [this.config.kind.namespace], credentialRef: "vault:DRV_KUBE", scopedGuest: false });
    this.project.connectionId = connection.connectionId;
    ok(await this.request("/api/platform/v1/connections/" + connection.connectionId + "/verify", {}));
    const environment = await this.action("env.create", { projectId: this.project.id, name: "production", class: "production",
      connectionId: connection.connectionId, approvalRequired: true });
    this.environmentId = environment.environmentId;
    this.linked = await linkedAgent(this.a, this.stack, this.project, this.workspaceId);
    // An existing deployment is a collision, even if it happens to contain our image.
    const live = await this.kubectl(["get", "deployments", "-o", "json"]);
    ensure(!(JSON.parse(live).items ?? []).some((item: OwnedObject) => item.metadata.name === "witness"), "owned-witness-name-collision");
  }
  manifest(marker: string, healthPath = "/") {
    return { version: 2, placement: { provider: "kubernetes", regions: ["in-cluster"] },
      providerConfig: { kubernetes: { namespace: "zenith-j2" } },
      services: [{ id: "witness", name: "witness", kind: "web", source: { type: "image", image: this.config!.kind.image },
        size: "small", replicas: 1, port: 8080, healthPath, ownership: "managed", env: [{ key: "WITNESS_NONCE", value: marker }] }],
      resources: [], routes: [], bindings: [] };
  }
  request(endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST", page = this.a!) {
    return browserRequest(page, endpoint, body, method, this.workspaceId);
  }
  action(id: string, input: unknown, page = this.a!) {
    return action(page, id, input, { workspaceId: this.workspaceId, projectId: this.project?.id, environmentId: this.environmentId || undefined });
  }
  detail(id: string) { return this.request("/api/platform/v1/operations/" + id).then(ok); }
  async approve(id: string) {
    const detail = await this.detail(id);
    ensure(detail.operation.status === "awaiting_approval" && detail.decision?.approval?.separationOfDuties === true, "real-human-approval-gate");
    const body = { proposalDigest: detail.operation.proposalDigest, ...(detail.operation.planDigest ? { planDigest: detail.operation.planDigest } : {}),
      ...(detail.planReview?.semantics?.digest ? { semanticsDigest: detail.planReview.semantics.digest } : {}) };
    const self = await this.request("/api/platform/v1/operations/" + id + "/approve", body);
    ensure(self.status === 403 && self.data.error?.code === "separation_of_duties", "self-approval-refusal");
    await this.b!.goto(this.stack!.apiUrl + "/platform/operations/" + id);
    const response = this.b!.waitForResponse(r => r.url().endsWith("/operations/" + id + "/approve") && r.request().method() === "POST");
    await this.b!.getByRole("button", { name: /^Approve / }).click();
    ensure((await response).ok(), "browser-approval");
    const approved = await this.detail(id);
    ensure(approved.approvals.some((a: { approverId: string; decision: string }) => a.approverId === this.users[1] && a.decision === "approve"), "browser-approval-readback");
    return approved;
  }
  async propose(rollbackRevision?: string) {
    const out = await this.action(rollbackRevision ? "deploy.rollback" : "deploy.apply", rollbackRevision
      ? { environmentId: this.environmentId, toRevisionId: rollbackRevision }
      : { projectId: this.project!.id, environmentId: this.environmentId, message: "DRV-1 local operated rehearsal" });
    ensure(out.operationId && out.deploymentId && out.revisionId, "real-workflow-proposal");
    this.operations.push(out.operationId); this.deployments.push(out.deploymentId);
    await this.approve(out.operationId);
    await this.action("deploy.approve", { deploymentId: out.deploymentId }, this.b!);
    const reviewed = await until(() => this.detail(out.operationId), (d: Awaited<ReturnType<Operated["detail"]>>) =>
      (d.operation.status === "awaiting_approval" && d.operation.approvalRound > 0) || TERMINAL.includes(d.operation.status));
    ensure(reviewed.operation.status === "awaiting_approval" && /^[a-f0-9]{64}$/.test(reviewed.operation.planDigest)
      && /^[a-f0-9]{64}$/.test(reviewed.planReview?.semantics?.digest ?? ""), "immutable-plan-review");
    return out;
  }
  async settle(id: string) {
    return until(() => this.detail(id), (d: Awaited<ReturnType<Operated["detail"]>>) => TERMINAL.includes(d.operation.status), 780_000);
  }
  async eventReadback(id: string) {
    const events = await mcp(this.stack, this.linked!.token, "tools/call", { name: "zenith_get_operation_events",
      arguments: { workspaceId: this.workspaceId, operationId: id } });
    ensure(events.data.count > 0 && Array.isArray(events.data.events) && events.data.events.length > 0, "actual-mcp-operation-events");
  }
  async deploy(marker: string, healthPath = "/") {
    await this.action("project.updateManifest", { projectId: this.project!.id, manifest: this.manifest(marker, healthPath) });
    const proposal = await this.propose(); await this.approve(proposal.operationId);
    return { ...proposal, terminal: await this.settle(proposal.operationId) };
  }
  kubectl(args: string[]) {
    return command("kubectl", ["--kubeconfig", this.config!.kind.observerKubeconfigFile, "--context", this.config!.kind.context,
      "-n", this.config!.kind.namespace, ...args]);
  }
  async sql<T extends Record<string, unknown>>(query: string, values: unknown[]): Promise<T[]> {
    // Read-only independent native PG connection, derived exclusively from J1. Never writes authority.
    const environment = hostEnvironment(this.stack!.state) as Record<string, string>;
    const url = new URL(environment.ZENITH_PLATFORM_DB_URL);
    ensure(url.hostname === "localhost" && url.port === "6543", "j1-observer-database");
    const observer = postgres(url.href, { max: 1, connect_timeout: 10, prepare: false,
      ssl: { ca: readFileSync(path.join(this.stack!.state.directory, "tls/ca.crt")), rejectUnauthorized: true } });
    try { return [...await observer.unsafe<T[]>(query, values as postgres.ParameterOrJSON<never>[])]; } finally { await observer.end({ timeout: 5 }); }
  }
  async cleanup() {
    const failure = await cleanupAll([
      ...this.recoveries,
      { id: "settle-operations", run: async () => {
        const failures = await cleanupAll(this.operations.map(id => ({ id, run: async () => {
          const detail = await this.detail(id);
          if (!TERMINAL.includes(detail.operation.status)) { ok(await this.request("/api/platform/v1/operations/" + id + "/cancel", { reason: "Owned DRV-1 cleanup" })); await this.settle(id); }
          await until(() => this.sql("select scope from platform.leases where workspace_id=$1 and scope=$2 and released_at is null and expires_at>clock_timestamp()", [this.workspaceId, "env:" + this.environmentId]),
            (leases: Record<string, unknown>[]) => leases.length === 0, 30_000);
        } })));
        ensure(failures.length === 0, "writers-unsettled");
      } },
      { id: "owned-kind-effects", run: async () => {
        if (!this.environmentId) return;
        const kinds = "deployments,statefulsets,cronjobs,jobs,services,ingresses,configmaps,secrets,persistentvolumeclaims,networkpolicies";
        const inventory = async () => JSON.parse(await this.kubectl(["get", kinds, "-o", "json"])).items as OwnedObject[];
        // Never delete beneath a writer, even when cancellation failed. The later credential/engine cleanup still runs.
        const active = await this.sql("select id from platform.operations where workspace_id=$1 and environment_id=$2 and status in ('running','queued','uncertain')", [this.workspaceId, this.environmentId]);
        ensure(active.length === 0, "no-unsettled-cleanup-writer");
        for (const item of cleanupObjects(await inventory(), this.environmentId, this.config!.kind.namespace)) {
          const live = JSON.parse(await this.kubectl(["get", item.kind, item.metadata.name, "-o", "json"])) as OwnedObject;
          ensure(live.metadata.uid === item.metadata.uid && cleanupObjects([live], this.environmentId, this.config!.kind.namespace).length === 1, "cleanup-owner-recheck");
          // API delete preconditions bind the exact observed UID, even across replacement races.
          const api = item.apiVersion === "v1" ? "/api/v1" : "/apis/" + item.apiVersion;
          const resource = ({ Deployment: "deployments", StatefulSet: "statefulsets", CronJob: "cronjobs", Job: "jobs", Service: "services", Ingress: "ingresses", ConfigMap: "configmaps", Secret: "secrets", PersistentVolumeClaim: "persistentvolumeclaims", NetworkPolicy: "networkpolicies" } as Record<string, string>)[item.kind];
          const file = path.join(this.scratch, "delete.json");
          writeFileSync(file, JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground", preconditions: { uid: item.metadata.uid } }), { mode: 0o600 });
          await this.kubectl(["delete", "--raw", api + "/namespaces/" + this.config!.kind.namespace + "/" + resource + "/" + item.metadata.name, "-f", file]);
        }
        await until(inventory, (items: OwnedObject[]) => cleanupObjects(items, this.environmentId, this.config!.kind.namespace).length === 0);
      } },
      { id: "revoke-agent", run: async () => { if (this.linked) ok(await this.request("/api/integrations/agent/link/revoke", { credentialId: this.linked.credentialId })); } },
      { id: "revoke-connection", run: async () => { if (this.project?.connectionId) ok(await this.request("/api/platform/v1/connections/" + this.project.connectionId + "/revoke", { reason: "Owned DRV-1 cleanup" }, "POST", this.b)); } },
      ...this.users.map(id => ({ id: "remove-user", run: async () => {
        ok(await jsonRequest(this.stack!.supabaseUrl + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: adminHeaders(this.stack) }));
        const response = await jsonRequest(this.stack!.supabaseUrl + "/auth/v1/admin/users/" + id, { headers: adminHeaders(this.stack) });
        ensure(response.status === 404, "auth-user-absence");
      } })),
      { id: "close-browser", run: async () => { await this.browser?.close(); } },
      ...[...this.cleaners].reverse(),
    ]);
    ensure(failure.length === 0, "owned-cleanup-incomplete");
  }
}

export async function runOperated(id: ScenarioId, receiptFile: string, env: NodeJS.ProcessEnv, work: (ctx: Operated, step: Step) => Promise<void>, limits: string[]): Promise<number> {
  if (!enabled(env)) return 2; // no config/credentials/subprocess/browser access before gates
  const { runId, root } = localPaths(env);
  privateLocation(root); privateLocation(receiptFile);
  if (process.platform !== "darwin" || process.arch !== "arm64" || !process.versions.node.startsWith("22.")) throw new Error("Needs native Mac arm64 Node 22");
  if (existsSync(receiptFile) || !path.isAbsolute(receiptFile)) throw new Error("Fresh absolute receipt path required");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  ensure(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink() && (lstatSync(root).mode & 0o077) === 0
    && lstatSync(root).uid === process.getuid?.(), "owned-private-root");
  const scratch = path.join(root, id); mkdirSync(scratch, { mode: 0o700 }); chmodSync(scratch, 0o700);
  const ctx = new Operated(id, env, scratch), facts: LocalReceipt["checks"] = [];
  const source = sourceBinding(); let failed = false, code = 1;
  const step: Step = async (check, fn) => {
    try { await fn(); facts.push({ id: check, status: "passed" }); }
    catch { facts.push({ id: check, status: "failed" }); throw new Error("Operated check failed"); }
  };
  try {
    await step("preconditions", async () => {
      ensure(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "j1-stack");
      const state = readState(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR);
      ensure(state.profile === "lean" && JSON.stringify(state.source) === JSON.stringify(source), "exact-j1-source");
      await ctx.start(source);
    });
    await work(ctx, step);
  } catch { failed = true; }
  finally {
    try { await step("owned-cleanup", () => ctx.cleanup()); } catch { failed = true; }
    try { await step("source-unchanged", async () => { ensure(JSON.stringify(sourceBinding()) === JSON.stringify(source), "source-changed"); }); } catch { failed = true; }
    const receipt = receiptFor(id, source, runId, facts, ["Owned local operated rehearsal only; no live cloud or production acceptance.", ...limits]);
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    code = failed || receipt.checks.some(c => c.status === "failed") ? 1 : receipt.checks.some(c => c.status === "skipped") ? 3 : 0;
  }
  return code;
}
export type Step = (check: string, fn: () => Promise<void>) => Promise<void>;
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export async function driverCli(run: (receipt: string, env?: NodeJS.ProcessEnv) => Promise<number>, args: string[]) {
  const index = args.indexOf("--receipt");
  if (index < 0 || !args[index + 1]) return 2;
  try { return await run(path.resolve(args[index + 1]!)); }
  catch { process.stderr.write("DRV-1 refused; inspect the sanitized receipt and owned local prerequisites.\n"); return 1; }
}
