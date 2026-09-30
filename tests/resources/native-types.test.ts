import { describe, expect, it } from "vitest";
import {
  expandManifest,
  isUnsupportedNativeType,
  kindsForNativeType,
  NATIVE_PREFIX,
  NATIVE_TYPE_TABLE,
  nativeTypeFor,
  PORTABLE_KINDS,
  resolveNativeType,
  unsupportedNativeType,
  type ExpandEnv,
  type ProviderKey,
} from "@/lib/resources";
import { PROD, graphProblems, randomManifests } from "./_fixtures";

const PROVIDERS = Object.keys(NATIVE_TYPE_TABLE) as ProviderKey[];

describe("native type table", () => {
  it("maps the AWS kinds exactly as the platform contract states", () => {
    expect(NATIVE_TYPE_TABLE.aws).toMatchObject({
      container_service: "aws:ecs_service",
      postgres: "aws:rds_instance",
      redis: "aws:elasticache_replication_group",
      object_store: "aws:s3_bucket",
      queue: "aws:sqs_queue",
      load_balancer: "aws:alb",
      dns_record: "aws:route53_record",
      tls_certificate: "aws:acm_certificate",
      network: "aws:vpc",
      subnet: "aws:subnet",
      firewall: "aws:security_group_rule",
      secret: "aws:secretsmanager_secret",
      identity: "aws:iam_role",
      log_group: "aws:cloudwatch_log_group",
      container_registry: "aws:ecr_repository",
      build_pipeline: "aws:codebuild_project",
      scheduled_job: "aws:ecs_scheduled_task",
      static_site: "aws:s3_static_site",
    });
    expect(nativeTypeFor("kubernetes", "container_service")).toBe("k8s:Deployment");
    expect(nativeTypeFor("zenith", "container_service")).toBe("k8s:Deployment");
    expect(nativeTypeFor("gcp", "container_service")).toBe("gcp:cloud_run_service");
    expect(nativeTypeFor("azure", "container_service")).toBe("azure:container_app");
  });

  it("uses only real portable kinds as keys and each provider's own prefix as values", () => {
    for (const provider of PROVIDERS) {
      for (const [kind, type] of Object.entries(NATIVE_TYPE_TABLE[provider])) {
        expect((PORTABLE_KINDS as readonly string[]).includes(kind), `${provider}.${kind}`).toBe(true);
        expect(type.startsWith(`${NATIVE_PREFIX[provider]}:`), `${provider}.${kind} → ${type}`).toBe(true);
        expect(type).toMatch(/^[a-z0-9]+:[A-Za-z][A-Za-z0-9_]*$/);
      }
    }
  });

  it("covers every kind expansion can produce on AWS, so nothing is unsupported there", () => {
    const produced = [
      "network", "subnet", "firewall", "load_balancer", "dns_zone", "dns_record", "tls_certificate",
      "container_service", "container_registry", "static_site", "scheduled_job", "postgres", "redis",
      "object_store", "queue", "secret", "identity", "log_group", "build_pipeline",
    ] as const;
    for (const k of produced) expect(nativeTypeFor("aws", k), k).toBeDefined();
  });

  it("marks a missing mapping visibly, never blank", () => {
    expect(nativeTypeFor("kubernetes", "object_store")).toBeUndefined();
    expect(resolveNativeType("kubernetes", "object_store")).toEqual({ nativeType: "unsupported:kubernetes:object_store", supported: false });
    expect(resolveNativeType("aws", "queue")).toEqual({ nativeType: "aws:sqs_queue", supported: true });
    expect(unsupportedNativeType("gcp", "provider_native")).toBe("unsupported:gcp:provider_native");
    expect(isUnsupportedNativeType("unsupported:oci:mysql")).toBe(true);
    expect(isUnsupportedNativeType("aws:vpc")).toBe(false);
  });

  it("reverse lookup returns every kind that shares a native type", () => {
    expect(kindsForNativeType("aws", "aws:rds_instance")).toEqual(["mysql", "postgres"]);
    expect(kindsForNativeType("aws", "aws:sqs_queue")).toEqual(["queue"]);
    expect(kindsForNativeType("aws", "aws:nothing")).toEqual([]);
    expect(kindsForNativeType("gcp", "gcp:pubsub_topic")).toEqual(["pubsub", "queue"]);
  });

  it("sandbox has its own row for every kind", () => {
    for (const k of PORTABLE_KINDS) expect(nativeTypeFor("sandbox", k)).toBe(`sandbox:${k}`);
  });
});

describe("expansion across providers and a random manifest population", () => {
  const envs: ExpandEnv[] = [
    { ...PROD, provider: "gcp", region: "us-central1" },
    { ...PROD, provider: "kubernetes", region: "kind" },
    { ...PROD, provider: "sandbox", region: "sim-1" },
    { ...PROD, provider: "localstack" },
  ];

  it("always produces a structurally valid graph, and every unsupported node is explained", () => {
    for (const [i, m] of randomManifests(80, 99).entries())
      for (const env of [PROD, ...envs]) {
        const g = expandManifest(m, env);
        expect(graphProblems(g), `manifest ${i} on ${env.provider}`).toEqual([]);
        for (const n of g.nodes.filter((x) => isUnsupportedNativeType(x.nativeType)))
          expect(g.notes.some((t) => t.startsWith("unsupported:") && t.includes(n.address)), `${env.provider}: ${n.address}`).toBe(true);
      }
  });
});
