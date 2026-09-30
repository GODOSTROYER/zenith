/**
 * Display vocabulary for the platform components: the human words for every
 * enum the control plane speaks. Raw codes (`awaiting_approval`, `aws:ecs_service`,
 * `missing`) never reach a screen on their own; each has a label here, and the
 * components show the code only inside a disclosure or tooltip next to that label.
 *
 * Pure data, `import type` only from the contracts so the client bundle never
 * pulls in a server module.
 */
import type { OperationStatus } from "@/lib/controlplane/types";
import type { Hop, Hypothesis } from "@/lib/incidents/types";
import type { DriftClass, HealthState, Presence, PortableKind, ProviderKey, ResourceOwnership } from "@/lib/resources/types";

/** The one sentence for an `uncertain` operation. Shown wherever the status appears. */
export const UNCERTAIN_EXPLANATION =
  "Zenith cannot prove whether this change happened; reconciliation will observe the real state.";

export const OPERATION_STATUS_LABEL: Record<OperationStatus, string> = {
  proposed: "Proposed",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  denied: "Blocked by policy",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  uncertain: "Outcome uncertain",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const OPERATION_STATUS_SENTENCE: Record<OperationStatus, string> = {
  proposed: "Zenith has recorded this proposal and is checking it against policy.",
  awaiting_approval: "A person must approve this exact proposal before anything changes.",
  approved: "Approved and waiting to be queued for execution.",
  rejected: "A person rejected this proposal. Nothing was changed.",
  denied: "Policy does not allow this change. Nothing was changed.",
  queued: "Approved and queued. Execution has not started yet.",
  running: "Execution is in progress.",
  succeeded:
    "Execution finished without an error. The result is confirmed the next time Zenith observes the real state.",
  failed:
    "Execution stopped with an error. Some changes may have been made before it stopped; check the timeline.",
  uncertain: UNCERTAIN_EXPLANATION,
  cancelled: "This operation was cancelled before it ran to completion.",
  expired: "The proposal or its approval expired before it could run. Ask for a new proposal.",
};

export const PROVIDER_LABEL: Record<ProviderKey, string> = {
  aws: "AWS",
  gcp: "Google Cloud",
  azure: "Azure",
  oci: "Oracle Cloud",
  kubernetes: "Kubernetes",
  zenith: "Zenith managed",
  sandbox: "Sandbox (simulated)",
  localstack: "LocalStack",
};

export const KIND_LABEL: Record<PortableKind | "provider_native", string> = {
  network: "Network",
  subnet: "Subnet",
  firewall: "Firewall",
  load_balancer: "Load balancer",
  dns_zone: "DNS zone",
  dns_record: "DNS record",
  tls_certificate: "TLS certificate",
  container_service: "Container service",
  container_registry: "Container registry",
  compute_instance: "Compute instance",
  function: "Function",
  static_site: "Static site",
  scheduled_job: "Scheduled job",
  postgres: "PostgreSQL database",
  mysql: "MySQL database",
  redis: "Redis cache",
  object_store: "Object storage",
  queue: "Queue",
  pubsub: "Pub/sub topic",
  secret: "Secret",
  identity: "Identity",
  log_group: "Log group",
  kubernetes_cluster: "Kubernetes cluster",
  kubernetes_namespace: "Kubernetes namespace",
  volume: "Volume",
  build_pipeline: "Build pipeline",
  provider_native: "Provider-native resource",
};

export const OWNERSHIP_LABEL: Record<ResourceOwnership, string> = {
  managed: "Managed by Zenith",
  referenced: "Referenced",
  external: "External",
};

export const OWNERSHIP_SENTENCE: Record<ResourceOwnership, string> = {
  managed: "Zenith creates, changes and can repair this resource.",
  referenced: "Zenith reads this resource and connects to it, but does not change it.",
  external: "This resource lives outside Zenith's control. Zenith never changes it.",
};

export const PRESENCE_LABEL: Record<Presence, string> = {
  present: "Present",
  missing: "Missing",
  inaccessible: "Not accessible",
  unknown: "Unknown",
};

export const PRESENCE_SENTENCE: Record<Presence, string> = {
  present: "Zenith found this resource at the provider.",
  missing: "Zenith looked and this resource does not exist at the provider.",
  inaccessible: "The connected role is not allowed to see this resource, so Zenith cannot say whether it exists.",
  unknown: "Zenith has not been able to tell whether this resource exists.",
};

export const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unhealthy: "Unhealthy",
  unknown: "Health unknown",
};

export const DRIFT_CLASS_LABEL: Record<DriftClass, string> = {
  missing: "Missing",
  changed: "Changed",
  extra: "Not in the configuration",
  inaccessible: "Not accessible",
  unknown: "Unknown",
};

export const DRIFT_CLASS_SENTENCE: Record<DriftClass, string> = {
  missing: "The configuration says these should exist, but the provider does not have them.",
  changed: "These exist, but their settings differ from the configuration.",
  extra: "These exist at the provider but are not part of the configuration.",
  inaccessible: "Zenith's role could not read these, so their state is not known.",
  unknown: "Zenith could not determine the state of these.",
};

export const HOP_LABEL: Record<Hop, string> = {
  dns: "DNS",
  tls: "TLS certificate",
  load_balancer: "Load balancer",
  firewall: "Firewall",
  compute: "Compute",
  container: "Container",
  application: "Application",
  database: "Database",
  cache: "Cache",
  queue: "Queue",
  secret: "Secret",
  identity: "Identity",
  deployment: "Deployment",
  drift: "Drift",
};

export const HYPOTHESIS_CATEGORY_LABEL: Record<Hypothesis["category"], string> = {
  drift: "Drift from the configuration",
  runtime: "Runtime failure",
  deployment: "Bad deployment",
  configuration: "Configuration",
  capacity: "Capacity",
  dependency: "Dependency",
  identity: "Identity and access",
  unknown: "Unclassified",
};

/** Workspace roles in increasing authority. */
export const ROLE_RANK = { none: 0, viewer: 1, editor: 2, admin: 3 } as const;
export type RoleName = keyof typeof ROLE_RANK;
