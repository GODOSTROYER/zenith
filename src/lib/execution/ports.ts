/**
 * The ports the execution activities are written against (WS-ACT).
 *
 * The activities are the integration point between merged modules (resource
 * model, OpenTofu engine, policy facts, driver registry) and modules that live
 * on other branches (platform store repositories, capability broker, credential
 * broker, AWS drivers, cost engine, observability). Everything unmerged is a
 * port here, so this module compiles, is tested and ships without importing any
 * of it. Each port says which implementation is meant to back it; wiring them
 * is the orchestrator's job (`createExecutionActivities(deps)`).
 *
 * Tenancy: the workflow passes activities only an operation id. The first thing
 * an activity does is `ops.get(operationId)`; every later call names the
 * operation's `workspaceId`, so every read and write below is workspace-scoped
 * in SQL by the adapter. `ops.get` and `product.resolveEnvironment` are the two
 * trusted system-level lookups (the worker is trusted and the id is all the
 * workflow has); an adapter must not expose them to any request path.
 *
 * Secrets: no port carries a credential. The only place cloud credentials
 * exist is the `ProviderSession` the `CredentialBroker` hands to a callback.
 * `BrokerPort.issueGrant` returns a signed grant (a bearer for the broker, not
 * a cloud credential); the activities use its claims and never store, log or
 * return the compact form.
 */
import type {
  CapabilityGrantClaims,
  EvidenceRecord,
  Lease,
  OperationRecord,
  OperationStatus,
  PlatformEvent,
} from "@/lib/controlplane/types";
import type { CredentialBroker, ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import type { MachineDrivers, MachineEvidenceSink, MachineRequestDispatcher } from "@/lib/machines/types";
import type { KubernetesSessionDeps } from "@/lib/providers/kubernetes/session";
import type { AgentRecord } from "@/lib/runners/ports";
import type { DriverContext, ResourceDriver } from "@/lib/drivers/types";
import type { ManifestPolicies } from "@/lib/domain/types";
import type { ObservabilityFabric } from "@/lib/observability/types";
import type { PlanFacts } from "@/lib/policy/types";
import type { DriftReport, Observation, ProviderKey, ResourceGraph, ResourceNode, ResourceOwnership, RuntimeState } from "@/lib/resources/types";
import type { ApprovedPlan, ProducedPlan, ApplyVerifiedResult, EngineOptions, PlanCustodyInput, PlanWorkspaceOptions, PlanWorkspaceResult } from "@/lib/tofu/engine";
import type { BackendConfig } from "@/lib/tofu/workspace";
import type { ProviderSetName, ProviderSetSpec } from "@/lib/tofu/providers";
import type { TofuSessionEnv } from "@/lib/tofu/runner";
import type { TofuWorkspace } from "@/lib/tofu/types";
import type { DeploymentStatus, EnvironmentClass, Output, StepStatus } from "@/lib/domain/types";
import type { LeaseRef, PolicyStepResult, StepName, WorkflowOperationStatus } from "@/lib/workflows/types";

export type { CredentialBroker };

export interface FenceRef {
  scope: string;
  fenceToken: number;
}

/* ------------------------------------------------------------------------- */
/*                               platform store                              */
/* ------------------------------------------------------------------------- */

export type { WorkflowOperationStatus };

/**
 * Operations ledger. Backed by WS-DB `controlplane/operations` (+ repos).
 *
 * `transition` is the single status writer. Its adapter maps the workflow's
 * statuses onto the ledger's state machine:
 *   running            claimForExecution when approved/queued; a no-op when already running
 *   awaiting_approval  running -> awaiting_approval (plan-level approval needs an edge the ledger does
 *                      not have today: see the handoff) and back to approved -> running after approval
 *   succeeded/failed   completeOperation
 *   uncertain          markUncertain
 *   cancelled/expired  cancelOperation / expireOverdue
 * It returns the operation as it stands AFTER the call: `null` when the
 * operation does not exist in that workspace; otherwise the record, whose
 * `status` tells the caller whether the move applied or someone else got there
 * first (terminal is terminal; a second identical call is a no-op that returns
 * the record). The adapter also appends the `operation.*` lifecycle event in the
 * same transaction (WS-DB's service functions already do), so the activities do
 * NOT emit those.
 */
export interface OperationsPort {
  /** System-level lookup by id (see the tenancy note in the module comment). */
  get(operationId: string): Promise<OperationRecord | null>;
  transition(input: { workspaceId: string; operationId: string; to: WorkflowOperationStatus; error?: string }): Promise<OperationRecord | null>;
  /**
   * Record that the outcome of a running operation cannot be proven (a lease
   * was lost, a mutating call timed out). Conditional on `running`; a no-op
   * otherwise. Terminal for automation: nothing re-dispatches it.
   */
  markUncertain(input: { workspaceId: string; operationId: string; reason: string }): Promise<OperationRecord | null>;
  /**
   * Extend the running operation's execution lease (the ledger marks a running
   * operation whose lease lapsed `uncertain`, default after 60 s). Resolves
   * `false` when the operation is no longer running (the reconciler already gave
   * up on it, or it finished): the activity must stop. The adapter claims with a
   * holder derived from the operation id, not the worker id, so any worker's
   * activity can extend it.
   */
  heartbeat(input: { workspaceId: string; operationId: string }): Promise<boolean>;
  /** Plan digest the operation was planned against. The store keeps the first one it is given. */
  setPlanDigest(input: { workspaceId: string; operationId: string; planDigest: string }): Promise<void>;
  /** Link the latest policy decision record (written by the capability broker) to the operation. */
  setPolicyDecision(input: { workspaceId: string; operationId: string; decisionId: string }): Promise<void>;
}

/**
 * Environment leases with fence tokens. Backed by WS-DB `controlplane/db/repos/leases`
 * (acquire / renew / release / assertFence), bound to the platform `Sql`.
 *
 * `acquire` resolves to `null` when another holder has the scope (the activity
 * raises `LeaseBusyError`); `renew` resolves to `null` when the lease is lost.
 * `assertFence` throws `LeaseLostError` (the repo's own) when it is not live.
 * The adapter appends NO `lease.*` events: the activities do, so they appear
 * once.
 */
export interface LeasesPort {
  acquire(input: { scope: string; holder: string; ttlMs: number; workspaceId?: string;
    /** Internal worker context: bind a claimed operation before its first source capture. Not public authority. */
    operation?: { id: string; proposalDigest: string };
  }): Promise<Lease | null>;
  renew(lease: LeaseRef, ttlMs: number): Promise<Lease | null>;
  release(lease: LeaseRef): Promise<boolean>;
  assertFence(scope: string, fenceToken: number): Promise<void>;
}

/** Fields an activity supplies for an event; the store assigns `seq` and `ts`. */
export type NewPlatformEvent = Omit<PlatformEvent, "seq" | "ts" | "id"> & {
  /** deterministic ids make a retried activity's event a no-op; the adapter must treat a repeated id as idempotent */
  id?: string;
};

/** Structured event log. Backed by WS-DB `repos/events.append`. */
export interface EventsPort {
  append(event: NewPlatformEvent): Promise<void>;
}

export type NewEvidence = Omit<EvidenceRecord, "id" | "createdAt"> & {
  /** deterministic id: re-appending the same id must return the existing row, not fail */
  id?: string;
};

/** Evidence ledger. Backed by WS-DB `repos/evidence` (insert must be insert-or-return on a repeated id). */
export interface EvidencePort {
  append(evidence: NewEvidence): Promise<EvidenceRecord>;
  /** Newest evidence of `kind` for an operation, optionally restricted to one digest and planning stage. */
  find(input: { workspaceId: string; operationId: string; kind: EvidenceRecord["kind"]; digest?: string; stage?: "plan" | "final_plan" }): Promise<EvidenceRecord | null>;
}

export type ResourceStatusName = "planned" | "provisioning" | "active" | "updating" | "deleting" | "deleted" | "failed" | "unknown";

/** A resource row as the platform store holds it (structurally WS-DB's `PlatformResource`). */
export interface StoredResource {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  address: string;
  kind: string;
  provider: string;
  region?: string;
  nativeType: string;
  ownership: ResourceOwnership;
  externalId?: string;
  specDigest: string;
  spec: Record<string, unknown>;
  dependsOn: string[];
  origin: string[];
  labels: Record<string, string>;
  revisionId?: string;
  status: ResourceStatusName;
}

/**
 * The resource graph in the platform store: desired nodes, observations,
 * runtime state and drift reports. Backed by WS-DB `repos/resources`,
 * `repos/observations` and `repos/drift`. `upsertDesired` throws an error with
 * `code === "conflict"` when an update would change a resource's ownership;
 * `validateDesiredState` turns that into a problem rather than a crash.
 */
export interface ResourcesPort {
  upsertDesired(input: { workspaceId: string; projectId?: string; environmentId: string; node: ResourceNode; revisionId?: string }): Promise<StoredResource>;
  list(workspaceId: string, environmentId: string): Promise<StoredResource[]>;
  get(workspaceId: string, resourceId: string): Promise<StoredResource | null>;
  setStatus(input: { workspaceId: string; resourceId: string; status: ResourceStatusName }): Promise<void>;
  appendObservation(input: { workspaceId: string; resourceId: string; observation: Observation }): Promise<void>;
  upsertRuntime(input: { workspaceId: string; resourceId: string; runtime: RuntimeState }): Promise<void>;
  latestDriftReport(workspaceId: string, environmentId: string): Promise<DriftReport | null>;
  /** Approved, unrevoked field-ownership transfers for the environment. Absent in ports that persist none. */
  activeOwnershipTransfers?(workspaceId: string, environmentId: string): Promise<import("@/lib/ownership").OwnershipTransfer[]>;
  saveDriftReport(input: { workspaceId: string; report: DriftReport }): Promise<void>;
}

/**
 * Provider connections. Backed by WS-DB `repos/connections` (`get` by id, or by
 * `legacyConnectionId` for the product-store connection an environment points
 * at). The resolved `ProviderConnection.id` is what the credential broker wants.
 * Returns `null` for an unknown, other-workspace or revoked connection.
 */
export interface ConnectionsPort {
  resolve(input: { workspaceId: string; connectionId: string }): Promise<ProviderConnection | null>;
}

/* ------------------------------------------------------------------------- */
/*                               product store                               */
/* ------------------------------------------------------------------------- */

export interface ProductRevision {
  id: string;
  number: number;
  /** the stored manifest, unparsed: a V1 or V2 document (`parseManifest` decides) */
  manifest: unknown;
}

/** Everything the execution of one operation needs from the product store. */
export interface ProductContext {
  workspace: { id: string; name: string; slug: string };
  project: { id: string; name: string; slug: string };
  environment: {
    id: string;
    name: string;
    class: EnvironmentClass;
    /** from the environment's connection (`CloudConnection.provider`) */
    provider: ProviderKey;
    region: string;
    baseDomain: string;
    /** the PRODUCT connection id (`Environment.connectionId`); `ConnectionsPort` maps it to the platform connection */
    connectionId: string;
    policies: ManifestPolicies;
    deployedRevisionId?: string;
    activeDeploymentId?: string;
  };
  /** the revision being deployed (`revisionId`), else the environment's deployed one; absent when neither exists */
  revision?: ProductRevision;
  deploymentId?: string;
}

export type DeploymentOutcome = "succeeded" | "failed" | "uncertain" | "cancelled" | "expired";

/**
 * The product store as the execution worker needs it: read the context of an
 * operation, and write the Deployment PROJECTION the UI follows. Implemented
 * for real in `product-port.ts` over `@/lib/db/store` (file or Postgres) — the
 * one port in this module that is not just an interface.
 *
 * The projection is best-effort in the workflow (`recordStep` failures never
 * abort a deploy), so every write here is idempotent and tenant-checked: a
 * deployment that does not belong to the workspace/environment is refused, not
 * written.
 */
export interface ProductPort {
  loadContext(input: { workspaceId: string; environmentId: string; revisionId?: string; deploymentId?: string }): Promise<ProductContext>;
  loadRevision(input: { workspaceId: string; environmentId: string; revisionId: string }): Promise<ProductRevision | null>;
  /** System-level: which workspace/project owns this environment (reconcile passes have no operation row). */
  resolveEnvironment(environmentId: string): Promise<{ workspaceId: string; projectId: string } | null>;
  /** Upsert one step of the deployment's timeline; a no-op when nothing changed. Late writes to a finished deployment are ignored. */
  recordStep(input: {
    workspaceId: string;
    environmentId: string;
    deploymentId: string;
    step: StepName;
    status: StepStatus;
    detail?: string;
    at: string;
    /** non-terminal deployment status this step transition implies, set in the same write */
    deploymentStatus?: DeploymentStatus;
  }): Promise<void>;
  /** Non-terminal status (planning, awaiting_approval, applying, verifying). Ignored once the deployment is terminal. */
  setDeploymentStatus(input: { workspaceId: string; environmentId: string; deploymentId: string; status: DeploymentStatus; at: string }): Promise<void>;
  recordOutputs(input: { workspaceId: string; environmentId: string; deploymentId: string; outputs: Output[] }): Promise<void>;
  /**
   * Terminal outcome: sets the deployment's final status and error, releases
   * the environment's `activeDeploymentId` when this deployment holds it, and —
   * for `succeeded` only — commits `deployedRevisionId` and `revision.deployedTo`.
   */
  commitOutcome(input: { workspaceId: string; environmentId: string; deploymentId: string; outcome: DeploymentOutcome; error?: string; at: string }): Promise<void>;
}

/* ------------------------------------------------------------------------- */
/*                         capability / policy broker                        */
/* ------------------------------------------------------------------------- */

/** What the policy engine's `input.plan` holds (`PolicyInput["plan"]`). */
export interface PlanPolicyInput extends PlanFacts {
  costDeltaUsdMonthly?: number;
  projectedMonthlyUsd?: number;
}

/**
 * The capability broker as the execution worker sees it. Backed by WS-CAP
 * (`capabilities/broker`, `approvals`, `grants`).
 *
 * `reevaluate` re-runs policy for the operation (with the plan facts computed
 * from OUR normalized plan), persists the `PolicyDecisionRecord` and returns the
 * outcome the workflow branches on.
 *
 * `issueGrant` mints a short-lived capability grant for the operation. The
 * optional `capability` asks for a WEAKER capability than the operation's own
 * (the activities request `infrastructure.plan` for plans and
 * `infrastructure.observe` for read-only verification, because the credential
 * broker refuses the observe role to a mutating capability). The broker must
 * refuse a capability that is not at most as powerful as the operation's; by
 * default it is the operation's own.
 *
 * `durationSec` is the lifetime the activity needs: plan and apply can run 30
 * minutes or more and an AWS session cannot outlive its grant. The broker caps
 * it by policy; when it grants less, a run longer than the grant fails with
 * expired credentials part-way (see the handoff).
 */
/** Worker-private current-policy proof. Public approval activities project only booleans and one display ID. */
export interface DispatchApprovalSnapshot {
  approvalIds: readonly string[];
  requiredApprovalCount: number;
  approvalRound: number;
  proposalDigest: string;
  planDigest?: string;
}
/** Worker-private same-dispatch capture. Its shape alone grants no authority. */
export interface CurrentDispatchRequirement {
  readonly requirement: Readonly<{ count: number; minRole: "editor" | "admin"; separationOfDuties: boolean }> | null;
  readonly policy: Readonly<{ version: string; inputDigest: string; input: import("@/lib/policy/types").PolicyInput }>;
  readonly operation: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<{ workspace: Record<string, unknown> | null; environment: Record<string, unknown> | null }>;
  readonly evidence: Readonly<{ id: string; digest: string; summary: Record<string, unknown> }> | null;
  readonly approvals: readonly Readonly<Record<string, unknown>>[];
}
export interface BrokerPort {
  reevaluate(operationId: string, plan?: PlanPolicyInput): Promise<PolicyStepResult>;
  approvalStatus(operationId: string): Promise<{ approved: boolean; rejected: boolean; approvalId?: string; dispatchApproval?: DispatchApprovalSnapshot }>;
  issueGrant(
    operationId: string,
    audience: string,
    fence?: FenceRef,
    opts?: { capability?: string; durationSec?: number }
  ): Promise<{ jws: string; claims: CapabilityGrantClaims }>;
}

/* ------------------------------------------------------------------------- */
/*                   drivers, OpenTofu, cost, observability                   */
/* ------------------------------------------------------------------------- */

/** (provider, nativeType) → driver. Default: the global registry's `findDriver`. */
export type DriverLookup = (provider: ProviderKey, nativeType: string) => ResourceDriver | undefined;

/** The two engine entry points. Default: the merged real ones from `@/lib/tofu`. */
export interface TofuPort {
  planWorkspace(ws: TofuWorkspace, session?: TofuSessionEnv, opts?: PlanWorkspaceOptions): Promise<PlanWorkspaceResult>;
  applyVerifiedPlan(ws: TofuWorkspace, args: { approvedDigest: string; session?: TofuSessionEnv; original?: ApprovedPlan; custody?: PlanCustodyInput; beforeDispatch?: () => Promise<void> } & EngineOptions): Promise<ApplyVerifiedResult>;
}

/**
 * Monthly cost of a graph. Default: `estimateGraphCost` over the default price
 * catalog (`defaultCostPort`). `null` = no estimate (no price for something in
 * the graph): the activities then report the cost delta as absent, never as zero.
 */
export interface CostPort {
  estimate(graph: ResourceGraph): Promise<{ monthlyUsd: number; catalogVersion: string } | null>;
}

/**
 * The federated observability fabric (WS-OBS, merged) for one environment,
 * built over a session the activity already holds. Default: the real fabric —
 * `createObservabilityFabric(sourcesForEnvironment({ provider, graph, sessions }))`.
 * Only used to attach bounded, redacted diagnostics to a FAILED verification;
 * tests inject a scripted one.
 */
export type ObservabilityFactory = (input: {
  session: ProviderSession;
  provider: ProviderKey;
  graph: ResourceGraph;
  workspaceId: string;
  observations: readonly Observation[];
}) => Pick<ObservabilityFabric, "searchLogs" | "searchEvents">;

/* ------------------------------------------------------------------------- */
/*                         prober, build, rollout, tasks                      */
/* ------------------------------------------------------------------------- */

export interface ProbeRequest {
  /** a host present in the graph's dns_record nodes; the prober refuses anything not in `allowedHosts` */
  host: string;
  /** absolute path beginning with `/`, without query string */
  path: string;
  allowedHosts: ReadonlySet<string>;
}

export type ProbeOutcome =
  /** an HTTP response arrived (any status) */
  | "responded"
  /** refused by the safety rules (host not allowed, bad path, non-public address): says nothing about the app */
  | "refused"
  /** DNS failure, connection failure, TLS failure or timeout */
  | "unreachable";

export interface ProbeResult {
  host: string;
  path: string;
  outcome: ProbeOutcome;
  status?: number;
  latencyMs?: number;
  /** body bytes read (capped) */
  bytes?: number;
  truncated?: boolean;
  /** sha256 of the bytes read; the body itself is never kept */
  bodyDigest?: string;
  /** the certificate's notAfter, ISO 8601, when a TLS session was established */
  tlsExpiresAt?: string;
  /** the address that was connected to (resolved once, validated, then used) */
  address?: string;
  /** short reason for `refused` / `unreachable`; contains no response content */
  reason?: string;
}

/** The safe HTTP prober (`prober.ts` implements it). */
export interface ProberPort {
  probe(req: ProbeRequest): Promise<ProbeResult>;
}

/**
 * Where a built service's source comes from. Source acquisition (clone a repo,
 * tar it, upload it to the customer's artifact bucket, ADR-0016) is out of scope
 * for this module: it is a port. The implementation uploads the bundle with the
 * brokered session in `ctx` and returns where it is and what it contained.
 */
export interface SourceBundlePort {
  capture?(input: import("./source-snapshot").SourceCaptureInput, signal?: AbortSignal): Promise<import("./source-snapshot").ApprovedSourceSnapshot>;
  verify?(snapshot: import("./source-snapshot").ApprovedSourceSnapshot, signal?: AbortSignal): Promise<void>;
  prepare(
    ctx: DriverContext,
    input: { service: ResourceNode; source: { repo: string; ref: string; dockerfile?: string }; approvedSource?: import("./source-snapshot").ApprovedSourceSnapshot }
  ): Promise<{ s3Key: string; digest: string; bucket?: string }>;
}

export interface BuildHandle {
  buildId: string;
}

export interface BuildResult {
  status: "succeeded" | "failed" | "stopped" | "timed_out";
  /** `<registry>/<repo>@sha256:…` or `<registry>/<repo>:<tag>` */
  imageUri?: string;
  /** `sha256:<64 hex>` */
  digest?: string;
  /** short, redacted phase/failure description */
  detail?: string;
  /**
   * What the provider reported about the executed build (identity, network, mount, resources).
   * Required for a successful source build: release refuses an artifact without it (PROD-LIFE-09).
   */
  attestation?: import("./build-isolation").BuildAttestation;
}

/** Signing and pinned verification keys for build provenance (the control-plane EdDSA key). */
export interface BuildProvenanceAuthority {
  signer(): Promise<import("@/lib/credentials/signing/types").JwtSigner | undefined>;
  keys(): Promise<readonly import("@/lib/credentials/signing/types").PublicJwk[]>;
}

/** CodeBuild in the customer's account (ADR-0016). Backed by the compute drivers' build helper (WS-AWS-CMP). */
export interface BuildPort {
  startBuild(
    ctx: DriverContext,
    input: { service: ResourceNode; pipeline: ResourceNode; registry?: ResourceNode; source: { s3Key: string; digest: string; bucket?: string }; idempotencyKey: string }
  ): Promise<BuildHandle>;
  waitForBuild(ctx: DriverContext, handle: BuildHandle, opts: { timeoutMs: number }): Promise<BuildResult>;
}

/** ECS rollout. Backed by the compute drivers' ECS operation (WS-AWS-CMP). */
export interface WorkloadsPort {
  /** Point `service` at `image` (registers a task definition revision and updates the service). Idempotent on `idempotencyKey`. */
  deployImage(ctx: DriverContext, service: ResourceNode, image: { uri: string; digest: string }, opts: { idempotencyKey: string }): Promise<{ detail?: string }>;
  /** Wait until the service reaches steady state (`steady: false` on timeout or a failed rollout). */
  waitSteady(ctx: DriverContext, service: ResourceNode, opts: { timeoutMs: number }): Promise<{ steady: boolean; detail?: string }>;
}

/** One-off tasks (release migrations). Backed by the compute drivers' run-task operation (WS-AWS-CMP). */
export interface MigrationsPort {
  /** Run `command` (an argv vector, never a shell string) once as a task of `service`; resolves with its exit code. */
  runOneOffTask(
    ctx: DriverContext,
    service: ResourceNode,
    command: readonly string[],
    opts: { timeoutMs: number; idempotencyKey: string }
  ): Promise<{ exitCode: number; logsRef?: string }>;
}

/* ------------------------------------------------------------------------- */
/*                                   deps                                     */
/* ------------------------------------------------------------------------- */

export interface WorkspaceOverrides {
  /** provider → committed lockfile set. Default: aws→aws, gcp→gcp, azure→azure, oci→oci, kubernetes/zenith→kubernetes. */
  providerSet?(provider: ProviderKey): ProviderSetName | ProviderSetSpec | undefined;
  /**
   * State backend. Default (AWS only): S3 bucket + KMS key from the connection's
   * `stateBucket` / `stateKmsKeyArn`, key `zenith/<workspace>/<environment>/terraform.tfstate`.
   * Tests use a local backend here.
   */
  backend?(input: { connection: ProviderConnection; workspaceId: string; environmentId: string }): { backend: BackendConfig; stateKey?: string };
}

export interface ExecutionLimits {
  /** lease time-to-live requested on every renewal */
  leaseTtlMs: number;
  /** how often a long activity heartbeats and renews its lease (must stay well under the workflow's 60 s heartbeat timeout) */
  heartbeatIntervalMs: number;
  /** drivers called in parallel by verify/observe */
  concurrency: number;
  /** wall clock for one driver call (observe/runtime/verify) */
  nodeTimeoutMs: number;
  buildTimeoutMs: number;
  steadyTimeoutMs: number;
  migrationTimeoutMs: number;
  /** verifyApplication: attempts and pause per host before a failing probe is believed */
  probeAttempts: number;
  probeIntervalMs: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  leaseTtlMs: 5 * 60_000,
  heartbeatIntervalMs: 10_000,
  concurrency: 4,
  nodeTimeoutMs: 60_000,
  buildTimeoutMs: 30 * 60_000,
  steadyTimeoutMs: 20 * 60_000,
  migrationTimeoutMs: 15 * 60_000,
  probeAttempts: 6,
  probeIntervalMs: 10_000,
};

/** Composition root supplies tenant-scoped observation/registration reads and blob-capable evidence. */
export interface MachineExecutionPort {
  latestObservation(workspaceId: string, resourceId: string): Promise<Observation | null>;
  /** Return the uniquely bound machine, or null. Never choose arbitrarily among multiple bindings. */
  boundMachine(workspaceId: string, environmentId: string, address: string): Promise<AgentRecord | null>;
  evidence: MachineEvidenceSink;
  dispatcher?: MachineRequestDispatcher;
  kubernetes?: KubernetesSessionDeps;
  /** Tests may inject fake transports; default the merged transports (simulated in sandbox). */
  drivers?: MachineDrivers;
}

export interface PlanArtifactsPort {
  readonly kind: "postgres" | "isolated-test";
  associate(input: { workspaceId:string; sourceOperationId:string; destinationOperationId:string; sourceEvidenceId:string; planDigest:string; lease:LeaseRef }): Promise<void>;
  publish(input: { produced?: ProducedPlan; lease: LeaseRef; evidence: NewEvidence }): Promise<void>;
  inspect<T>(input: ArtifactAccess, fn: (approved: ApprovedPlan) => Promise<T>): Promise<T>;
  consume<T>(input: ArtifactAccess, fn: (approved: ApprovedPlan, dispatch: () => Promise<void>) => Promise<T>): Promise<T>;
}
export interface ArtifactAccess { custody: PlanCustodyInput; planDigest: string; lease: LeaseRef }

export interface ExecutionDeps {
  /* platform store */
  ops: OperationsPort;
  leases: LeasesPort;
  events: EventsPort;
  evidence: EvidencePort;
  resources: ResourcesPort;
  connections: ConnectionsPort;
  /* product store */
  product: ProductPort;
  /* broker and credentials */
  broker: BrokerPort;
  credentials: CredentialBroker;
  machines?: MachineExecutionPort;
  /** Required by canonical production planning/apply. Explicit isolated adapters are for tests only. */
  planArtifacts?: PlanArtifactsPort;
  /* engine */
  /** default: the global driver registry */
  drivers?: DriverLookup;
  /** default: the merged engine (`planWorkspace`, `applyVerifiedPlan`) */
  tofu?: TofuPort;
  /**
   * REQUIRED. Key for the HMAC fingerprints of SENSITIVE plan changes (they make a
   * rotated secret move `planDigest` although the plan only shows "(sensitive)").
   * Derive it from a server secret (e.g. HKDF of the install secret with the info
   * string "zenith/tofu-plan-fingerprint"); every worker must use the SAME key or
   * plan digests computed on different workers disagree and every apply looks like
   * `plan_changed`. Never the public-digest default the engine falls back to: that
   * one is derivable from the plan's own digests, so a low-entropy secret could be
   * confirmed by guessing. Rotating the key invalidates pending approvals of plans
   * that contain sensitive changes (they fail with `plan_changed`).
   */
  fingerprintKey: string;
  tofuWorkspace?: WorkspaceOverrides;
  /** default: the placement cost engine over the default price catalog (`cost.ts`) */
  cost?: CostPort;
  /** default: the real observability fabric */
  observability?: ObservabilityFactory;
  /* release */
  prober: ProberPort;
  sourceBundle?: SourceBundlePort;
  sourceSnapshots?: import("@/lib/controlplane/db/repos/approved-source-snapshots").ApprovedSourceSnapshotStore;
  build?: BuildPort;
  /** Required to release any built artifact: signs provenance after a build and verifies it before rollout. */
  provenance?: BuildProvenanceAuthority;
  /** Build isolation admission policy; default refuses unrestricted egress. */
  buildIsolation?: import("./build-isolation").BuildIsolationPolicy;
  workloads?: WorkloadsPort;
  migrations?: MigrationsPort;
  /* runtime */
  /** Temporal's `Context.current().heartbeat`, wired by the worker. Default: no-op. */
  heartbeat?: (detail?: unknown) => void;
  /** Temporal's `Context.current().cancellationSignal`, per activity invocation. Default: none. */
  activitySignal?: () => AbortSignal | undefined;
  clock?: () => Date;
  /** unique id source for rows that have no natural deterministic id */
  ids?: () => string;
  /** pause between probe attempts; default real timers (tests inject an immediate one) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** identity of this worker, used in lease holders: `worker:<workerId>:<operationId>` */
  workerId: string;
  /** directory for binary plan files (mode 0600); never synced anywhere */
  planDir: string;
  limits?: Partial<ExecutionLimits>;
  /** diagnostics sink; never receives secrets */
  log?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}

export type { OperationRecord, OperationStatus };
