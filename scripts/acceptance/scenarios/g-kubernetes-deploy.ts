/** Demo G: deploy through Zenith, verify with independent kubectl. The driver
 * must create the run-labelled namespace; an unlabelled namespace is refused.
 * A kube-system sandbox marker is required before any mutation. Not run live. */
import { createKubectl, deleteRunNamespace, verifyRunNamespace, type Kubectl } from "../clients/kubernetes";
import { assertWithinBudget } from "../safety";
import type { PassCriterion, ScenarioDefinition } from "../types";
import { checker, configPrerequisite, cp, awaitApproval, awaitTerminal } from "./_shared";
import { buildLiveManifest } from "./_manifest";

const CRITERIA: readonly PassCriterion[] = [
  { id: "sandbox", text: "The explicit Kubernetes context is opted into live sandbox testing and the run namespace did not exist." },
  { id: "plan", text: "The plan succeeds with a digest and a known monthly estimate within budget." },
  { id: "deployed", text: "The deployment succeeds and its namespace carries this run's label." },
  { id: "rollout", text: "Independent kubectl rollout status confirms available deployments." },
  { id: "health", text: "A port-forwarded HTTP /health probe returns 200 and status ok." },
];
const C = checker("G", CRITERIA);
const kube = (state: Map<string, unknown>): Kubectl => state.get("g.kube") as Kubectl;
export const demoG: ScenarioDefinition = {
  id: "G", title: "Kubernetes deploy", summary: "Deploy the fixture through Zenith to an explicitly opted-in cluster, then check rollout and health independently.",
  needs: { cloud: "kubernetes", controlPlane: true, temporal: true }, mutates: true, createsResources: true, dependsOn: [],
  prerequisites: [configPrerequisite("kube-config", "Sandbox context, verified Kubernetes connection, API and workspace are configured", (c) => !!c.kubeContext && !!c.kubeConnectionId && !!c.apiUrl && !!c.apiToken && !!c.workspaceId, "set ZENITH_LIVE_KUBE_CONTEXT, KUBE_CONNECTION_ID, API_URL, API_TOKEN and WORKSPACE_ID")],
  steps: [
    { id: "preflight", title: "Check nodes, sandbox marker and absence of the namespace", effect: "read",
      plan: (p) => [`kubectl --context ${p.config.kubeContext ?? "<context>"} get nodes`, "require kube-system label zenith.io/live-sandbox=true", `require namespace ${p.runId} absent (no namespace is deleted to make room)`],
      async run(ctx) {
        const k = createKubectl(ctx.config.kubeContext!); ctx.state.set("g.kube", k);
        const nodes = JSON.parse(await k.run(["get", "nodes", "-o", "json"])) as { items?: unknown[] };
        const system = JSON.parse(await k.run(["get", "namespace", "kube-system", "-o", "json"])) as { metadata?: { labels?: Record<string, string> } };
        const absent = !(await k.run(["get", "namespace", ctx.runId, "--ignore-not-found", "-o", "json"])).trim();
        const safe = !!nodes.items?.length && system.metadata?.labels?.["zenith.io/live-sandbox"] === "true" && absent;
        C.expect(ctx, "sandbox", safe, `nodes ${nodes.items?.length ?? 0}; marker ${system.metadata?.labels?.["zenith.io/live-sandbox"] === "true"}; namespace absent ${absent}.`);
        if (!safe) throw new Error("Cluster sandbox preflight refused.");
      } },
    { id: "setup-plan", title: "Create project/environment and plan through the control plane", effect: "mutate",
      plan: (p) => ["analyse fixture; project.create + project.updateManifest", `env.create provider=kubernetes, namespace=${p.runId}, labels zenith.io/live-run=${p.runId}`, "propose infrastructure.plan; wait for approval if needed and check digest and monthly cost"],
      async run(ctx) {
        const manifest = buildLiveManifest({ runId: ctx.runId, region: "us-east-1" }).manifest;
        const created = await cp(ctx).runAction("project.create", { mode: "execute", input: { name: ctx.runId, withEnvironment: false, connectionId: ctx.config.kubeConnectionId } });
        const projectId = created.data?.projectId;
        if (created.ok !== true || typeof projectId !== "string") throw new Error("Kubernetes project creation failed.");
        const update = await cp(ctx).runAction("project.updateManifest", { mode: "execute", scope: { projectId }, input: { projectId, manifest } });
        if (update.ok !== true) throw new Error("Manifest update failed.");
        const env = await cp(ctx).runAction("env.create", { mode: "execute", scope: { projectId }, input: { projectId, name: ctx.runId, class: "sandbox", provider: "kubernetes", connectionId: ctx.config.kubeConnectionId, namespace: ctx.runId, labels: { "zenith.io/live-run": ctx.runId } } });
        const environmentId = env.data?.environmentId;
        if (env.ok !== true || typeof environmentId !== "string") throw new Error("Kubernetes environment creation failed.");
        const scope = { workspaceId: ctx.config.workspaceId!, projectId, environmentId }; ctx.state.set("g.scope", scope);
        const p = await cp(ctx).proposeCapability({ capability: "infrastructure.plan", scope, idempotencyKey: `${ctx.runId}-g-plan` });
        await awaitApproval(ctx, p);
        const op = await awaitTerminal(ctx, "G", p.operation.id, ctx.config.deployTimeoutMs);
        assertWithinBudget(op.proposal?.costDeltaUsd, ctx.config.maxMonthlyUsd, "Kubernetes plan");
        const digest = op.planDigest ?? op.proposal?.planDigest;
        const ok = op.status === "succeeded" && /^[a-f0-9]{64}$/.test(digest ?? "");
        C.expect(ctx, "plan", ok, `plan ${op.status}; cost is a monthly-rate estimate, not an invoice.`);
        if (!ok) throw new Error("No verified Kubernetes plan."); ctx.state.set("g.planDigest", digest);
      } },
    { id: "deploy", title: "Propose, wait for approval and deploy", effect: "mutate",
      plan: () => ["propose deployment.deploy; wait for a human (harness cannot approve)", "require succeeded; independently verify namespace label"],
      async run(ctx) {
        const scope = ctx.state.get("g.scope") as { workspaceId: string; projectId: string; environmentId: string };
        const p = await cp(ctx).proposeCapability({ capability: "deployment.deploy", scope, input: { planDigest: ctx.state.get("g.planDigest") }, idempotencyKey: `${ctx.runId}-g-deploy` });
        await awaitApproval(ctx, p);
        const op = await awaitTerminal(ctx, "G", p.operation.id, ctx.config.deployTimeoutMs);
        await verifyRunNamespace(kube(ctx.state), ctx.runId);
        C.expect(ctx, "deployed", op.status === "succeeded", `deploy ${op.status}; run label verified.`);
        if (op.status !== "succeeded") throw new Error("Kubernetes deploy did not succeed.");
      } },
    { id: "verify", title: "Verify rollout and probe through a local port-forward", effect: "read",
      plan: (p) => [`kubectl -n ${p.runId} rollout status deployment --timeout=300s`, "require exactly one service selecting the fixture, port-forward on a random loopback port, GET /health; close forward in finally"],
      async run(ctx) {
        const k = kube(ctx.state);
        await k.run(["-n", ctx.runId, "rollout", "status", "deployment", "--timeout=300s"], 330_000);
        const deployments = JSON.parse(await k.run(["-n", ctx.runId, "get", "deployments", "-o", "json"])) as { items?: { status?: { availableReplicas?: number }; spec?: { replicas?: number } }[] };
        const rolled = !!deployments.items?.length && deployments.items.every((d) => (d.spec?.replicas ?? 1) > 0 && (d.status?.availableReplicas ?? 0) >= (d.spec?.replicas ?? 1));
        C.expect(ctx, "rollout", rolled, `deployment availability verified: ${rolled}.`);
        if (!rolled) throw new Error("No available fixture deployment.");
        const services = JSON.parse(await k.run(["-n", ctx.runId, "get", "services", "-o", "json"])) as { items?: { metadata?: { name?: string }; spec?: { ports?: { port?: number }[] } }[] };
        const names = (services.items ?? []).filter((s) => s.spec?.ports?.some((p) => p.port === 8080)).map((s) => s.metadata?.name).filter((n): n is string => !!n);
        if (names.length !== 1) throw new Error("Expected exactly one fixture service on port 8080.");
        const f = await k.forward(ctx.runId, names[0]!);
        try {
          const r = await ctx.probe.get(`${f.url}/health`);
          ctx.evidence.httpProbe("G", { label: "port-forward-health", ...r });
          C.expect(ctx, "health", r.status === 200 && /"status"\s*:\s*"ok"/.test(r.bodySnippet ?? ""), `HTTP ${r.status ?? r.error}.`);
        } finally { await f.close(); }
      } },
  ], async cleanup(ctx) { if (ctx.state.has("g.kube") && ctx.evidence.hasCheck("G", "sandbox") && ctx.evidence.checksFor("G").find((c) => c.id === "sandbox")?.status === "passed") await deleteRunNamespace(kube(ctx.state), ctx.runId); },
  passCriteria: CRITERIA, proves: ["A sandbox Kubernetes deploy can be verified independently of Zenith through rollout and HTTP."],
  cannotProve: ["Public DNS/TLS, database authentication, or production cluster security.", "The current unmerged Kubernetes driver must support namespace/run labels and the Node container build contract; these API fields are not live-verified."],
  blockedOn: ["Needs an opted-in sandbox or kind context with kubectl and kube-system label zenith.io/live-sandbox=true.", "Needs merged Kubernetes driver/runner and in-cluster fixture build path; unavailable here."], runsLocally: false, costNote: "kind uses local capacity; sandbox cluster costs are unknown until a real plan returns a monthly estimate.",
};
