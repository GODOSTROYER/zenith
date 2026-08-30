/**
 * Orrery canonical domain model.
 *
 * The Manifest is the single source of truth for an application:
 * the System Map, the Source view, the REST API, and the Navigator agent
 * all read and write THIS structure through typed actions. There is no
 * second model — a visual state can never diverge from the deployed truth.
 *
 * SPINE FILE — owned by the integrator. Agents import from here and must
 * not edit. Additions go through the integrator.
 */
import { z } from "zod";

/* ---------------------------------- ids ---------------------------------- */

export const id = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------- vocabulary ------------------------------ */

export const ServiceKind = z.enum(["web", "worker", "cron", "static"]);
export type ServiceKind = z.infer<typeof ServiceKind>;

export const ResourceKind = z.enum([
  "postgres",
  "redis",
  "object_store",
  "queue",
  "email",
]);
export type ResourceKind = z.infer<typeof ResourceKind>;

/** How Orrery relates to a node. Progressive adoption depends on this. */
export const Ownership = z.enum([
  "managed", // Orrery provisions and operates it
  "referenced", // exists in the customer cloud; Orrery reads state, never mutates
  "external", // documented only (e.g. a third-party API); no cloud presence
]);
export type Ownership = z.infer<typeof Ownership>;

export const ServiceSize = z.enum(["nano", "small", "standard", "performance"]);
export type ServiceSize = z.infer<typeof ServiceSize>;

/** What a binding grants. Determines injected config and network rules. */
export const BindingCapability = z.enum([
  "sql", // service -> postgres
  "cache", // service -> redis
  "blob", // service -> object_store
  "queue_publish",
  "queue_consume",
  "smtp", // service -> email
  "http", // route -> service, or service -> service
]);
export type BindingCapability = z.infer<typeof BindingCapability>;

/* --------------------------------- pieces -------------------------------- */

export const EnvVar = z.object({
  key: z.string().min(1),
  /** Exactly one of value / secretRef. Secrets never live in the manifest. */
  value: z.string().optional(),
  secretRef: z.string().optional(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const ServiceSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), image: z.string().min(1) }),
  z.object({
    type: z.literal("git"),
    repo: z.string().min(1),
    ref: z.string().default("main"),
    dockerfile: z.string().optional(),
  }),
  z.object({ type: z.literal("blueprint"), blueprint: z.string() }),
]);
export type ServiceSource = z.infer<typeof ServiceSource>;

export const Service = z.object({
  id: z.string(),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,30}$/, "lowercase letters, digits, dashes"),
  kind: ServiceKind,
  source: ServiceSource,
  size: ServiceSize.default("small"),
  /** Explicit, visible default — cost implications are shown before deploy. */
  replicas: z.number().int().min(0).max(10).default(1),
  port: z.number().int().min(1).max(65535).optional(),
  healthPath: z.string().optional(),
  /** cron services only */
  schedule: z.string().optional(),
  env: z.array(EnvVar).default([]),
  ownership: Ownership.default("managed"),
});
export type Service = z.infer<typeof Service>;

export const Resource = z.object({
  id: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  kind: ResourceKind,
  /** kind-specific settings, validated by the catalog */
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  size: ServiceSize.default("small"),
  ownership: Ownership.default("managed"),
  /** for `referenced` resources: the provider-side identifier */
  externalRef: z.string().optional(),
});
export type Resource = z.infer<typeof Resource>;

export const Route = z.object({
  id: z.string(),
  /** hostname, e.g. app.example.com or auto-assigned sandbox host */
  host: z.string().min(1),
  pathPrefix: z.string().default("/"),
  tls: z.boolean().default(true),
  /** auto = Orrery-assigned host on the environment's base domain */
  managedDns: z.boolean().default(true),
});
export type Route = z.infer<typeof Route>;

export const Binding = z.object({
  id: z.string(),
  /** node ids: route or service */
  from: z.string(),
  /** node ids: service or resource */
  to: z.string(),
  capability: BindingCapability,
  /**
   * Human explanation rendered on the edge — bindings are always explained.
   * e.g. "api reads and writes orders in postgres/main"
   */
  note: z.string().optional(),
});
export type Binding = z.infer<typeof Binding>;

export const ManifestPolicies = z.object({
  /** deploys to this environment require explicit human approval */
  approvalRequired: z.boolean().default(false),
  budgetUsdMonthly: z.number().positive().optional(),
  /** the Navigator may not delete stateful resources, ever, unless true */
  allowStatefulDeletion: z.boolean().default(false),
});
export type ManifestPolicies = z.infer<typeof ManifestPolicies>;

/* -------------------------------- manifest ------------------------------- */

export const Manifest = z.object({
  version: z.literal(1),
  services: z.array(Service).default([]),
  resources: z.array(Resource).default([]),
  routes: z.array(Route).default([]),
  bindings: z.array(Binding).default([]),
});
export type Manifest = z.infer<typeof Manifest>;

export const emptyManifest = (): Manifest => ({
  version: 1,
  services: [],
  resources: [],
  routes: [],
  bindings: [],
});

/* ------------------------------ org entities ------------------------------ */

export const EnvironmentClass = z.enum(["sandbox", "staging", "production"]);
export type EnvironmentClass = z.infer<typeof EnvironmentClass>;

export const ProviderId = z.enum([
  "sandbox",
  "localstack",
  "aws",
  "kubernetes",
  "gcp",
  "azure",
]);
export type ProviderId = z.infer<typeof ProviderId>;

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Member {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "viewer";
}

export interface CloudConnection {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  label: string;
  region: string;
  status: "connecting" | "healthy" | "degraded" | "disconnected";
  /** exact permission summary shown to the user */
  grantedPermissions: string[];
  createdAt: string;
  lastCheckedAt?: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  /** the editable working copy */
  workingManifest: Manifest;
  createdAt: string;
  /** how this project came to exist — shown in UI, used by importer */
  origin:
    | { type: "blank" }
    | { type: "blueprint"; blueprint: string }
    | { type: "import"; source: "compose" | "dockerfile" | "git" | "terraform" };
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  class: EnvironmentClass;
  connectionId: string;
  region: string;
  /** revision currently live in this environment (undefined = never deployed) */
  deployedRevisionId?: string;
  policies: ManifestPolicies;
  /** base domain for managed routes, e.g. "atlas.orrery.test" */
  baseDomain: string;
  createdAt: string;
}

export interface Revision {
  id: string;
  projectId: string;
  /** monotonically increasing per project */
  number: number;
  manifest: Manifest;
  message: string;
  author: Actor;
  createdAt: string;
}

/* ------------------------------- deployments ------------------------------ */

export const DeploymentStatus = z.enum([
  "planning",
  "awaiting_approval",
  "applying",
  "verifying",
  "succeeded",
  "failed",
  "rolling_back",
  "rolled_back",
  "cancelled",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface DeploymentStep {
  id: string;
  seq: number;
  /** phase grouping in the timeline UI */
  phase: "prepare" | "provision" | "release" | "verify";
  title: string;
  /** node this step concerns, for map highlighting; "" = whole system */
  targetId: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  /** provider-native detail, shown in the raw log toggle */
  detail?: string;
  error?: string;
}

export interface Output {
  key: string;
  label: string;
  value: string;
  kind: "url" | "hostname" | "connection" | "text";
  targetId?: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  environmentId: string;
  revisionId: string;
  status: DeploymentStatus;
  steps: DeploymentStep[];
  outputs: Output[];
  /** compact human summary of the changeset that produced it */
  changeSummary: string;
  estCostDeltaUsd: number;
  actor: Actor;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  /** revision live before this deployment; rollback target */
  previousRevisionId?: string;
}

/* --------------------------------- events --------------------------------- */

export type DeploymentEvent = {
  ts: string;
  deploymentId: string;
  seq: number;
} & (
  | { type: "status"; status: DeploymentStatus }
  | { type: "step"; stepId: string; status: StepStatus; error?: string }
  | { type: "log"; stepId: string; line: string; stream: "info" | "provider" }
  | { type: "output"; output: Output }
);

export interface Actor {
  type: "user" | "navigator" | "system";
  id: string;
  name: string;
}

export interface AuditEvent {
  ts: string;
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  actor: Actor;
  actionId: string;
  /** redacted input snapshot */
  input: unknown;
  result: "ok" | "error" | "denied";
  summary: string;
  error?: string;
}

/* ------------------------------- changesets ------------------------------- */

export type ChangeOp = "create" | "update" | "delete";

export interface ChangeItem {
  op: ChangeOp;
  /** "service" | "resource" | "route" | "binding" */
  nodeType: "service" | "resource" | "route" | "binding";
  nodeId: string;
  nodeName: string;
  /** field-level detail for updates */
  fields?: { field: string; before: unknown; after: unknown }[];
  /** plain-language explanation of the change and its consequence */
  explanation: string;
  costDeltaUsd: number;
  risk: "low" | "medium" | "high";
}

export interface Changeset {
  items: ChangeItem[];
  totalCostDeltaUsd: number;
  /** est. monthly cost after apply */
  projectedMonthlyUsd: number;
  warnings: string[];
}

/* ---------------------------- security findings ---------------------------- */

export interface SecurityFinding {
  id: string;
  projectId: string;
  environmentId?: string;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  targetId?: string;
  /** action id + input that resolves this finding, if automatable */
  fix?: { actionId: string; input: unknown; label: string };
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
}

/* ------------------------------- navigator -------------------------------- */

/** Autonomy dial. Level semantics are enforced by the action executor. */
export const AutonomyLevel = z.enum([
  "observe", // 1: advisory only
  "plan", // 2: prepares plans, never executes
  "approve", // 3: executes after explicit approval
  "bounded", // 4: auto-executes low-risk actions inside policy
  "autonomous", // 5: full autonomy inside budgets/environments/risk limits
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export interface NavigatorRun {
  id: string;
  projectId: string;
  goal: string;
  status: "planning" | "awaiting_approval" | "executing" | "done" | "failed" | "cancelled";
  steps: NavigatorStep[];
  createdAt: string;
  endedAt?: string;
  summary?: string;
}

export interface NavigatorStep {
  id: string;
  seq: number;
  title: string;
  rationale: string;
  actionId: string;
  input: unknown;
  risk: "low" | "medium" | "high";
  needsApproval: boolean;
  status: "proposed" | "approved" | "rejected" | "running" | "done" | "failed" | "skipped";
  resultSummary?: string;
  error?: string;
}
