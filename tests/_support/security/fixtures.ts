/**
 * Two tenants, fully populated, with a canary planted in every place a secret
 * could plausibly be stored (WS-SEC).
 *
 * Pure data: this module imports only TYPES from application code (erased at
 * compile time) so it can be imported statically before a test has set
 * `ZENITH_DATA` — see `tests/_support/data-dir.ts` for why that ordering
 * matters. The test seeds the store itself:
 *
 *     const fx = twoTenantFixture();
 *     const { resetDb, appendEvent } = await import("@/lib/db/store");
 *     resetDb(fx.data);
 *     fx.events.forEach(appendEvent);
 *
 * Ids are at least six characters so `deepScanForCanaries` can scan for them
 * (it refuses shorter needles: they match by chance) and so a foreign id that
 * appears anywhere in another tenant's response is detected by a plain scan.
 *
 * Both projects share the slug `atlas` on purpose: `q.project` matches on id OR
 * slug, so a resolver that looks up by slug and only then checks the workspace
 * hands the caller somebody else's row.
 */
import type { CloudConnection, Deployment, DeploymentEvent, Environment, Manifest, Member, Project, Revision, SecurityFinding, Workspace } from "@/lib/domain/types";
import type { Database } from "@/lib/db/types";
import { canarySecret } from "./canaries";

const AT = "2026-09-01T10:00:00.000Z";

export type TenantKey = "alpha" | "bravo";

export interface TenantCanaries {
  /** a literal environment variable value in the working manifest */
  envValue: string;
  /** a password embedded in a connection string a provider echoed into a deployment step error */
  stepErrorPassword: string;
  /** an AWS secret access key a provider wrote into a step's raw detail */
  stepDetailAwsSecret: string;
  /** a bearer-shaped token in a deployment log line */
  logToken: string;
  /** a password in a `connection`-kind deployment output */
  outputPassword: string;
  /** a JWT inside a security finding's detail text */
  findingJwt: string;
  /** every planted value */
  all: string[];
}

export interface TenantFixture {
  key: TenantKey;
  workspaceId: string;
  memberId: string;
  memberName: string;
  connectionId: string;
  projectId: string;
  slug: string;
  prodEnvId: string;
  stagingEnvId: string;
  revisionIds: [string, string];
  deploymentId: string;
  findingId: string;
  serviceId: string;
  canaries: TenantCanaries;
}

export interface TwoTenantFixture {
  data: Partial<Database>;
  /** deployment events to append after `resetDb` (they are not part of `Database`) */
  events: DeploymentEvent[];
  alpha: TenantFixture;
  bravo: TenantFixture;
  /** every canary of a tenant, keyed by workspace id (for `tenantMatrix`'s `canariesByWorkspace`) */
  canariesByWorkspace: Record<string, string[]>;
}

const manifestFor = (t: TenantKey, serviceId: string, canaries: TenantCanaries): Manifest => ({
  version: 1,
  services: [
    {
      id: serviceId,
      name: `api-${t}`,
      kind: "web",
      source: { type: "image", image: "ghcr.io/zenith/hello-web:1" },
      size: "small",
      replicas: 1,
      port: 3000,
      env: [
        { key: "PUBLIC_URL", value: `https://${t}.example.test` },
        { key: "DATABASE_PASSWORD", value: canaries.envValue },
        { key: "STRIPE_KEY", secretRef: `vault:${t}-project/api/STRIPE_KEY` },
      ],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

function tenant(key: TenantKey, workspaceId: string, memberName: string): { t: TenantFixture; rows: Omit<Partial<Database>, "settings"> & { workspaces: Workspace[] }; events: DeploymentEvent[] } {
  const label = `${key}`;
  const canaries: TenantCanaries = {
    envValue: canarySecret(`${label}/env-value`, "password"),
    stepErrorPassword: canarySecret(`${label}/step-error-password`, "password"),
    stepDetailAwsSecret: canarySecret(`${label}/step-detail-aws-secret`, "aws-secret-access-key"),
    logToken: canarySecret(`${label}/log-token`, "zenith-agent-token"),
    outputPassword: canarySecret(`${label}/output-password`, "password"),
    findingJwt: canarySecret(`${label}/finding-jwt`, "jwt"),
    all: [],
  };
  canaries.all = [canaries.envValue, canaries.stepErrorPassword, canaries.stepDetailAwsSecret, canaries.logToken, canaries.outputPassword, canaries.findingJwt];

  const t: TenantFixture = {
    key,
    workspaceId: `ws-${key}-01`,
    memberId: `u-${key}-admin`,
    memberName: memberName,
    connectionId: `conn-${key}-01`,
    projectId: `prj-${key}-01`,
    slug: "atlas",
    prodEnvId: `env-${key}-prod`,
    stagingEnvId: `env-${key}-stg`,
    revisionIds: [`rev-${key}-01`, `rev-${key}-02`],
    deploymentId: `dep-${key}-01`,
    findingId: `fnd-${key}-01`,
    serviceId: `svc-${key}-api`,
    canaries,
  };
  const actor = { type: "user" as const, id: t.memberId, name: memberName };
  const workspace: Workspace = { id: t.workspaceId, name: `${memberName} Labs`, slug: `${key}-labs`, createdAt: AT };
  const member: Member = { id: t.memberId, workspaceId: t.workspaceId, name: memberName, email: `${key}@zenith.test`, role: "admin" };
  const connection: CloudConnection = { id: t.connectionId, workspaceId: t.workspaceId, provider: "sandbox", label: `Sandbox ${key}`, region: "sim-a", status: "healthy", grantedPermissions: [], createdAt: AT };
  const manifest = manifestFor(key, t.serviceId, canaries);
  const project: Project = { id: t.projectId, workspaceId: t.workspaceId, name: `${memberName} Atlas`, slug: t.slug, workingManifest: manifest, origin: { type: "blank" }, createdAt: AT };
  const env = (id: string, name: string, cls: "production" | "staging"): Environment => ({
    id,
    projectId: t.projectId,
    name,
    class: cls,
    connectionId: t.connectionId,
    region: "sim-a",
    policies: { approvalRequired: false, allowStatefulDeletion: false },
    baseDomain: `${key}.zenith.app`,
    createdAt: AT,
    ...(cls === "production" ? { deployedRevisionId: t.revisionIds[1] } : {}),
  });
  const revisions: Revision[] = t.revisionIds.map(
    (id, i) => ({ id, projectId: t.projectId, number: i + 1, manifest, message: `rev ${i + 1}`, author: actor, createdAt: AT }) as Revision
  );
  const deployment = {
    id: t.deploymentId,
    projectId: t.projectId,
    environmentId: t.prodEnvId,
    revisionId: t.revisionIds[1],
    status: "failed",
    steps: [
      {
        id: `step-${key}-1`,
        label: "Create database",
        targetId: t.serviceId,
        status: "failed",
        detail: `provider raw: aws_secret_access_key=${canaries.stepDetailAwsSecret}`,
        error: `connect failed: postgres://app:${canaries.stepErrorPassword}@db.${key}.internal:5432/app`,
      },
    ],
    outputs: [{ key: "DATABASE_URL", label: "Database", value: `postgres://app:${canaries.outputPassword}@db.${key}.internal:5432/app`, kind: "connection", targetId: t.serviceId }],
    changeSummary: `first deploy of ${key}`,
    estCostDeltaUsd: 0,
    actor,
    createdAt: AT,
    endedAt: AT,
  } as unknown as Deployment;
  const finding: SecurityFinding = {
    id: t.findingId,
    projectId: t.projectId,
    environmentId: t.prodEnvId,
    severity: "high",
    title: `Exposed credential in ${key}`,
    detail: `A session token ${canaries.findingJwt} was found in a build log.`,
    status: "open",
    createdAt: AT,
  };
  const events: DeploymentEvent[] = [
    { ts: AT, deploymentId: t.deploymentId, seq: 0, type: "status", status: "applying" },
    { ts: AT, deploymentId: t.deploymentId, seq: 1, type: "log", stepId: `step-${key}-1`, line: `Authorization: Bearer ${canaries.logToken}`, stream: "provider" },
    { ts: AT, deploymentId: t.deploymentId, seq: 2, type: "step", stepId: `step-${key}-1`, status: "failed", error: `connect failed for ${key}` },
  ];
  return {
    t,
    rows: {
      workspaces: [workspace],
      members: [member],
      connections: [connection],
      projects: [project],
      environments: [env(t.prodEnvId, "production", "production"), env(t.stagingEnvId, "staging", "staging")],
      revisions,
      deployments: [deployment],
      findings: [finding],
    },
    events,
  };
}

export function twoTenantFixture(): TwoTenantFixture {
  const a = tenant("alpha", "ws-alpha-01", "Alice");
  const b = tenant("bravo", "ws-bravo-01", "Bob");
  const data: Partial<Database> = {
    workspaces: [...a.rows.workspaces, ...b.rows.workspaces],
    members: [...(a.rows.members ?? []), ...(b.rows.members ?? [])],
    connections: [...(a.rows.connections ?? []), ...(b.rows.connections ?? [])],
    projects: [...(a.rows.projects ?? []), ...(b.rows.projects ?? [])],
    environments: [...(a.rows.environments ?? []), ...(b.rows.environments ?? [])],
    revisions: [...(a.rows.revisions ?? []), ...(b.rows.revisions ?? [])],
    deployments: [...(a.rows.deployments ?? []), ...(b.rows.deployments ?? [])],
    findings: [...(a.rows.findings ?? []), ...(b.rows.findings ?? [])],
  };
  return {
    data,
    events: [...a.events, ...b.events],
    alpha: a.t,
    bravo: b.t,
    canariesByWorkspace: { [a.t.workspaceId]: a.t.canaries.all, [b.t.workspaceId]: b.t.canaries.all },
  };
}

/** An id of the right shape that exists nowhere. */
export const phantomId = (prefix: string): string => `${prefix}-ghost-000`;
