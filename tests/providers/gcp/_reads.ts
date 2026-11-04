/**
 * Table of read-side cases: for each driver, the node, the GET endpoint the
 * driver must use, a response shaped like Google's REST reference that agrees
 * with the node's desired attributes, and a mutation that makes it drift.
 * Shared by read.test.ts and the canary tests.
 */
import type { DriverContext } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { gcpLabels, tagDescription } from "@/lib/providers/gcp/naming";
import type { ResourceNode } from "@/lib/resources/types";
import type { FakeGoogle } from "./_fake-google";
import { CONNECTION } from "./_fake-google";
import { DIGEST, IMAGE, PROJECT, REGION, TAGS, environmentNodes } from "./_fixtures";

export type Json = Record<string, unknown>;

export const NOW = new Date("2026-09-30T12:00:00.000Z");
export const PLAIN_ENV_CANARY = "SECRET-CANARY-plain-env-value-7f3a";
export const SQL_IP_CANARY = "10.77.88.99";

export function ctxFor(session: GcpSession, over: Partial<DriverContext<GcpSession>> = {}): DriverContext<GcpSession> {
  return {
    provider: "gcp",
    region: REGION,
    workspaceId: "ws_1",
    environmentId: "env_1",
    operationId: "op_abc123",
    session,
    signal: new AbortController().signal,
    log: () => undefined,
    tags: { ...TAGS },
    now: () => NOW,
    ...over,
  };
}

export const node = (address: string): ResourceNode => environmentNodes().find((n) => n.address === address)!;
export const labelsFor = (address: string): Record<string, string> => gcpLabels({ ...TAGS, "zenith:resource": address });
export const descriptionFor = (address: string): string => tagDescription({ ...TAGS }, { address }, "x");
const decoyLabels = (address: string): Record<string, string> => ({ ...labelsFor(address), zenith_environment: "env_other" });

export interface ReadCase {
  name: string;
  address: string;
  /** canonical externalId the driver reports */
  externalId: string;
  /** `host/path` GET endpoint used when an externalId is given */
  get: string;
  /** list endpoint used for tag search, and its items key */
  list?: { key: string; path: string; decoyIsTagged: boolean };
  body: Json;
  decoy?: Json;
  /** makes the object drift from the desired attributes; the named check must then fail */
  mutate: { body: Json; failsAttr: string };
  /** a response body for a different project's object */
  otherProjectId: string;
  hasRuntime: boolean;
  /** additional routes a present read needs (host/path → body) */
  extra?: Record<string, Json>;
}

const P = PROJECT;
const computeSelf = (path: string) => `https://www.googleapis.com/compute/v1/${path}`;

export function readCases(): ReadCase[] {
  const web = node("service/web");
  void web;
  return [
    {
      name: "vpc_network",
      address: "network/main",
      externalId: `projects/${P}/global/networks/zn-env1-main`,
      get: `compute.googleapis.com/compute/v1/projects/${P}/global/networks/zn-env1-main`,
      list: { key: "items", path: `compute.googleapis.com/compute/v1/projects/${P}/global/networks`, decoyIsTagged: true },
      body: { name: "zn-env1-main", selfLink: computeSelf(`projects/${P}/global/networks/zn-env1-main`), autoCreateSubnetworks: false, routingConfig: { routingMode: "REGIONAL" }, description: descriptionFor("network/main") },
      decoy: { name: "other", selfLink: computeSelf(`projects/${P}/global/networks/other`), description: `Managed by Zenith. zenith_environment=env_other; zenith_resource=network_main` },
      mutate: { body: { routingConfig: { routingMode: "GLOBAL" } }, failsAttr: "routingMode" },
      otherProjectId: `projects/other-project-99999/global/networks/zn-env1-main`,
      hasRuntime: false,
    },
    {
      name: "subnetwork",
      address: "subnet/private-a",
      externalId: `projects/${P}/regions/${REGION}/subnetworks/zn-env1-private-a`,
      get: `compute.googleapis.com/compute/v1/projects/${P}/regions/${REGION}/subnetworks/zn-env1-private-a`,
      list: { key: "items", path: `compute.googleapis.com/compute/v1/projects/${P}/regions/${REGION}/subnetworks`, decoyIsTagged: true },
      body: { name: "zn-env1-private-a", selfLink: computeSelf(`projects/${P}/regions/${REGION}/subnetworks/zn-env1-private-a`), ipCidrRange: "10.20.1.0/24", privateIpGoogleAccess: true, description: descriptionFor("subnet/private-a") },
      decoy: { name: "x", selfLink: computeSelf(`projects/${P}/regions/${REGION}/subnetworks/x`), description: `Managed by Zenith. zenith_environment=env_other; zenith_resource=subnet_private-a` },
      mutate: { body: { privateIpGoogleAccess: false }, failsAttr: "privateIpGoogleAccess" },
      otherProjectId: `projects/other-project-99999/regions/${REGION}/subnetworks/zn-env1-private-a`,
      hasRuntime: false,
    },
    {
      name: "firewall_rule",
      address: "firewall/web-to-db",
      externalId: `projects/${P}/global/firewalls/zn-env1-web-to-db`,
      get: `compute.googleapis.com/compute/v1/projects/${P}/global/firewalls/zn-env1-web-to-db`,
      list: { key: "items", path: `compute.googleapis.com/compute/v1/projects/${P}/global/firewalls`, decoyIsTagged: true },
      body: { name: "zn-env1-web-to-db", selfLink: computeSelf(`projects/${P}/global/firewalls/zn-env1-web-to-db`), direction: "EGRESS", priority: 1000, allowed: [{ IPProtocol: "tcp", ports: ["5432"] }], description: descriptionFor("firewall/web-to-db") },
      decoy: { name: "y", selfLink: computeSelf(`projects/${P}/global/firewalls/y`), allowed: [{ IPProtocol: "tcp", ports: ["22"] }], description: `Managed by Zenith. zenith_environment=env_other; zenith_resource=firewall_web-to-db` },
      mutate: { body: { allowed: [{ IPProtocol: "tcp", ports: ["5432", "22"] }] }, failsAttr: "port" },
      otherProjectId: `projects/other-project-99999/global/firewalls/zn-env1-web-to-db`,
      hasRuntime: false,
    },
    {
      name: "cloud_run_service",
      address: "service/web",
      externalId: `projects/${P}/locations/${REGION}/services/zn-env1-web`,
      get: `run.googleapis.com/v2/projects/${P}/locations/${REGION}/services/zn-env1-web`,
      list: { key: "services", path: `run.googleapis.com/v2/projects/${P}/locations/${REGION}/services`, decoyIsTagged: true },
      body: {
        name: `projects/${P}/locations/${REGION}/services/zn-env1-web`,
        uri: "https://zn-env1-web-abc-el.a.run.app",
        labels: labelsFor("service/web"),
        ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
        generation: "4",
        observedGeneration: "4",
        etag: '"etag-1"',
        template: {
          serviceAccount: `zn-env1-web@${P}.iam.gserviceaccount.com`,
          scaling: { minInstanceCount: 2, maxInstanceCount: 10 },
          vpcAccess: { egress: "PRIVATE_RANGES_ONLY" },
          containers: [
            {
              image: IMAGE,
              ports: [{ containerPort: 3000 }],
              resources: { limits: { cpu: "1", memory: "512Mi" } },
              env: [
                { name: "NODE_ENV", value: PLAIN_ENV_CANARY },
                { name: "API_KEY", valueSource: { secretKeyRef: { secret: `projects/${P}/secrets/zn-env1-api-key`, version: "latest" } } },
                { name: "GREETING", value: PLAIN_ENV_CANARY },
              ],
            },
          ],
        },
        terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" },
        conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }],
        latestReadyRevision: `projects/${P}/locations/${REGION}/services/zn-env1-web/revisions/zn-env1-web-00004`,
        latestCreatedRevision: `projects/${P}/locations/${REGION}/services/zn-env1-web/revisions/zn-env1-web-00004`,
      },
      decoy: { name: `projects/${P}/locations/${REGION}/services/other`, labels: decoyLabels("service/web") },
      mutate: { body: { template: { scaling: { minInstanceCount: 7, maxInstanceCount: 10 }, containers: [{ image: IMAGE, ports: [{ containerPort: 3000 }], resources: { limits: { cpu: "1", memory: "512Mi" } }, env: [{ name: "NODE_ENV", value: "x" }, { name: "API_KEY" }, { name: "GREETING", value: "x" }] }] } }, failsAttr: "minInstances" },
      otherProjectId: `projects/other-project-99999/locations/${REGION}/services/zn-env1-web`,
      hasRuntime: true,
    },
    {
      name: "cloud_run_job",
      address: "job/nightly",
      externalId: `projects/${P}/locations/${REGION}/jobs/zn-env1-nightly`,
      get: `run.googleapis.com/v2/projects/${P}/locations/${REGION}/jobs/zn-env1-nightly`,
      list: { key: "jobs", path: `run.googleapis.com/v2/projects/${P}/locations/${REGION}/jobs`, decoyIsTagged: true },
      body: {
        name: `projects/${P}/locations/${REGION}/jobs/zn-env1-nightly`,
        labels: labelsFor("job/nightly"),
        generation: "2",
        executionCount: 5,
        template: { template: { maxRetries: 1, timeout: "600s", containers: [{ image: IMAGE, resources: { limits: { cpu: "1", memory: "512Mi" } }, env: [{ name: "MODE", value: PLAIN_ENV_CANARY }] }] } },
        terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" },
        latestCreatedExecution: { name: `projects/${P}/locations/${REGION}/jobs/zn-env1-nightly/executions/e1`, createTime: "2026-09-30T03:00:00Z", completionTime: "2026-09-30T03:05:00Z" },
      },
      decoy: { name: `projects/${P}/locations/${REGION}/jobs/other`, labels: decoyLabels("job/nightly") },
      mutate: { body: { template: { template: { containers: [{ image: `${IMAGE}x`, resources: { limits: { cpu: "1", memory: "512Mi" } }, env: [{ name: "MODE" }] }] } } }, failsAttr: "image" },
      otherProjectId: `projects/other-project-99999/locations/${REGION}/jobs/zn-env1-nightly`,
      hasRuntime: true,
      extra: {
        [`cloudscheduler.googleapis.com/v1/projects/${P}/locations/${REGION}/jobs`]: { jobs: [{ name: "x", schedule: "0 3 * * *", description: descriptionFor("job/nightly") }] },
      },
    },
    {
      name: "cloud_sql_instance",
      address: "resource/db",
      externalId: `projects/${P}/instances/zn-env1-db-pg`,
      get: `sqladmin.googleapis.com/v1/projects/${P}/instances/zn-env1-db-pg`,
      list: { key: "items", path: `sqladmin.googleapis.com/v1/projects/${P}/instances`, decoyIsTagged: true },
      body: {
        name: "zn-env1-db-pg",
        project: P,
        region: REGION,
        databaseVersion: "POSTGRES_16",
        state: "RUNNABLE",
        connectionName: `${P}:${REGION}:zn-env1-db-pg`,
        ipAddresses: [{ type: "PRIVATE", ipAddress: SQL_IP_CANARY }],
        settings: {
          tier: "db-custom-1-3840",
          availabilityType: "REGIONAL",
          activationPolicy: "ALWAYS",
          dataDiskSizeGb: "20",
          deletionProtectionEnabled: true,
          ipConfiguration: { ipv4Enabled: false, sslMode: "ENCRYPTED_ONLY", privateNetwork: `projects/${P}/global/networks/zn-env1-main` },
          databaseFlags: [{ name: "cloudsql.iam_authentication", value: "on" }],
          backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true },
          userLabels: labelsFor("resource/db"),
        },
      },
      decoy: { name: "other-db", settings: { userLabels: decoyLabels("resource/db") } },
      mutate: { body: { settings: { tier: "db-custom-1-3840", availabilityType: "REGIONAL", deletionProtectionEnabled: true, ipConfiguration: { ipv4Enabled: true, sslMode: "ENCRYPTED_ONLY" }, databaseFlags: [{ name: "cloudsql.iam_authentication", value: "on" }], backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true }, userLabels: labelsFor("resource/db") } }, failsAttr: "publicIp" },
      otherProjectId: `projects/other-project-99999/instances/zn-env1-db-pg`,
      hasRuntime: true,
    },
    {
      name: "memorystore_instance",
      address: "resource/cache",
      externalId: `projects/${P}/locations/${REGION}/instances/zn-env1-cache-redis`,
      get: `redis.googleapis.com/v1/projects/${P}/locations/${REGION}/instances/zn-env1-cache-redis`,
      list: { key: "instances", path: `redis.googleapis.com/v1/projects/${P}/locations/${REGION}/instances`, decoyIsTagged: true },
      body: {
        name: `projects/${P}/locations/${REGION}/instances/zn-env1-cache-redis`,
        state: "READY",
        host: "10.2.3.4",
        port: 6378,
        tier: "BASIC",
        memorySizeGb: 2,
        redisVersion: "REDIS_7_2",
        transitEncryptionMode: "SERVER_AUTHENTICATION",
        connectMode: "PRIVATE_SERVICE_ACCESS",
        persistenceConfig: { persistenceMode: "RDB", rdbSnapshotPeriod: "TWENTY_FOUR_HOURS" },
        labels: labelsFor("resource/cache"),
      },
      decoy: { name: `projects/${P}/locations/${REGION}/instances/other`, labels: decoyLabels("resource/cache") },
      mutate: { body: { authEnabled: true }, failsAttr: "authEnabled" },
      otherProjectId: `projects/other-project-99999/locations/${REGION}/instances/zn-env1-cache-redis`,
      hasRuntime: true,
    },
    {
      name: "storage_bucket",
      address: "resource/uploads",
      externalId: "zn-env1-uploads-932ea9",
      get: "storage.googleapis.com/storage/v1/b/zn-env1-uploads-932ea9",
      list: { key: "items", path: "storage.googleapis.com/storage/v1/b", decoyIsTagged: true },
      body: {
        name: "zn-env1-uploads-932ea9",
        location: "ASIA-SOUTH1",
        storageClass: "STANDARD",
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
        versioning: { enabled: true },
        softDeletePolicy: { retentionDurationSeconds: "604800" },
        labels: labelsFor("resource/uploads"),
      },
      decoy: { name: "other-bucket", labels: decoyLabels("resource/uploads") },
      mutate: { body: { iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "inherited" } }, failsAttr: "publicAccessPrevention" },
      otherProjectId: "BAD_BUCKET_NAME!",
      hasRuntime: false,
    },
    {
      name: "pubsub_topic",
      address: "resource/jobs",
      externalId: `projects/${P}/topics/zn-env1-jobs`,
      get: `pubsub.googleapis.com/v1/projects/${P}/topics/zn-env1-jobs`,
      list: { key: "topics", path: `pubsub.googleapis.com/v1/projects/${P}/topics`, decoyIsTagged: true },
      body: { name: `projects/${P}/topics/zn-env1-jobs`, labels: labelsFor("resource/jobs") },
      decoy: { name: `projects/${P}/topics/other`, labels: decoyLabels("resource/jobs") },
      mutate: { body: { kmsKeyName: "projects/x/locations/y/keyRings/z/cryptoKeys/k" }, failsAttr: "encryption" },
      otherProjectId: `projects/other-project-99999/topics/zn-env1-jobs`,
      hasRuntime: false,
    },
    {
      name: "secret_manager_secret",
      address: "secret/api-key",
      externalId: `projects/${P}/secrets/zn-env1-api-key`,
      get: `secretmanager.googleapis.com/v1/projects/${P}/secrets/zn-env1-api-key`,
      list: { key: "secrets", path: `secretmanager.googleapis.com/v1/projects/${P}/secrets`, decoyIsTagged: true },
      body: { name: `projects/${P}/secrets/zn-env1-api-key`, replication: { userManaged: { replicas: [{ location: REGION }] } }, versionDestroyTtl: "2592000s", labels: labelsFor("secret/api-key"), createTime: "2026-09-01T00:00:00Z" },
      decoy: { name: `projects/${P}/secrets/other`, labels: decoyLabels("secret/api-key") },
      mutate: { body: { replication: { automatic: {} }, versionDestroyTtl: "2592000s" }, failsAttr: "replication" },
      otherProjectId: `projects/other-project-99999/secrets/zn-env1-api-key`,
      hasRuntime: false,
      extra: { [`secretmanager.googleapis.com/v1/projects/${P}/secrets/zn-env1-api-key/versions`]: { versions: [{ name: `projects/1/secrets/zn-env1-api-key/versions/1`, state: "ENABLED" }] } },
    },
    {
      name: "service_account",
      address: "identity/web",
      externalId: `projects/${P}/serviceAccounts/zn-env1-web@${P}.iam.gserviceaccount.com`,
      get: `iam.googleapis.com/v1/projects/${P}/serviceAccounts/zn-env1-web@${P}.iam.gserviceaccount.com`,
      list: { key: "accounts", path: `iam.googleapis.com/v1/projects/${P}/serviceAccounts`, decoyIsTagged: true },
      body: { email: `zn-env1-web@${P}.iam.gserviceaccount.com`, projectId: P, uniqueId: "1234567890", description: descriptionFor("identity/web") },
      decoy: { email: `other@${P}.iam.gserviceaccount.com`, projectId: P, description: `Managed by Zenith. zenith_environment=env_other; zenith_resource=identity_web` },
      mutate: { body: { disabled: true }, failsAttr: "disabled" },
      otherProjectId: `projects/other-project-99999/serviceAccounts/zn-env1-web@other-project-99999.iam.gserviceaccount.com`,
      hasRuntime: false,
    },
    {
      name: "artifact_registry_repository",
      address: "resource/registry",
      externalId: `projects/${P}/locations/${REGION}/repositories/zn-env1-registry`,
      get: `artifactregistry.googleapis.com/v1/projects/${P}/locations/${REGION}/repositories/zn-env1-registry`,
      list: { key: "repositories", path: `artifactregistry.googleapis.com/v1/projects/${P}/locations/${REGION}/repositories`, decoyIsTagged: true },
      body: { name: `projects/${P}/locations/${REGION}/repositories/zn-env1-registry`, format: "DOCKER", dockerConfig: {}, vulnerabilityScanningConfig: { enablementConfig: "INHERITED", enablementState: "SCANNING_ACTIVE" }, labels: labelsFor("resource/registry") },
      decoy: { name: `projects/${P}/locations/${REGION}/repositories/other`, labels: decoyLabels("resource/registry") },
      mutate: { body: { dockerConfig: { immutableTags: true } }, failsAttr: "immutableTags" },
      otherProjectId: `projects/other-project-99999/locations/${REGION}/repositories/zn-env1-registry`,
      hasRuntime: false,
    },
    {
      name: "cloud_build_trigger",
      address: "resource/pipeline",
      externalId: "zn-env1-pipeline-src-eb1f16",
      get: "storage.googleapis.com/storage/v1/b/zn-env1-pipeline-src-eb1f16",
      list: { key: "items", path: "storage.googleapis.com/storage/v1/b", decoyIsTagged: true },
      body: { name: "zn-env1-pipeline-src-eb1f16", location: "ASIA-SOUTH1", iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }, labels: labelsFor("resource/pipeline") },
      decoy: { name: "other-src", labels: decoyLabels("resource/pipeline") },
      mutate: { body: { iamConfiguration: { uniformBucketLevelAccess: { enabled: false }, publicAccessPrevention: "enforced" } }, failsAttr: "uniformBucketLevelAccess" },
      otherProjectId: "BAD_BUCKET_NAME!",
      hasRuntime: false,
    },
    {
      name: "managed_ssl_certificate",
      address: "tls_certificate/app.example.com",
      externalId: `projects/${P}/global/sslCertificates/zn-env1-app-example-com-dd46c9`,
      get: `compute.googleapis.com/compute/v1/projects/${P}/global/sslCertificates/zn-env1-app-example-com-dd46c9`,
      list: { key: "items", path: `compute.googleapis.com/compute/v1/projects/${P}/global/sslCertificates`, decoyIsTagged: true },
      body: {
        name: "zn-env1-app-example-com-dd46c9",
        selfLink: computeSelf(`projects/${P}/global/sslCertificates/zn-env1-app-example-com-dd46c9`),
        type: "MANAGED",
        managed: { domains: ["app.example.com"], status: "ACTIVE", domainStatus: { "app.example.com": "ACTIVE" } },
        description: descriptionFor("tls_certificate/app.example.com"),
      },
      decoy: { name: "x", selfLink: computeSelf(`projects/${P}/global/sslCertificates/x`), description: `Managed by Zenith. zenith_environment=env_other; zenith_resource=tls_certificate_app_example_com` },
      mutate: { body: { managed: { domains: ["evil.example.com"], status: "ACTIVE" } }, failsAttr: "domains" },
      otherProjectId: `projects/other-project-99999/global/sslCertificates/zn-env1-app-example-com-dd46c9`,
      hasRuntime: true,
    },
    {
      name: "dns_managed_zone",
      address: "dns_zone/example.com",
      externalId: `projects/${P}/managedZones/zn-env1-example-com`,
      get: `dns.googleapis.com/dns/v1/projects/${P}/managedZones/zn-env1-example-com`,
      list: { key: "managedZones", path: `dns.googleapis.com/dns/v1/projects/${P}/managedZones`, decoyIsTagged: true },
      body: { name: "zn-env1-example-com", dnsName: "example.com.", visibility: "public", nameServers: ["ns-1.example.", "ns-2.example."], labels: labelsFor("dns_zone/example.com") },
      decoy: { name: "other-zone", dnsName: "other.com.", labels: decoyLabels("dns_zone/example.com") },
      mutate: { body: { dnsName: "evil.com." }, failsAttr: "dnsName" },
      otherProjectId: `projects/other-project-99999/managedZones/zn-env1-example-com`,
      hasRuntime: false,
    },
    {
      name: "log_bucket",
      address: "log_group/web",
      externalId: `projects/${P}/locations/global/buckets/_Default`,
      get: `logging.googleapis.com/v2/projects/${P}/locations/global/buckets/_Default`,
      body: { name: `projects/${P}/locations/global/buckets/_Default`, retentionDays: 30, lifecycleState: "ACTIVE", locked: false },
      mutate: { body: { retentionDays: 7 }, failsAttr: "retention" },
      otherProjectId: `projects/other-project-99999/locations/global/buckets/_Default`,
      hasRuntime: false,
    },
  ];
}

/** Register the routes a present read of this case needs. */
export function serve(f: FakeGoogle, c: ReadCase, body: Json = c.body): void {
  f.get(c.get, { json: body });
  for (const [k, v] of Object.entries(c.extra ?? {})) f.get(k, { json: v });
  if (c.list) f.get(c.list.path, { json: { [c.list.key]: [...(c.decoy ? [c.decoy] : []), body] } });
}

export const _unused = { CONNECTION, DIGEST };
