/**
 * Shared test fixtures for the AWS data drivers: node builders, a name-based
 * `ctx.ref`, a driver context with a fake session (the SDK clients it builds are
 * mocked by `aws-sdk-client-mock`; nothing here reaches AWS), and the standard
 * graph (network, two private subnets, one of each data kind, an identity).
 */
import type { CompileContext, DriverContext, TofuFragment } from "@/lib/drivers/types";
import type { AwsClientCtor, AwsSession } from "@/lib/credentials/types";
import { nativeTypeFor } from "@/lib/resources/native-types";
import type { PortableKind, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { FragmentBuilder, refLocalName } from "@/lib/providers/aws/drivers/data/_shared";
import { awsDataDrivers } from "@/lib/providers/aws/drivers/data";

export const REGION = "ap-south-1";
export const ACCOUNT = "123456789012";
export const CTX_TAGS: Record<string, string> = { "zenith:workspace": "ws_test", "zenith:environment": "env_test", "zenith:managed": "true" };
export const NAME_PREFIX = "zen-prod";

export function mkNode(address: string, kind: PortableKind, spec: Record<string, unknown>, over: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address,
    kind,
    provider: "aws",
    region: REGION,
    nativeType: nativeTypeFor("aws", kind) ?? `unsupported:aws:${kind}`,
    ownership: "managed",
    spec,
    origin: [],
    dependsOn: [],
    specDigest: "0".repeat(64),
    labels: { "zenith:environment": "env_test", "zenith:managed": "true", "zenith:resource": address },
    ...over,
  };
}

/* --------------------------------- specs ---------------------------------- */

export const dataCommon = { size: "small", deletionPolicy: "approval", encryption: true } as const;

export const postgresSpec = (over: Record<string, unknown> = {}) => ({
  ...dataCommon,
  engine: "postgres",
  version: "16",
  highAvailability: false,
  backup: "daily",
  credentials: "generated",
  subnetTier: "private",
  zones: 2,
  ...over,
});

export const redisSpec = (over: Record<string, unknown> = {}) => ({ ...dataCommon, engine: "redis", highAvailability: false, backup: "daily", subnetTier: "private", zones: 2, ...over });
export const bucketSpec = (over: Record<string, unknown> = {}) => ({ ...dataCommon, versioning: true, publicAccess: false, ...over });
export const queueSpec = (over: Record<string, unknown> = {}) => ({ ...dataCommon, ...over });

/* -------------------------------- compile ctx ------------------------------ */

/** A `ctx.ref` the way the orchestrator resolves one for AWS drivers: the target publishes a tofu local per attribute. */
export function compileCtx(nodes: readonly ResourceNode[], over: Partial<CompileContext> = {}): CompileContext {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  return {
    environmentId: "env_test",
    namePrefix: NAME_PREFIX,
    region: REGION,
    tags: { ...CTX_TAGS },
    ref: (address, attribute) => `\${local.${refLocalName(address, attribute)}}`,
    node: (address) => byAddress.get(address),
    ...over,
  };
}

export const driverFor = (node: ResourceNode) => {
  const d = awsDataDrivers.find((x) => x.nativeType === node.nativeType);
  if (!d) throw new Error(`no data driver for ${node.nativeType}`);
  return d;
};

export function compileNode(node: ResourceNode, nodes: readonly ResourceNode[] = [node]): TofuFragment {
  return driverFor(node).compile!(node, compileCtx(nodes));
}

/* ---------------------------- network stub fragments ------------------------ */

/** The network group's fragments, reduced to what the data drivers reference: `id` of the network and of each subnet. */
export function networkStubs(): Map<string, TofuFragment> {
  const out = new Map<string, TofuFragment>();
  const vpc = new FragmentBuilder("network/main");
  vpc.resource("aws_vpc", "network_main", { cidr_block: "10.0.0.0/16" });
  vpc.expose("id", "aws_vpc.network_main.id");
  out.set("network/main", vpc.build());
  for (const [zone, az, cidr] of [
    ["a", "ap-south-1a", "10.0.10.0/24"],
    ["b", "ap-south-1b", "10.0.11.0/24"],
  ]) {
    const address = `subnet/private-${zone}`;
    const s = new FragmentBuilder(address);
    s.resource("aws_subnet", `subnet_private_${zone}`, { vpc_id: "${aws_vpc.network_main.id}", cidr_block: cidr, availability_zone: az });
    s.expose("id", `aws_subnet.subnet_private_${zone}.id`);
    out.set(address, s.build());
  }
  return out;
}

export const networkNodes = (): ResourceNode[] => [
  mkNode("network/main", "network", { cidr: "10.0.0.0/16", zones: 2 }),
  mkNode("subnet/private-a", "subnet", { tier: "private", zone: "a", cidr: "10.0.10.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
  mkNode("subnet/private-b", "subnet", { tier: "private", zone: "b", cidr: "10.0.11.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
];

const PRIVATE_SUBNETS = ["subnet/private-a", "subnet/private-b"];

/* ------------------------------ the standard graph ------------------------- */

export function standardNodes(): ResourceNode[] {
  const net = networkNodes();
  return [
    ...net,
    mkNode("postgres/db", "postgres", postgresSpec(), { dependsOn: PRIVATE_SUBNETS }),
    mkNode("redis/cache", "redis", redisSpec({ highAvailability: true }), { dependsOn: PRIVATE_SUBNETS }),
    mkNode("object_store/uploads", "object_store", bucketSpec()),
    mkNode("queue/jobs", "queue", queueSpec({ config: { visibilityTimeout: 60 } })),
    mkNode("secret/api-key-deadbeef", "secret", { secretRef: "vault:ws_test/API_KEY", store: "zenith_vault", purpose: "environment" }),
    mkNode("log_group/web", "log_group", { workload: "container_service/web", retentionDays: 30 }),
    mkNode("container_registry/web", "container_registry", { scanOnPush: true, immutableTags: false }),
    mkNode("container_service/web", "container_service", { workload: "web", size: "small", replicas: 1 }),
    mkNode(
      "identity/web",
      "identity",
      {
        principal: "workload",
        workload: "container_service/web",
        grants: [
          { target: "container_registry/web", access: ["pull"], via: ["image_pull"] },
          { target: "log_group/web", access: ["logs", "write"], via: ["own_log_group"] },
          { target: "object_store/uploads", access: ["delete", "list", "read", "write"], via: ["binding:blob"] },
          { target: "postgres/db", access: ["connect", "read_credentials"], via: ["binding:sql"] },
          { target: "queue/jobs", access: ["consume", "publish"], via: ["binding:queue"] },
          { target: "redis/cache", access: ["connect"], via: ["binding:cache"] },
          { target: "secret/api-key-deadbeef", access: ["read"], via: ["env:API_KEY"] },
        ],
      },
      { dependsOn: ["container_registry/web", "log_group/web", "object_store/uploads", "postgres/db", "queue/jobs", "redis/cache", "secret/api-key-deadbeef"] }
    ),
  ];
}

export const graphOf = (nodes: ResourceNode[]): ResourceGraph => ({
  version: 1,
  environmentId: "env_test",
  manifestDigest: "m".repeat(8),
  nodes,
  edges: [],
  graphDigest: "g".repeat(8),
  notes: [],
});

/** Every data driver's fragment plus the network stubs and an ECR stub, keyed by node address. */
export function standardFragments(nodes: readonly ResourceNode[] = standardNodes()): Map<string, TofuFragment> {
  const fragments = networkStubs();
  const ctx = compileCtx(nodes);
  for (const n of nodes) {
    if (fragments.has(n.address) || n.kind === "container_service" || n.kind === "network" || n.kind === "subnet") continue;
    if (n.kind === "container_registry") {
      const b = new FragmentBuilder(n.address);
      b.resource("aws_ecr_repository", "container_registry_web", { name: "zen-prod/web" });
      b.expose("arn", "aws_ecr_repository.container_registry_web.arn");
      fragments.set(n.address, b.build());
      continue;
    }
    fragments.set(n.address, driverFor(n).compile!(n, ctx));
  }
  return fragments;
}

/* ------------------------------ driver contexts ----------------------------- */

export function fakeSession(region = REGION): AwsSession {
  return {
    provider: "aws",
    accountId: ACCOUNT,
    region,
    expiresAt: "2099-01-01T00:00:00.000Z",
    transport: "direct",
    client: <C>(ctor: AwsClientCtor<C>, overrides?: { region?: string }): C => new ctor({ region: overrides?.region ?? region }),
    childProcessEnv: () => ({}),
  };
}

export interface LoggedLine {
  line: string;
  level?: string;
}

export function driverCtx(over: Partial<DriverContext<AwsSession>> = {}): DriverContext<AwsSession> & { logs: LoggedLine[] } {
  const logs: LoggedLine[] = [];
  return {
    provider: "aws",
    region: REGION,
    workspaceId: "ws_test",
    environmentId: "env_test",
    operationId: "op_test_1",
    session: fakeSession(),
    signal: new AbortController().signal,
    log: (line, level) => logs.push({ line, level }),
    tags: { ...CTX_TAGS },
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    logs,
    ...over,
  };
}

/** An SDK-shaped service error, as `aws-sdk-client-mock` `.rejects(...)` takes it. */
export function awsError(name: string, message = name, status?: number): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status, requestId: "req-1" } });
}

/** Tags of this node, in the provider's `Key`/`Value` list shape. */
export const tagList = (address: string, over: Record<string, string> = {}): { Key: string; Value: string }[] =>
  Object.entries({ ...CTX_TAGS, "zenith:resource": address, ...over }).map(([Key, Value]) => ({ Key, Value }));

export const tagRecord = (address: string, over: Record<string, string> = {}): Record<string, string> => ({ ...CTX_TAGS, "zenith:resource": address, ...over });
