/** Demo I defines the managed path, but refuses today's unsupported Node source
 * contract. Catalog estimates are internal assumptions, never published prices. */
import { estimateGraphCost, loadDefaultCatalog } from "@/lib/placement";
import { expandManifest, upgradeManifest } from "@/lib/resources";
import { assertWithinBudget } from "../safety";
import type { PassCriterion, ScenarioDefinition } from "../types";
import { checker, configPrerequisite, cp, awaitApproval, awaitTerminal } from "./_shared";
import { buildLiveManifest } from "./_manifest";

const CRITERIA: readonly PassCriterion[] = [
  { id: "managed-intent", text: "The dedicated environment uses provider zenith and the verified managed connection." },
  { id: "plan-cost", text: "A successful digest-bound plan is within budget; catalog prices are labelled internal_assumption." },
  { id: "deploy", text: "The managed deployment reaches succeeded after its required approval." },
  { id: "health", text: "An independent public /health probe reports status ok." },
];
const C = checker("I", CRITERIA);
export const demoI: ScenarioDefinition = {
  id: "I", title: "Zenith managed provider", summary: "Define the provider=zenith deploy path; refuse the Node fixture until managed drivers and its source contract exist.",
  needs: { cloud: "managed", controlPlane: true, temporal: true }, mutates: true, createsResources: true, dependsOn: [],
  prerequisites: [
    configPrerequisite("managed-config", "Managed API, connection, token and workspace are configured", (c) => !!c.managedApiUrl && !!c.managedConnectionId && !!c.apiToken && !!c.workspaceId, "set MANAGED_API_URL, MANAGED_CONNECTION_ID, API_TOKEN and WORKSPACE_ID"),
    { id: "node-source-contract", kind: "offline", description: "Managed drivers accept this Node HTTP fixture", check: () => ({ ok: false, detail: "Blocked: managed resource drivers are unimplemented; hosted builds accept only React+Vite source, not this Node server. Replace this prerequisite with verified capability discovery when that contract is implemented." }) },
  ],
  steps: [
    { id: "estimate", title: "Price the fixture with the managed catalog", effect: "none", plan: () => ["analyse fixture; expand with provider=zenith, region=us-east", "estimate against zenith entries (internal_assumption) and check monthly budget"],
      async run(ctx) {
        const manifest = buildLiveManifest({ runId: ctx.runId, region: "us-east-1" }).manifest;
        const graph = expandManifest(upgradeManifest(manifest, { provider: "zenith", region: "us-east" }), { id: ctx.runId, name: ctx.runId, class: "sandbox", provider: "zenith", region: "us-east", baseDomain: "example.invalid" });
        const catalog = loadDefaultCatalog();
        const estimate = estimateGraphCost(graph, { catalog, now: "2026-09-30T00:00:00.000Z" });
        assertWithinBudget(estimate.monthlyUsd, ctx.config.maxMonthlyUsd, "Managed internal-assumption estimate");
        ctx.evidence.note(`Managed estimate $${estimate.monthlyUsd.toFixed(2)}/month; zenith prices are internal_assumption, not published rates.`, "I");
        ctx.state.set("i.manifest", manifest);
      } },
    { id: "setup", title: "Create the dedicated managed project/environment", effect: "mutate", plan: (p) => [`project.create + project.updateManifest; env.create name=${p.runId}, provider=zenith, connection=MANAGED_CONNECTION_ID`],
      async run(ctx) {
        const project = await cp(ctx).runAction("project.create", { mode: "execute", input: { name: ctx.runId, withEnvironment: false, connectionId: ctx.config.managedConnectionId } });
        const projectId = project.data?.projectId;
        if (project.ok !== true || typeof projectId !== "string") throw new Error("Managed project creation failed.");
        const update = await cp(ctx).runAction("project.updateManifest", { mode: "execute", scope: { projectId }, input: { projectId, manifest: ctx.state.get("i.manifest") } });
        if (update.ok !== true) throw new Error("Managed manifest update failed.");
        const env = await cp(ctx).runAction("env.create", { mode: "execute", scope: { projectId }, input: { projectId, name: ctx.runId, class: "sandbox", provider: "zenith", connectionId: ctx.config.managedConnectionId, region: "us-east" } });
        const environmentId = env.data?.environmentId;
        const ok = env.ok === true && typeof environmentId === "string";
        C.expect(ctx, "managed-intent", ok, "provider=zenith requested; environment id must be returned.");
        if (!ok) throw new Error("Managed environment creation failed.");
        ctx.state.set("i.scope", { workspaceId: ctx.config.workspaceId!, projectId, environmentId });
      } },
    { id: "plan-deploy", title: "Plan and deploy with approval", effect: "mutate", plan: () => ["propose infrastructure.plan; verify digest and cost", "propose deployment.deploy; wait for human approval; require succeeded"],
      async run(ctx) {
        const scope = ctx.state.get("i.scope") as { workspaceId: string; projectId: string; environmentId: string };
        const p = await cp(ctx).proposeCapability({ capability: "infrastructure.plan", scope, idempotencyKey: `${ctx.runId}-i-plan` });
        await awaitApproval(ctx, p);
        const plan = await awaitTerminal(ctx, "I", p.operation.id, ctx.config.deployTimeoutMs);
        assertWithinBudget(plan.proposal?.costDeltaUsd, ctx.config.maxMonthlyUsd, "Managed plan");
        const planDigest = plan.planDigest ?? plan.proposal?.planDigest;
        const ok = plan.status === "succeeded" && /^[a-f0-9]{64}$/.test(planDigest ?? "");
        C.expect(ctx, "plan-cost", ok, "Budget checked; managed catalog is internal_assumption.");
        if (!ok) throw new Error("No successful managed plan.");
        const d = await cp(ctx).proposeCapability({ capability: "deployment.deploy", scope, input: { planDigest }, idempotencyKey: `${ctx.runId}-i-deploy` });
        await awaitApproval(ctx, d);
        const op = await awaitTerminal(ctx, "I", d.operation.id, ctx.config.deployTimeoutMs);
        C.expect(ctx, "deploy", op.status === "succeeded", `deploy ${op.status}.`);
        const result = op.result as { url?: unknown } | undefined;
        if (op.status !== "succeeded" || typeof result?.url !== "string") throw new Error("Managed deployment returned no verified URL.");
        ctx.state.set("i.url", result.url);
      } },
    { id: "probe", title: "Probe the public health route", effect: "read", plan: () => ["GET <managed result URL>/health independently; expect status ok"],
      async run(ctx) { const r = await ctx.probe.get(new URL("/health", ctx.state.get("i.url") as string).href); ctx.evidence.httpProbe("I", { label: "health", ...r }); C.expect(ctx, "health", r.status === 200 && /"status"\s*:\s*"ok"/.test(r.bodySnippet ?? ""), `HTTP ${r.status ?? r.error}.`); } },
  ], passCriteria: CRITERIA, proves: ["Once its prerequisite is implemented, a managed deploy's intent, plan, approval and health can be observed."],
  cannotProve: ["Deployment today: managed resource drivers are unimplemented and hosted builds only support React+Vite, not this Node fixture.", "Published managed pricing: all managed catalog prices are internal assumptions.", "Managed teardown is not yet specified; this scenario must remain blocked until a run-scoped cleanup contract exists."],
  blockedOn: ["Managed drivers and the Node container source contract are unimplemented.", "Needs a verified managed sandbox connection and run-scoped managed cleanup API."], runsLocally: false, costNote: "Unknown actual managed spend; catalog planning rates are internal assumptions.",
};
