/**
 * Demo A — autonomous AWS deploy: repository -> analysis -> proposal -> plan ->
 * approval -> deploy -> DNS and TLS -> health, in a dedicated sandbox account.
 *
 * "Autonomous" here means the agent side drives it end to end through the
 * control plane's capability broker; it does NOT mean unattended. If policy
 * requires an approval, a person approves it in the browser (no token can), and
 * the harness waits. Where policy lets the deploy run unattended the approval
 * criterion is recorded as SKIPPED, never as passed.
 *
 * What the harness itself does with cloud credentials is limited to
 * VERIFICATION (tag listings, DNS records, log reads) and adopting what Zenith
 * created into the run's tag; Zenith creates everything through its own broker
 * and worker.
 *
 * Status: executable, never run. Needs the capability broker REST API, the
 * execution worker's real activities and the AWS drivers, which were not merged
 * when this was written, and a sandbox account (`blockedOn`).
 */
import { ListHostedZonesByNameCommand, ListResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { newRunState, readRunState, recordEnvironment, writeRunState } from "../run-state";
import { awsOf, type PassCriterion, type ScenarioContext, type ScenarioDefinition } from "../types";
import { adoptNow, awaitApproval, awaitTerminal, checker, configPrerequisite, controlPlaneReachable, cp, liveControlPlaneConfig, awsTargetConfig, toolPrerequisite } from "./_shared";
import { countEnvironmentResources, recentEnvironmentLogs, runResourcesOfType } from "./_aws";
import { buildLiveManifest } from "./_manifest";
import { listTagged, regionsFor } from "../cleanup";

const CRITERIA: readonly PassCriterion[] = [
  { id: "analysis", text: "The sample app is analysed into a manifest with a web service, a health path and a Postgres resource, and the local cost estimate is within the budget." },
  { id: "plan", text: "A plan operation succeeds and reports a 64-hex plan digest and a cost the budget accepts." },
  { id: "gate-held", text: "While the deploy waited for approval, no resource of the environment existed in the account." },
  { id: "approval", text: "If policy required approval, a human other than the proposer approved the exact proposal before execution started; if policy allowed unattended execution this is skipped, not passed." },
  { id: "deployed", text: "The deploy operation reaches succeeded." },
  { id: "tagged", text: "Every resource carrying the environment's tag also carries this run's zenith:live-run tag after adoption (nothing the deploy created is outside the deletion boundary)." },
  { id: "health", text: "GET /health on the public URL returns 200 with status ok." },
  { id: "dns-tls", text: "The route host resolves in DNS and serves a valid TLS certificate for it that is not about to expire." },
  { id: "database", text: "GET /db on the public URL reports the database reachable (a real TCP connection from the task to the database)." },
  { id: "logs", text: "The application's own log lines (its listening event) are readable from CloudWatch Logs for the environment." },
];

const C = checker("A", CRITERIA);
const S = "A";

const HEX64 = /^[0-9a-f]{64}$/;

function findUrl(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return /^https:\/\/[A-Za-z0-9.-]+(?:\/\S*)?$/.test(value) ? value : undefined;
  if (typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) {
    const f = findUrl(v, depth + 1);
    if (f) return f;
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export const demoA: ScenarioDefinition = {
  id: "A",
  title: "Autonomous AWS deploy",
  summary: "Analyse the sample app, propose, plan, get approval, deploy to a sandbox AWS account and verify health, DNS, TLS, the database path and logs.",
  needs: { cloud: "aws", controlPlane: true, temporal: true },
  mutates: true,
  createsResources: true,
  dependsOn: [],
  prerequisites: [
    awsTargetConfig,
    liveControlPlaneConfig,
    configPrerequisite("workspace-id", "ZENITH_LIVE_WORKSPACE_ID is set (the workspace the token belongs to)", (c) => !!c.workspaceId, "set ZENITH_LIVE_WORKSPACE_ID"),
    toolPrerequisite("tofu", "tofu"),
    controlPlaneReachable,
  ],
  steps: [
    {
      id: "analyze",
      title: "Analyse the sample app and estimate its cost",
      effect: "none",
      plan: (p) => ["analyseRepository on fixtures/acceptance-app -> proposeArchitecture -> V1 manifest (route host <runId>.<ZENITH_LIVE_DNS_ZONE>)", `estimate the environment's monthly cost with the merged cost engine and compare it with the ${p.config.maxMonthlyUsd.toFixed(2)} USD/month limit`],
      async run(ctx) {
        const built = buildLiveManifest({ runId: ctx.runId, region: ctx.session?.region ?? ctx.config.region ?? "us-east-1", dnsZone: ctx.config.dnsZone });
        ctx.state.set("a.manifest", built.manifest);
        ctx.state.set("a.host", built.host);
        ctx.session?.checkCost(built.estimateUsd, "The local estimate of the environment");
        C.expect(ctx, "analysis", !!built.summary.port && !!built.summary.healthPath && built.summary.resources >= 1, `${built.summary.services} service(s), port ${built.summary.port}, health ${built.summary.healthPath}; local estimate $${built.estimateUsd.toFixed(2)}/month against the $${ctx.session?.maxMonthlyUsd.toFixed(2) ?? "?"} limit.`, "local");
      },
    },
    {
      id: "setup",
      title: "Create the project and the run's environment in the control plane",
      effect: "mutate",
      plan: (p) => [`project.create { name: "${p.runId}", withEnvironment: false, connectionId: ZENITH_LIVE_CONNECTION_ID }`, "project.updateManifest { the analysed manifest }", `env.create { name: "${p.runId}", class: "sandbox", region }  (the environment id is recorded in run-state.json at once so a later cleanup can adopt and sweep it)`],
      async run(ctx) {
        const connectionId = ctx.config.connectionId!;
        const region = awsOf(ctx).region;
        const project = await cp(ctx).runAction("project.create", { mode: "execute", input: { name: ctx.runId, withEnvironment: false, connectionId } });
        const projectId = str(project.data?.projectId);
        if (!project.ok && !projectId) throw new Error(`project.create failed: ${project.error ?? project.summary ?? "no detail"}`);
        if (!projectId) throw new Error("project.create did not return a project id.");
        const manifest = await cp(ctx).runAction("project.updateManifest", { mode: "execute", scope: { projectId }, input: { projectId, manifest: ctx.state.get("a.manifest") } });
        if (manifest.ok === false) throw new Error(`project.updateManifest failed: ${manifest.error ?? manifest.summary ?? "no detail"}`);
        const env = await cp(ctx).runAction("env.create", { mode: "execute", scope: { projectId }, input: { projectId, name: ctx.runId, class: "sandbox", connectionId, region } });
        const environmentId = str(env.data?.environmentId);
        if (!environmentId) throw new Error(`env.create did not return an environment id: ${env.error ?? env.summary ?? "no detail"}`);
        ctx.state.set("a.projectId", projectId);
        ctx.state.set("a.environmentId", environmentId);
        ctx.state.set("a.environmentIds", [environmentId]);
        const s = ctx.session!;
        let state = (await readRunState(ctx.runStateFile, { runId: ctx.runId, accountId: s.accountId, region: s.region })) ?? newRunState({ runId: ctx.runId, accountId: s.accountId, region: s.region, now: ctx.now() });
        state = { ...state, workspaceId: ctx.config.workspaceId, ...(ctx.config.stateBucket ? { stateBucket: ctx.config.stateBucket } : {}) };
        await writeRunState(ctx.runStateFile, state);
        await recordEnvironment(ctx.runStateFile, state, environmentId);
        return { detail: `project ${projectId}, environment ${environmentId}` };
      },
    },
    {
      id: "plan",
      title: "Plan the environment (infrastructure.plan)",
      effect: "mutate",
      plan: () => ["POST /api/platform/v1/capabilities/propose { capability: infrastructure.plan, scope: environment }", "wait for the operation to finish; read its plan digest and cost", "check the plan's cost against the budget before anything is applied"],
      async run(ctx) {
        const scope = { workspaceId: ctx.config.workspaceId!, projectId: ctx.state.get("a.projectId") as string, environmentId: ctx.state.get("a.environmentId") as string };
        const proposed = await cp(ctx).proposeCapability({ capability: "infrastructure.plan", scope, reason: `live acceptance ${ctx.runId}: plan the sample app`, idempotencyKey: `${ctx.runId}-plan` });
        if (proposed.decision.outcome === "deny") throw new Error(`Planning was denied: ${proposed.decision.reasons.map((r) => r.code).join(", ")}`);
        const op = await awaitTerminal(ctx, S, proposed.operation.id, 20 * 60_000);
        const planDigest = op.planDigest ?? op.proposal?.planDigest;
        const cost = op.proposal?.costDeltaUsd;
        if (planDigest) ctx.evidence.planDigest(S, "approved-candidate plan", planDigest);
        ctx.state.set("a.planDigest", planDigest);
        const okPlan = op.status === "succeeded" && typeof planDigest === "string" && HEX64.test(planDigest);
        if (okPlan) ctx.session?.checkCost(cost, "The plan");
        C.expect(ctx, "plan", okPlan && cost !== undefined, `plan operation ${op.status}; digest ${planDigest?.slice(0, 12) ?? "none"}; cost delta ${cost === undefined ? "none reported" : `$${cost.toFixed(2)}/month`}.`);
        if (!okPlan || cost === undefined) throw new Error("The plan did not produce a digest and a cost; refusing to deploy.");
      },
    },
    {
      id: "propose-deploy",
      title: "Propose the deploy and wait at the approval gate",
      effect: "mutate",
      plan: () => ["propose capability deployment.deploy for the environment", "if policy requires approval: print the proposal digest, confirm NO environment resource exists yet, and wait for a person to approve in the browser (the harness cannot and will not approve)", "if policy allows unattended execution: record that, and skip the approval criterion"],
      async run(ctx) {
        const environmentId = ctx.state.get("a.environmentId") as string;
        const scope = { workspaceId: ctx.config.workspaceId!, projectId: ctx.state.get("a.projectId") as string, environmentId };
        const proposed = await cp(ctx).proposeCapability({ capability: "deployment.deploy", scope, input: { planDigest: ctx.state.get("a.planDigest") }, reason: `live acceptance ${ctx.runId}: deploy the sample app`, idempotencyKey: `${ctx.runId}-deploy` });
        ctx.state.set("a.deployOp", proposed.operation.id);
        ctx.evidence.operation(S, { operationId: proposed.operation.id, capability: "deployment.deploy", status: proposed.operation.status, detail: `decision ${proposed.decision.outcome}` });
        if (proposed.decision.outcome === "require_approval") {
          const before = await countEnvironmentResources(ctx, environmentId);
          C.expect(ctx, "gate-held", before === 0, `${before} resource(s) carried the environment tag while the deploy awaited approval.`);
        } else {
          C.skip(ctx, "gate-held", `policy decided "${proposed.decision.outcome}", so there was no approval gate to hold`);
        }
        const outcome = await awaitApproval(ctx, proposed);
        if (outcome.mode === "human") C.expect(ctx, "approval", outcome.approverIsHuman, `a person approved after ${Math.round(outcome.waitedMs / 1000)} s; approver differs from the proposer: ${outcome.approverIsHuman}.`);
        else C.skip(ctx, "approval", `policy allowed the deploy unattended (autonomy ${proposed.decision.environment?.autonomyLevel ?? "unknown"}); the approval path was not exercised`);
      },
    },
    {
      id: "deploy",
      title: "Wait for the deploy; adopt what it creates into the run",
      effect: "read",
      plan: (p) => [`poll the operation until terminal (up to the deploy timeout), adopting resources tagged zenith:environment=<env> into ${p.runId} every 30 s`, "a final adoption pass, then require every environment-tagged resource to carry the run tag"],
      async run(ctx) {
        const opId = ctx.state.get("a.deployOp") as string;
        let last = 0;
        const op = await awaitTerminal(ctx, S, opId, ctx.config.deployTimeoutMs, async () => {
          if (ctx.now().getTime() - last >= 30_000) {
            last = ctx.now().getTime();
            await adoptNow(ctx, S);
          }
        });
        await adoptNow(ctx, S);
        C.expect(ctx, "deployed", op.status === "succeeded", `deploy operation ended ${op.status}${op.error ? `: ${op.error}` : ""}.`);
        const envId = ctx.state.get("a.environmentId") as string;
        const envCount = await countEnvironmentResources(ctx, envId);
        const services = (await runResourcesOfType(ctx, "ecs:service")).length;
        // Count the intersection, not unrelated resources of the same run.
        const resources = await listTagged(awsOf(ctx), regionsFor(awsOf(ctx).region), ctx.runId);
        const tagged = resources.filter((r) => r.tags["zenith:environment"] === envId).length;
        C.expect(ctx, "tagged", envCount > 0 && tagged === envCount, `${tagged} environment resources carry the run tag against ${envCount} environment-tagged (${services} ECS services); the tagging index can lag.`);
        if (op.status !== "succeeded") throw new Error(`The deploy ended ${op.status}.`);
      },
    },
    {
      id: "verify-app",
      title: "Probe /health, DNS, TLS and /db on the public URL",
      effect: "read",
      plan: () => ["GET https://<host>/health until 200 (retrying for up to 10 minutes)", "resolve the host in DNS and read its TLS certificate (chain, host name, days remaining)", "GET https://<host>/db and expect {\"db\":\"reachable\"}", "record the Route53 records the deploy created in run-state.json so a cleanup can remove them"],
      async run(ctx) {
        const opResult = (await cp(ctx).getOperation(ctx.state.get("a.deployOp") as string)).operation.result;
        const host = ctx.state.get("a.host") as string | undefined;
        const url = findUrl(opResult) ?? (host ? `https://${host}` : undefined);
        if (!url) {
          for (const id of ["health", "dns-tls", "database"]) C.skip(ctx, id, "no public URL: the deploy result named none and ZENITH_LIVE_DNS_ZONE is not set");
          return { detail: "no public URL to probe" };
        }
        ctx.state.set("a.url", url);
        const base = new URL(url);
        const health = await ctx.probe.waitFor(new URL("/health", base).href, { accept: (r) => r.status === 200, timeoutMs: 10 * 60_000, intervalMs: 10_000 });
        ctx.evidence.httpProbe(S, { label: "health", url: health.last.url, status: health.last.status, ok: health.last.status === 200, latencyMs: health.last.latencyMs, error: health.last.error, bodySnippet: health.last.bodySnippet });
        C.expect(ctx, "health", health.accepted && /"status"\s*:\s*"ok"/.test(health.last.bodySnippet ?? ""), `status ${health.last.status ?? health.last.error} after ${health.attempts} attempt(s).`);

        if (host) {
          const addresses = await ctx.probe.resolveDns(host);
          ctx.evidence.httpProbe(S, { label: "dns", url: `dns://${host}`, ok: addresses.length > 0, dns: { addresses } });
          let tlsOk = false;
          let tlsDetail = "no TLS handshake was made";
          try {
            const tls = await ctx.probe.tlsInfo(host);
            ctx.evidence.httpProbe(S, { label: "tls", url: `tls://${host}:443`, ok: tls.authorized, tls: { validTo: tls.validTo, subject: tls.subject, issuer: tls.issuer, daysRemaining: tls.daysRemaining } });
            tlsOk = tls.authorized && (tls.daysRemaining ?? 0) > 7 && (tls.altNames ?? []).some((n) => n === host || (n.startsWith("*.") && host.endsWith(n.slice(1))));
            tlsDetail = `authorized ${tls.authorized}${tls.authorizationError ? ` (${tls.authorizationError})` : ""}, ${tls.daysRemaining ?? "?"} days remaining, names [${(tls.altNames ?? []).join(", ")}].`;
          } catch (err) {
            tlsDetail = `TLS handshake failed (${err instanceof Error ? err.message : "error"})`;
          }
          C.expect(ctx, "dns-tls", addresses.length > 0 && tlsOk, `${addresses.length} DNS address(es); ${tlsDetail}`);
          await recordDnsRecords(ctx, host);
        } else {
          C.skip(ctx, "dns-tls", "ZENITH_LIVE_DNS_ZONE is not set, so the deploy used no route host of ours to verify");
        }

        const db = await ctx.probe.get(new URL("/db", base).href, { timeoutMs: 15_000, expect: () => true });
        ctx.evidence.httpProbe(S, { label: "db", url: db.url, status: db.status, ok: db.status === 200, latencyMs: db.latencyMs, error: db.error, bodySnippet: db.bodySnippet });
        C.expect(ctx, "database", db.status === 200 && /"db"\s*:\s*"reachable"/.test(db.bodySnippet ?? ""), `status ${db.status ?? db.error}: ${db.bodySnippet ?? ""}`);
      },
    },
    {
      id: "logs",
      title: "Read the application's logs from CloudWatch",
      effect: "read",
      plan: () => ["list log groups under /zenith/<environmentId>/", "FilterLogEvents for the last 30 minutes; record the lines (redacted) as evidence"],
      async run(ctx) {
        const { groups, lines } = await recentEnvironmentLogs(ctx, ctx.state.get("a.environmentId") as string, { sinceMs: 30 * 60_000, filter: "listening" });
        ctx.evidence.logQuery(S, { source: "aws.cloudwatch-logs", query: `groups ${groups.join(",")} filter "listening"`, lines });
        C.expect(ctx, "logs", lines.some((l) => /"event"\s*:\s*"listening"/.test(l)), `${groups.length} log group(s), ${lines.length} matching line(s).`);
      },
    },
  ],
  passCriteria: CRITERIA,
  proves: [
    "Zenith, driven only through its capability API, can take a repository to a running, health-checked application in a real AWS account, with the plan, cost and approval gates in the path.",
    "Everything the deploy created sits inside the run's tag boundary, so the run can be torn down by tag.",
    "DNS, TLS, the app-to-database network path and the application's logs are real and observable from outside Zenith.",
  ],
  cannotProve: [
    "That Zenith's credential broker is safe against a hostile control plane: the harness drives it with an integration token, it does not attack it.",
    "That the approval was meaningful: the harness checks who approved and when, not that the person read the plan.",
    "Behaviour at scale, under load, in another region or account, or with a different application.",
    "That no resource was created outside the tag boundary: untagged resources are invisible to a tag listing (the account-wide cost and the cleanup report are the cross-check).",
    "Anything about the cloud's own reliability: one run is one observation.",
  ],
  blockedOn: [
    "No sandbox AWS account or credentials exist on the development machine (the first run needs the deploy/aws stack, the /zenith/live-sandbox marker and a Route53 zone).",
    "The capability broker REST API (/api/platform/v1) and the execution activities (compile, plan, apply, deploy, verify) were in unmerged workstreams (WS-CAP, WS-ACT) when this was written; the merged worker's activities are stubs.",
    "The AWS drivers (network, compute, data) are in unmerged workstreams.",
    "The app's DATABASE_URL must be supplied by Zenith's own secret and binding flow; the harness never writes secret values.",
  ],
  runsLocally: false,
  costNote: "about $0.15-0.30 for a one-hour run (NAT gateway, load balancer, a nano database and a small Fargate task at list prices; the local estimate is checked against ZENITH_LIVE_MAX_MONTHLY_USD)",
};

/** Record the route host's DNS records in run-state.json so a native cleanup can delete them (records cannot be tagged). */
async function recordDnsRecords(ctx: ScenarioContext, host: string): Promise<void> {
  const zone = ctx.config.dnsZone;
  if (!zone) return;
  try {
    const r53 = awsOf(ctx).client(Route53Client, { region: "us-east-1" });
    const zones = await r53.send(new ListHostedZonesByNameCommand({ DNSName: zone, MaxItems: 1 }));
    const z = zones.HostedZones?.find((h) => h.Name === `${zone}.`);
    const zoneId = z?.Id?.replace("/hostedzone/", "");
    if (!zoneId) return;
    const sets = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: `${host}.`, MaxItems: 10 }));
    const records = (sets.ResourceRecordSets ?? []).filter((s) => s.Name?.toLowerCase() === `${host}.`.toLowerCase() && (s.Type === "A" || s.Type === "AAAA" || s.Type === "CNAME")).map((s) => ({ zoneId, name: host, type: s.Type as "A" | "AAAA" | "CNAME" }));
    if (records.length === 0) return;
    const s = ctx.session!;
    const state = (await readRunState(ctx.runStateFile, { runId: ctx.runId, accountId: s.accountId, region: s.region })) ?? newRunState({ runId: ctx.runId, accountId: s.accountId, region: s.region });
    await writeRunState(ctx.runStateFile, { ...state, dnsRecords: records });
  } catch (err) {
    ctx.evidence.note(`Could not record DNS records for cleanup (${err instanceof Error ? err.name : "error"}); the tofu destroy path still removes them.`, S);
  }
}
