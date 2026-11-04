/**
 * The seams between the MCP v3 tools and everything they do not own.
 *
 *   broker          the capability broker. Every tool goes through it; there is
 *                   no second, special MCP path (ARCHITECTURE invariant 1).
 *   reads           the product store (manifests, revisions, environments),
 *                   always filtered by workspace and project.
 *   observability   the federated log/metric fabric, run inside a credential
 *                   broker session opened with the grant `authorizeRead` issued.
 *   investigator    the incident engine (WS-INC). `unavailable` until wired.
 *   workflows       the Temporal client: availability probe, start, progress.
 *   scope           wraps a tool call in whatever the product store needs for
 *                   the call's duration (the per-request snapshot on Postgres).
 *
 * Production implementations are in `adapters.ts`. Tests pass fakes through the
 * same interfaces, so what they assert is the tool layer's behaviour, not a
 * mock's.
 */
import type { Broker } from "@/lib/capabilities/platform";
import type { OperationView } from "@/lib/capabilities/types";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { AnyManifest, ManifestPolicies } from "@/lib/domain/types";
import type { Investigation } from "@/lib/incidents/types";
import type { ObservabilityFabric } from "@/lib/observability/types";
import type { ProviderKey, ResourceGraph } from "@/lib/resources/types";
import type { DayTwoWorkflowInput, DeployWorkflowInput, WorkflowProgress } from "@/lib/workflows/types";
import type { AgentIdentity } from "./principal";

/* ------------------------------ product reads ------------------------------ */

export interface ProjectInfo {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  workingManifest: AnyManifest;
}

export interface EnvironmentInfo {
  id: string;
  projectId: string;
  name: string;
  class: "sandbox" | "staging" | "production";
  provider: ProviderKey;
  region: string;
  baseDomain: string;
  /** product-store connection id; the credential broker's resolver maps it to a provider connection */
  connectionId: string;
  deployedRevisionId?: string;
  /** Authoritative product environment policies; absent adapters cannot authorize V1 optimization. */
  policies?: ManifestPolicies;
}

export interface RevisionSummary {
  id: string;
  projectId: string;
  number: number;
  message: string;
  createdAt: string;
  deployedTo?: string[];
}

export interface RevisionInfo extends RevisionSummary {
  manifest: AnyManifest;
}

/**
 * Every method takes the workspace (and the project for anything below it) and
 * must filter on it: an id from another tenant answers `null`, exactly as a
 * missing one does. The broker has already decided the caller may read; this is
 * the second line.
 */
export interface ProjectReads {
  project(workspaceId: string, projectId: string): Promise<ProjectInfo | null>;
  environment(workspaceId: string, projectId: string, environmentId: string): Promise<EnvironmentInfo | null>;
  environments(workspaceId: string, projectId: string): Promise<EnvironmentInfo[]>;
  revision(workspaceId: string, projectId: string, revisionId: string): Promise<RevisionInfo | null>;
  /** newest first, at most `limit` */
  revisions(workspaceId: string, projectId: string, limit: number): Promise<RevisionSummary[]>;
}

export interface DeployAdmissionRequest {
  identity: AgentIdentity;
  target: { workspaceId: string; projectId: string; environmentId: string };
  revisionId: string;
  idempotencyKey: string;
  message?: string;
}

export interface PreparedDeployAdmission {
  deploymentId: string;
  input: Record<string, unknown>;
}

/** A committed product projection is an association, never execution authority. */
export interface DeployAdmissionPort {
  prepare(request: DeployAdmissionRequest): Promise<PreparedDeployAdmission>;
  bind(request: DeployAdmissionRequest, operation: OperationView): Promise<void>;
  /** Read current product authority independently of the enclosing tool snapshot. */
  validate(identity: AgentIdentity, operation: OperationView): Promise<DeployWorkflowInput>;
}

/* ------------------------------ observability ------------------------------ */

export interface FabricRequest {
  /** Internal deterministic collector selection; never a caller-supplied endpoint or credential. */
  purpose?: "cost";
  workspaceId: string;
  environment: EnvironmentInfo;
  graph: ResourceGraph;
  /**
   * The claims of the read grant `authorizeRead` issued for this exact read.
   * `undefined` only in a test fake; the production adapter refuses to open a
   * session without it.
   */
  grant: CapabilityGrantClaims;
}

export interface ObservabilityPort {
  /**
   * Run `fn` with a fabric whose cloud reads happen inside a credential-broker
   * session opened with `request.grant` (purpose `observe`). Cloud credentials
   * exist only inside that callback and are never returned. When no broker
   * session can be opened the fabric is built from `unavailable` sources that
   * say why, so the answer is a labelled gap rather than an empty list.
   */
  withFabric<T>(request: FabricRequest, fn: (fabric: ObservabilityFabric) => Promise<T>): Promise<T>;
}

/* -------------------------------- incidents -------------------------------- */

export interface InvestigationRequest {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  incidentId?: string;
  symptom?: string;
  range: { from: string; to: string };
  grant: CapabilityGrantClaims;
  signal?: AbortSignal;
}

/** The incident engine (`src/lib/incidents`, WS-INC). */
export interface Investigator {
  /** false → `investigate` is never called and the tool answers `unavailable` with `reason`. */
  readonly available: boolean;
  readonly reason?: string;
  investigate(request: InvestigationRequest): Promise<Investigation>;
}

/* -------------------------------- workflows -------------------------------- */

export interface StartedRef {
  workflowId: string;
  runId: string;
}

export type WorkflowAvailability = { available: true } | { available: false; reason: string };

/** Canonical durable start intents, plus availability and progress reads. */
export interface WorkflowPort {
  available(): Promise<WorkflowAvailability>;
  /** Retained mode refuses a claim without a committed start intent. */
  startDeploy(input: DeployWorkflowInput, mode: "new" | "retained"): Promise<StartedRef>;
  startDayTwo(input: DayTwoWorkflowInput, mode: "new" | "retained"): Promise<StartedRef>;
  /** `null` when there is no such workflow. May throw when no worker can answer. */
  progress(operationId: string): Promise<WorkflowProgress | null>;
}

/* --------------------------------- bundle ---------------------------------- */

export interface McpPorts {
  broker(): Promise<Broker>;
  reads: ProjectReads;
  deployments: DeployAdmissionPort;
  observability: ObservabilityPort;
  investigator: Investigator;
  workflows: WorkflowPort;
  /** The trusted origin approval URLs are built on (never a request header). */
  origin(): string;
  /** Run `fn` with the product store available for this identity. */
  scope<T>(identity: AgentIdentity, fn: () => Promise<T>): Promise<T>;
  now(): Date;
}
