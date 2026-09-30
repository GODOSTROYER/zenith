/**
 * Level 2 vocabulary: which native service realizes a portable primitive on a
 * given provider (ADR-0003). One table, shared by expansion, placement and the
 * resource drivers, so a driver registered for `aws:ecs_service` and the node
 * `expandManifest()` emits for a container service can never disagree about
 * the string.
 *
 * Honest limits:
 *   - These are the names drivers register under `(provider, nativeType)`
 *     (`src/lib/drivers/types.ts`). A mapping here does NOT mean a driver
 *     exists or has been verified; that is the driver's own evidence level.
 *   - The GCP / Azure / OCI / LocalStack rows are best-effort vocabulary for
 *     drivers that are built later (WS-GCP, WS-AZURE, WS-OCI). Rename with the
 *     driver author, in this one file.
 *   - A kind with no row is reported as `unsupported:<provider>:<kind>`; the
 *     node is kept and expansion adds a note. It is never silently dropped.
 */
import { PORTABLE_KINDS, type PortableKind, type ProviderKey } from "./types";

/**
 * Prefix each provider's native types carry. Kubernetes (and Zenith-managed
 * clusters, which are Kubernetes underneath) use the object's `kind` as the
 * type, e.g. `k8s:Deployment`.
 */
export const NATIVE_PREFIX: Readonly<Record<ProviderKey, string>> = {
  aws: "aws",
  gcp: "gcp",
  azure: "azure",
  oci: "oci",
  kubernetes: "k8s",
  zenith: "k8s",
  sandbox: "sandbox",
  localstack: "localstack",
};

export type NativeTypeTable = Readonly<Record<ProviderKey, Readonly<Partial<Record<PortableKind, string>>>>>;

const KUBERNETES: Partial<Record<PortableKind, string>> = {
  network: "k8s:Namespace",
  kubernetes_namespace: "k8s:Namespace",
  firewall: "k8s:NetworkPolicy",
  load_balancer: "k8s:Ingress",
  dns_record: "k8s:DNSEndpoint",
  tls_certificate: "k8s:Certificate",
  container_service: "k8s:Deployment",
  static_site: "k8s:Deployment",
  scheduled_job: "k8s:CronJob",
  postgres: "k8s:StatefulSet",
  mysql: "k8s:StatefulSet",
  redis: "k8s:StatefulSet",
  secret: "k8s:Secret",
  identity: "k8s:ServiceAccount",
  volume: "k8s:PersistentVolumeClaim",
};

/** LocalStack: only what its emulation is documented to cover. The rest is unsupported, not faked. */
const LOCALSTACK: Partial<Record<PortableKind, string>> = {
  network: "localstack:vpc",
  subnet: "localstack:subnet",
  firewall: "localstack:security_group_rule",
  dns_zone: "localstack:route53_zone",
  dns_record: "localstack:route53_record",
  tls_certificate: "localstack:acm_certificate",
  object_store: "localstack:s3_bucket",
  queue: "localstack:sqs_queue",
  pubsub: "localstack:sns_topic",
  secret: "localstack:secretsmanager_secret",
  identity: "localstack:iam_role",
  log_group: "localstack:cloudwatch_log_group",
};

export const NATIVE_TYPE_TABLE: NativeTypeTable = {
  aws: {
    network: "aws:vpc",
    subnet: "aws:subnet",
    firewall: "aws:security_group_rule",
    load_balancer: "aws:alb",
    dns_zone: "aws:route53_zone",
    dns_record: "aws:route53_record",
    tls_certificate: "aws:acm_certificate",
    container_service: "aws:ecs_service",
    container_registry: "aws:ecr_repository",
    compute_instance: "aws:ec2_instance",
    function: "aws:lambda_function",
    static_site: "aws:s3_static_site",
    scheduled_job: "aws:ecs_scheduled_task",
    postgres: "aws:rds_instance",
    mysql: "aws:rds_instance",
    redis: "aws:elasticache_replication_group",
    object_store: "aws:s3_bucket",
    queue: "aws:sqs_queue",
    pubsub: "aws:sns_topic",
    secret: "aws:secretsmanager_secret",
    identity: "aws:iam_role",
    log_group: "aws:cloudwatch_log_group",
    kubernetes_cluster: "aws:eks_cluster",
    volume: "aws:ebs_volume",
    build_pipeline: "aws:codebuild_project",
  },
  gcp: {
    network: "gcp:vpc_network",
    subnet: "gcp:subnetwork",
    firewall: "gcp:firewall_rule",
    load_balancer: "gcp:global_http_lb",
    dns_zone: "gcp:dns_managed_zone",
    dns_record: "gcp:dns_record_set",
    tls_certificate: "gcp:managed_ssl_certificate",
    container_service: "gcp:cloud_run_service",
    container_registry: "gcp:artifact_registry_repository",
    compute_instance: "gcp:compute_instance",
    function: "gcp:cloud_function",
    static_site: "gcp:gcs_static_site",
    scheduled_job: "gcp:cloud_run_job",
    postgres: "gcp:cloud_sql_instance",
    mysql: "gcp:cloud_sql_instance",
    redis: "gcp:memorystore_instance",
    object_store: "gcp:storage_bucket",
    queue: "gcp:pubsub_topic",
    pubsub: "gcp:pubsub_topic",
    secret: "gcp:secret_manager_secret",
    identity: "gcp:service_account",
    log_group: "gcp:log_bucket",
    kubernetes_cluster: "gcp:gke_cluster",
    volume: "gcp:persistent_disk",
    build_pipeline: "gcp:cloud_build_trigger",
  },
  azure: {
    network: "azure:virtual_network",
    subnet: "azure:subnet",
    firewall: "azure:network_security_rule",
    load_balancer: "azure:application_gateway",
    dns_zone: "azure:dns_zone",
    dns_record: "azure:dns_record_set",
    tls_certificate: "azure:managed_certificate",
    container_service: "azure:container_app",
    container_registry: "azure:container_registry",
    compute_instance: "azure:virtual_machine",
    function: "azure:function_app",
    static_site: "azure:static_web_app",
    scheduled_job: "azure:container_app_job",
    postgres: "azure:postgresql_flexible_server",
    mysql: "azure:mysql_flexible_server",
    redis: "azure:redis_cache",
    object_store: "azure:storage_container",
    queue: "azure:service_bus_queue",
    pubsub: "azure:service_bus_topic",
    secret: "azure:key_vault_secret",
    identity: "azure:user_assigned_identity",
    log_group: "azure:log_analytics_workspace",
    kubernetes_cluster: "azure:aks_cluster",
    volume: "azure:managed_disk",
    build_pipeline: "azure:acr_task",
  },
  oci: {
    network: "oci:vcn",
    subnet: "oci:subnet",
    firewall: "oci:security_list_rule",
    load_balancer: "oci:load_balancer",
    dns_zone: "oci:dns_zone",
    dns_record: "oci:dns_rrset",
    tls_certificate: "oci:certificate",
    container_service: "oci:container_instance",
    container_registry: "oci:container_repository",
    compute_instance: "oci:compute_instance",
    postgres: "oci:postgresql_db_system",
    mysql: "oci:mysql_db_system",
    redis: "oci:redis_cluster",
    object_store: "oci:object_storage_bucket",
    queue: "oci:queue",
    secret: "oci:vault_secret",
    identity: "oci:dynamic_group",
    log_group: "oci:log_group",
    kubernetes_cluster: "oci:oke_cluster",
    volume: "oci:block_volume",
  },
  kubernetes: KUBERNETES,
  zenith: KUBERNETES,
  sandbox: Object.fromEntries(PORTABLE_KINDS.map((k) => [k, `sandbox:${k}`])) as Partial<Record<PortableKind, string>>,
  localstack: LOCALSTACK,
};

/** The native type realizing `kind` on `provider`, or `undefined` if no row exists. */
export function nativeTypeFor(provider: ProviderKey, kind: PortableKind): string | undefined {
  return NATIVE_TYPE_TABLE[provider]?.[kind];
}

/** What a node with no mapping carries; it is visibly not realizable, never blank. */
export function unsupportedNativeType(provider: ProviderKey, kind: PortableKind | "provider_native"): string {
  return `unsupported:${provider}:${kind}`;
}

export function isUnsupportedNativeType(nativeType: string): boolean {
  return nativeType.startsWith("unsupported:");
}

/**
 * Resolve a mapping, falling back to the visible `unsupported:` form.
 * `supported` is false exactly when the fallback was used.
 */
export function resolveNativeType(
  provider: ProviderKey,
  kind: PortableKind
): { nativeType: string; supported: boolean } {
  const nativeType = nativeTypeFor(provider, kind);
  return nativeType === undefined
    ? { nativeType: unsupportedNativeType(provider, kind), supported: false }
    : { nativeType, supported: true };
}

/**
 * Reverse lookup. Several kinds can share a native type (`aws:rds_instance`
 * realizes both postgres and mysql), so this returns every match, sorted;
 * the driver disambiguates from `spec.engine`.
 */
export function kindsForNativeType(provider: ProviderKey, nativeType: string): PortableKind[] {
  const row = NATIVE_TYPE_TABLE[provider] ?? {};
  return PORTABLE_KINDS.filter((k) => row[k] === nativeType).sort();
}
