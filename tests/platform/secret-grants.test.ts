/** Real PGlite authorization/signing and graph rendering; observations are contract fixtures. */
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-secret-grants-", { fast: true });
const { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, allowDecision, user, sessionFor } = await import("../capabilities/support");
const { repos } = await import("@/lib/controlplane/db");
const { resetDb } = await import("@/lib/db/store");
const { emptyManifest } = await import("@/lib/domain/types");
const { createProductPort, createOperationsPort } = await import("@/lib/execution");
const { buildDesiredState } = await import("@/lib/execution/graph");
const { createExecutionBroker } = await import("@/lib/platform/broker");
const { registerAllDrivers } = await import("@/lib/platform/drivers");
const { secretNameFor } = await import("@/lib/providers/aws/drivers/data/secretsmanager-secret");
const { namePrefix } = await import("@/lib/execution/session");
const { planEvidence } = await import("@/lib/execution/plan-evidence");
const { buildPlanFacts } = await import("@/lib/capabilities/evaluate");
const { makePlan } = await import("../execution/fakes/fixtures");
const { renderObjects } = await import("@/lib/providers/kubernetes/render");
closeSharedPgliteAfterAll();

async function fixture(provider: "aws" | "kubernetes" = "aws", capability = "deployment.deploy") {
  const h = await makeHarness({ kind: "pglite", engine: scriptedEngine("secret-plan", () => requireApproval(1, "admin", true)) });
  const { wsA: ws, projA: project, envAProd: env } = h.ids;
  const connectionId = `${env}-connection`, revisionId = `${env}-revision`;
  const createdAt = h.clock.now().toISOString();
  const manifest = { ...emptyManifest(), services: [{ id: "web", name: "web", kind: "web" as const, source: { type: "image" as const, image: "example/web:1" },
    size: "small" as const, replicas: 1, port: 3000, ownership: "managed" as const, env: [{ key: "TOKEN", secretRef: `vault:${project}/web/TOKEN` }] }],
    resources: provider === "kubernetes" ? [{ id: "db", name: "db", kind: "postgres" as const, size: "small" as const, ownership: "managed" as const, config: {} }] : [] };
  resetDb({ workspaces: [{ id: ws, name: "Contract", slug: "contract", createdAt }],
    connections: [{ id: connectionId, workspaceId: ws, provider, region: "us-east-1", label: provider, status: "healthy", grantedPermissions: [], createdAt }],
    projects: [{ id: project, workspaceId: ws, name: "Contract", slug: "contract", workingManifest: manifest, origin: { type: "blank" }, createdAt }],
    environments: [{ id: env, projectId: project, name: "production", class: "production", connectionId, region: "us-east-1", baseDomain: "contract.example.com", policies: { approvalRequired: true, allowStatefulDeletion: false }, createdAt }],
    revisions: [{ id: revisionId, projectId: project, number: 1, message: "contract", author: { type: "user", id: "alice", name: "Alice" }, manifest, createdAt }] });
  const config = provider === "aws" ? { provider, mode: "aws_assume_role" as const, accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/observe", deployRoleArn: "arn:aws:iam::123456789012:role/deploy", externalId: "contract-external-id" }
    : { provider, mode: "kubeconfig_ref" as const, server: "https://kubernetes.example.com", namespaces: [], credentialRef: "vault:kubeconfig" };
  await repos.connections.create(h.db!, { id: connectionId, workspaceId: ws, config, createdBy: "contract" });
  await repos.connections.recordVerification(h.db!, { workspaceId: ws, id: connectionId, ok: true, detail: "Contract fixture only." });
  registerAllDrivers();
  const product = await createProductPort().loadContext({ workspaceId: ws, environmentId: env, revisionId });
  const graph = buildDesiredState(product).graph!;
  expect(graph).toBeDefined();
  const targets: string[] = [];
  let resourceId = "";
  if (provider === "aws") {
    for (const node of graph.nodes.filter((n) => n.kind === "secret")) {
      const row = await repos.resources.upsertDesired(h.db!, { workspaceId: ws, projectId: project, environmentId: env, node, revisionId });
      resourceId = row.id;
      const id = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${secretNameFor({ namePrefix: namePrefix(env) }, node.address)}-abcdef`;
      targets.push(id);
      await repos.observations.appendObservation(h.db!, { workspaceId: ws, resourceId: row.id, observation: { address: node.address, externalId: id, presence: "present", attributes: {}, observedAt: createdAt, source: "aws.secretsmanager_secret@1", simulated: false } });
    }
  } else {
    for (const node of graph.nodes.filter((n) => ["secret", "postgres", "redis"].includes(n.kind))) for (const object of renderObjects(node, { environmentId: env, node: (a) => graph.nodes.find((n) => n.address === a), nodes: () => graph.nodes }).filter((o) => o.kind === "Secret")) targets.push(`kubernetes:${object.metadata.namespace}/${object.metadata.name}`);
  }
  const plan = makePlan(), facts = buildPlanFacts(plan)!;
  const proposal = await h.broker.propose({ capability, scope: { workspaceId: ws, projectId: project, environmentId: env }, input: { revisionId } }, user("alice"), capability === "infrastructure.apply" ? { plan } : {});
  const op = proposal.operation;
  const approve = (planDigest?: string) => h.broker.approve({ workspaceId: ws, operationId: op.id, proposalDigest: op.proposalDigest, planDigest, approver: user("erin"), session: sessionFor("erin") });
  await approve();
  await h.broker.beginExecution({ workspaceId: ws, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker", ...(capability === "infrastructure.apply" ? { plan } : {}) });
  await repos.evidence.insert(h.db!, { workspaceId: ws, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest,
    summary: planEvidence({ plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: "plan" }).summary, simulated: false });
  const ports = createOperationsPort(h.db!);
  await ports.setPlanDigest({ workspaceId: ws, operationId: op.id, planDigest: plan.planDigest });
  const fence = await h.acquireLease(env);
  const worker = createExecutionBroker(h.db!, async () => h.broker);
  const issue = () => worker.issueGrant(op.id, "worker", fence, { capability: "secret.write" });
  const approvePlan = async () => {
    await ports.transition({ workspaceId: ws, operationId: op.id, to: "awaiting_approval" });
    await approve(plan.planDigest);
    await ports.transition({ workspaceId: ws, operationId: op.id, to: "running" });
  };
  return { h, op, fence, worker, issue, approvePlan, targets: targets.sort(), resourceId };
}

describe("deployment secret grants", () => {
  it.each(["deployment.deploy", "infrastructure.apply", "deployment.rollback"])("%s signs only the exact reviewed environment's secret identities", async (capability) => {
    const f = await fixture("aws", capability); await f.approvePlan();
    const grant = await f.issue();
    expect(grant.claims).toMatchObject({ cap: "secret.write", ws: f.h.ids.wsA, env: f.h.ids.envAProd, constraints: { secretResources: f.targets } });
    const verified = await jwtVerify(grant.jws, await importJWK(await f.h.publicJwk()), { audience: "worker", issuer: "zenith-control", currentDate: f.h.clock.now() });
    expect(verified.payload.constraints).toEqual(grant.claims.constraints);
  });
  it("renders Kubernetes vault and generated database Secrets into the signed set", async () => {
    const f = await fixture("kubernetes"); await f.approvePlan();
    expect(f.targets.length).toBeGreaterThan(1);
    expect((await f.issue()).claims.constraints?.secretResources).toEqual(f.targets);
  });
  it("refuses proposal-only approval and cannot widen to an unrelated mutating capability", async () => {
    const f = await fixture();
    await expect(f.issue()).rejects.toThrow(/approval/);
    await f.approvePlan();
    await expect(f.worker.issueGrant(f.op.id, "worker", f.fence, { capability: "identity.modify" })).rejects.toThrow("attenuate");
  });
  it("honors parent and secret policy resource constraints and the shorter deployment lifetime", async () => {
    const f = await fixture(); await f.approvePlan();
    for (const constrained of ["deployment.deploy", "secret.write"]) {
      f.h.setEngine(scriptedEngine("restricted", (input) => ({ ...allowDecision(), ...(input.request.capability === constrained ? { constraints: { secretResources: ["foreign-secret"] } } : {}) })));
      await expect(f.issue()).rejects.toThrow("constraints");
    }
    f.h.setEngine(scriptedEngine("duration", (input) => ({ ...allowDecision(), constraints: { grantDurationSec: input.request.capability === "deployment.deploy" ? 60 : 900 } })));
    const grant = await f.issue(); expect(grant.claims.exp - grant.claims.iat).toBe(60);
  });
  it.each(["foreign-secret", "other-environment", "other-account", "simulated", "missing", "stale-graph", "wrong-revision"])("refuses %s identities before signing", async (kind) => {
    const f = await fixture(); await f.approvePlan();
    const ws = f.h.ids.wsA;
    if (kind === "stale-graph") await f.h.db!.query("update platform.evidence set summary = jsonb_set(summary, '{graphDigest}', to_jsonb($3::text)) where workspace_id = $1 and operation_id = $2", [ws, f.op.id, "f".repeat(64)]);
    else if (kind === "wrong-revision") await f.h.db!.query("update platform.resources set revision_id = $3 where workspace_id = $1 and id = $2", [ws, f.resourceId, "foreign-revision"]);
    else {
      const id = kind === "foreign-secret" ? f.targets[0].replace(/:secret:.+$/, ":secret:foreign-secret-abcdef")
        : kind === "other-environment" ? f.targets[0].replace(/:secret:zenith\/zenith-.+$/, ":secret:zenith/zenith-other-environment-token-abcdef")
        : kind === "other-account" ? f.targets[0].replace("123456789012", "999999999999") : f.targets[0];
      await f.h.db!.query("update platform.resource_observations set external_id = $3, simulated = $4, presence = $5 where workspace_id = $1 and resource_id = $2", [ws, f.resourceId, id, kind === "simulated", kind === "missing" ? "missing" : "present"]);
    }
    await expect(f.issue()).rejects.toThrow("reviewed environment");
  });
  it("reevaluates secret policy with reviewed plan facts, the deploy policy, roles, approval expiry and fence", async () => {
    const f = await fixture(); await f.approvePlan();
    f.h.setEngine(scriptedEngine("secret-denied", (input) => input.request.capability === "secret.write" && input.plan ? { outcome: "deny", reasons: [{ code: "secret_denied", message: "Denied." }] } : allowDecision()));
    await expect(f.issue()).rejects.toThrow("denies");
    f.h.setEngine(scriptedEngine("deploy-denied", (input) => input.request.capability === "deployment.deploy" ? { outcome: "deny", reasons: [{ code: "deploy_denied", message: "Denied." }] } : allowDecision()));
    await expect(f.issue()).rejects.toThrow("denies");
    f.h.setEngine(scriptedEngine("approval", () => requireApproval(1, "admin", true)));
    f.h.world.members.set(`${f.h.ids.wsA}|erin`, "viewer"); await expect(f.issue()).rejects.toThrow("approval");
    f.h.world.members.set(`${f.h.ids.wsA}|erin`, "admin");
    await f.h.loseLease(f.fence.scope); await expect(f.issue()).rejects.toThrow(/lease/i);
    const fence = await f.h.acquireLease(f.h.ids.envAProd); await f.h.expireApprovals(f.op.id);
    await expect(f.worker.issueGrant(f.op.id, "worker", fence, { capability: "secret.write" })).rejects.toThrow("approval");
  });
});
