/** Pure logical contracts. These fixtures do not prove cloud traffic or custody. */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import type { ProviderConnection } from "@/lib/credentials/types";
import { findGraphProblems } from "@/lib/execution/graph";
import {
  classifyMixedPlanChange, MIXED_PARTITION_LIMITS, MixedPartitionError, planMixedPartitions,
  type MixedPartitionErrorCode, type MixedPartitionInput, type MixedPartitionPlan,
  type PartitionBinding, type PartitionReference,
} from "@/lib/execution/mixed-partitions";
import { finalizeGraph, GraphBuilder, graphDigestOf, specDigestOf } from "@/lib/resources/expand-support";
import type { ResourceGraph } from "@/lib/resources/types";
import { backendForConnection } from "@/lib/tofu/backends";

const WS = "ws-mix";
const ENV = "env-mix";
const DB = "resource/db";
const WEB = "service/web";
const FN = "service/functions";
const ACCOUNT = "123456789012";
const SUB = "11111111-2222-3333-4444-555555555555";
const TENANT = "22222222-3333-4444-5555-666666666666";
const CLIENT = "33333333-4444-5555-6666-777777777777";
const H = (label: string): string => digest(label);

function connection(provider: "aws" | "gcp" | "azure"): ProviderConnection {
  const config: ProviderConnection["config"] = provider === "aws"
    ? { provider, mode: "oidc_web_identity", accountId: ACCOUNT, region: "us-east-1", observeRoleArn: `arn:aws:iam::${ACCOUNT}:role/observe`, deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/deploy`, stateBucket: "zenith-mix-aws" }
    : provider === "gcp"
      ? { provider, mode: "oidc_web_identity", projectId: "zenith-mix", region: "us-central1", workloadIdentityProvider: "projects/123456/locations/global/workloadIdentityPools/zenith/providers/zenith", observeServiceAccount: "observe@zenith-mix.iam.gserviceaccount.com", deployServiceAccount: "deploy@zenith-mix.iam.gserviceaccount.com", stateBucket: "zenith-mix-gcp" }
      : { provider, mode: "oidc_web_identity", subscriptionId: SUB, tenantId: TENANT, clientId: CLIENT, region: "eastus", stateStorageAccount: "zenithmixstate", stateContainer: "tofu-state" };
  return { id: `conn-${provider}`, workspaceId: WS, status: "verified", createdBy: "user-logical", createdAt: "2026-10-03T00:00:00Z", config };
}

function binding(provider: "aws" | "gcp" | "azure"): PartitionBinding {
  const conn = connection(provider);
  const state = backendForConnection(conn, { workspaceId: WS, environmentId: ENV });
  return { id: provider, connection: conn, region: provider === "aws" ? "us-east-1" : provider === "gcp" ? "us-central1" : "eastus",
    accountId: provider === "aws" ? ACCOUNT : provider === "gcp" ? "zenith-mix" : SUB, ...state };
}

function reference(id: string, producer: string, consumer: string): PartitionReference {
  return { id, scope: { workspaceId: WS, environmentId: ENV },
    producer: { address: producer, output: "endpoint", type: "endpoint" },
    consumer: { address: consumer, input: `endpoint_${id}`, type: "endpoint" },
    materialization: { state: "unavailable", reason: "not_produced" } };
}

function fixture(): MixedPartitionInput {
  const b = new GraphBuilder(ENV);
  b.add({ address: DB, kind: "postgres", place: { provider: "azure", region: "eastus" }, spec: { storageGb: 32 }, origin: ["db"] });
  b.add({ address: WEB, kind: "compute_instance", place: { provider: "gcp", region: "us-central1" }, spec: { machineType: "logical-compute", database: DB, fieldManagers: { replicas: "external-controller" } }, origin: ["web"], dependsOn: [DB] });
  b.add({ address: FN, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { sourceService: WEB }, origin: ["functions"], dependsOn: [WEB] });
  b.edge(WEB, DB, "connects_to");
  b.edge(FN, WEB, "connects_to");
  return { workspaceId: WS, graph: finalizeGraph(b, ENV, H("manifest-logical-mix")),
    bindings: [binding("aws"), binding("gcp"), binding("azure")],
    assignments: [{ address: WEB, bindingId: "gcp" }, { address: DB, bindingId: "azure" }, { address: FN, bindingId: "aws" }],
    references: [reference("db-host", DB, WEB), reference("web-host", WEB, FN)] };
}

function refresh(graph: ResourceGraph): void {
  graph.nodes.forEach((node) => { node.specDigest = specDigestOf(node); });
  graph.nodes.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  graph.edges.sort((a, b) => {
    const left = `${a.from}\0${a.to}\0${a.relation}\0${a.detail ?? ""}`;
    const right = `${b.from}\0${b.to}\0${b.relation}\0${b.detail ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  graph.graphDigest = graphDigestOf(graph.nodes, graph.edges);
}

function partitionFor(plan: MixedPartitionPlan, address: string) {
  return plan.partitions.find((partition) => partition.nodes.some((node) => node.address === address))!;
}

function materialize(input: MixedPartitionInput, id: string): void {
  const plan = planMixedPartitions(input);
  const ref = input.references.find((item) => item.id === id)!;
  const producer = partitionFor(plan, ref.producer.address);
  const consumer = partitionFor(plan, ref.consumer.address);
  const secret = ref.producer.type === "secret_ref"
    ? { ref: "vault:project/service/password", versionDigest: H("secret-version-1"), workspaceId: WS, environmentId: ENV, consumerConnectionId: consumer.identity.connectionId }
    : undefined;
  ref.materialization = { state: "available", valueDigest: secret ? digest({ ref: secret.ref, versionDigest: secret.versionDigest }) : H(`logical-output-${id}`),
    provenance: { workspaceId: WS, environmentId: ENV, connectionId: producer.identity.connectionId,
      provider: producer.identity.provider, accountId: producer.identity.accountId, region: producer.identity.region,
      producerAddress: ref.producer.address, producerSpecDigest: input.graph.nodes.find((node) => node.address === ref.producer.address)!.specDigest,
      producerSubplanDigest: producer.subplanDigest, producerEffectDigest: producer.effectDigest,
      receiptDigest: H(`completed-child-receipt-${id}`), artifactDigest: H(`verified-artifact-${id}`) },
    ...(secret ? { secret } : {}) };
}

function refusal(input: MixedPartitionInput, code: MixedPartitionErrorCode): void {
  let failure: unknown;
  try { planMixedPartitions(input); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(MixedPartitionError);
  expect((failure as MixedPartitionError).code).toBe(code);
  expect((failure as Error).message).not.toContain("canary-value");
}

function singleProvider(count: number): MixedPartitionInput {
  const b = new GraphBuilder(ENV);
  for (let index = 0; index < count; index++) b.add({ address: `resource/n${index}`, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: {}, origin: [] });
  return { workspaceId: WS, graph: finalizeGraph(b, ENV, H("single-logical")), bindings: [binding("aws")],
    assignments: [...b.nodes.keys()].map((address) => ({ address, bindingId: "aws" })), references: [] };
}

function gcsPair(): MixedPartitionInput {
  const input = singleProvider(2);
  const first = binding("gcp");
  first.backend = { kind: "gcs", bucket: "zenith-mix-gcp", prefix: `zenith/${WS}/${ENV}/child` };
  const second = binding("gcp"); second.id = "gcp-second"; second.connection.id = "conn-gcp-second";
  second.backend = { kind: "gcs", bucket: "zenith-mix-gcp", prefix: `zenith/${WS}/${ENV}/other-child` };
  second.stateKey = `zenith/${WS}/${ENV}/ignored-second.tfstate`;
  input.bindings = [first, second];
  input.assignments[0].bindingId = first.id; input.assignments[1].bindingId = second.id;
  for (const node of input.graph.nodes) {
    node.provider = "gcp"; node.region = "us-central1";
    node.kind = "compute_instance"; node.nativeType = "gcp:compute_instance";
  }
  refresh(input.graph);
  return input;
}

function ociFixture(): MixedPartitionInput {
  const input = singleProvider(1);
  const conn: ProviderConnection = { id: "conn-oci", workspaceId: WS, status: "verified", createdBy: "user-logical", createdAt: "2026-10-03T00:00:00Z",
    config: { provider: "oci", mode: "runner", tenancyOcid: "ocid1.tenancy.oc1..logical", compartmentOcid: "ocid1.compartment.oc1..logical", region: "us-phoenix-1", runnerId: "runner-oci", stateNamespace: "logicalnamespace", stateBucket: "zenith-mix-oci" } };
  input.bindings = [{ id: "oci", connection: conn, accountId: "ocid1.tenancy.oc1..logical", region: "us-phoenix-1", ...backendForConnection(conn, { workspaceId: WS, environmentId: ENV }) }];
  input.assignments[0].bindingId = "oci";
  input.graph.nodes[0].provider = "oci"; input.graph.nodes[0].region = "us-phoenix-1";
  input.graph.nodes[0].kind = "compute_instance"; input.graph.nodes[0].nativeType = "oci:compute_instance"; refresh(input.graph);
  return input;
}

function s3Pair(provider: "aws" | "oci"): MixedPartitionInput {
  const input = singleProvider(2);
  const first = provider === "aws" ? binding("aws") : ociFixture().bindings[0];
  first.stateKey = `zenith/${WS}/${ENV}/child.tfstate`;
  const second = structuredClone(first); second.id = `${provider}-second`; second.connection.id = `conn-${provider}-second`;
  second.stateKey = `zenith/${WS}/${ENV}/other-child.tfstate`;
  input.bindings = [first, second];
  input.assignments.forEach((item, index) => { item.bindingId = input.bindings[index].id; });
  if (provider === "oci") for (const node of input.graph.nodes) {
    node.provider = "oci"; node.region = "us-phoenix-1"; node.kind = "compute_instance"; node.nativeType = "oci:compute_instance";
  }
  refresh(input.graph); return input;
}

describe("bounded mixed-provider logical partitions", () => {
  it("orders Azure Postgres -> GCP compute -> AWS functions, with reverse teardown and stable addresses", () => {
    const input = fixture();
    const plan = planMixedPartitions(input);
    const providers = (ids: readonly string[]) => ids.map((id) => plan.partitions.find((partition) => partition.id === id)!.identity.provider);
    expect(providers(plan.executionOrder)).toEqual(["azure", "gcp", "aws"]);
    expect(providers(plan.teardownOrder)).toEqual(["aws", "gcp", "azure"]);
    expect(plan.partitions.flatMap((partition) => partition.nodes.map((node) => node.address)).sort()).toEqual([DB, FN, WEB].sort());
    for (const source of input.graph.nodes) {
      expect(partitionFor(plan, source.address).nodes.find((node) => node.address === source.address)).toMatchObject({
        ownership: source.ownership, specDigest: source.specDigest, sourceNodeDigest: digest(source), nativeType: source.nativeType,
      });
    }
    expect(partitionFor(plan, DB).blockedByReferences).toEqual([]);
    expect(partitionFor(plan, WEB).blockedByReferences).toEqual(["db-host"]);
    expect(partitionFor(plan, FN).blockedByReferences).toEqual(["db-host", "web-host"]);
    expect(plan.executionEnabled).toBe(false);
    expect(findGraphProblems(input.graph, "aws", () => undefined).filter((problem) => problem.includes("multi-provider graphs are not executable yet"))).toHaveLength(2);
  });

  it("is deterministic under input list permutations and snapshots without rewriting field ownership", () => {
    const input = fixture();
    const original = planMixedPartitions(input);
    input.bindings.reverse(); input.assignments.reverse(); input.references.reverse();
    input.graph.nodes.reverse(); input.graph.edges.reverse();
    expect(planMixedPartitions(input)).toEqual(original);
    input.graph.nodes.find((node) => node.address === WEB)!.spec.fieldManagers = { replicas: "different-controller" };
    expect(original.parentDigest).toBe(planMixedPartitions(fixture()).parentDigest);
    expect(JSON.stringify(original)).not.toContain("external-controller");
    expect(() => { (original.partitions[0].nodes[0] as { address: string }).address = "changed"; }).toThrow();
    expect(Object.isFrozen(original.partitions[0].identity)).toBe(true);
    expect(Object.isFrozen(original.executionOrder)).toBe(true);
  });

  it("keeps referenced and external ownership separate and never turns documentation into an output producer", () => {
    const input = singleProvider(2);
    input.graph.nodes[0].ownership = "referenced";
    input.graph.nodes[0].externalRef = "arn:aws:lambda:us-east-1:123456789012:function:existing";
    input.graph.nodes[1].ownership = "external";
    refresh(input.graph);
    expect(planMixedPartitions(input).partitions[0].nodes.map((node) => node.ownership).sort()).toEqual(["external", "referenced"]);
    const mixed = fixture(); mixed.graph.nodes.find((node) => node.address === DB)!.ownership = "external"; refresh(mixed.graph);
    refusal(mixed, "reference_contract");
  });

  it.each(["partial_failure", "timeout", "expired", "cancelled", "outage", "custody_unverified"] as const)("retains unknown materialization after %s and blocks downstream logical effects", (reason) => {
    const input = fixture(); input.references[0].materialization = { state: "unavailable", reason };
    const plan = planMixedPartitions(input);
    expect(plan.references[0]).toMatchObject({ state: "unavailable", unavailableReason: reason });
    expect(partitionFor(plan, FN).blockedByReferences).toContain("db-host");
    expect(plan.executionEnabled).toBe(false);
  });

  it("refuses missing/duplicate addresses, incomplete bindings, unused bindings and mismatched provider/region", () => {
    let input = fixture(); input.graph.nodes.push(input.graph.nodes[0]); refusal(input, "graph_integrity");
    input = fixture(); input.graph.nodes[0].nativeType = "aws:lambda_function"; refresh(input.graph); refusal(input, "graph_integrity");
    input = fixture(); input.assignments.pop(); refusal(input, "binding_mismatch");
    input = fixture(); input.assignments.push(input.assignments[0]); refusal(input, "binding_mismatch");
    input = fixture(); input.assignments[0].bindingId = "aws"; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].region = "us-west-2"; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].id = "unused"; input.assignments = input.assignments.filter((item) => item.address !== FN); refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].connection.workspaceId = "other-workspace"; refusal(input, "binding_mismatch");
  });

  it("refuses stale graph/spec digests and a dependency absent from the complete graph", () => {
    let input = fixture(); input.graph.nodes[0].spec.newField = "changed"; refusal(input, "graph_integrity");
    input = fixture(); input.graph.graphDigest = H("other-graph"); refusal(input, "graph_integrity");
    input = fixture(); input.graph.nodes[0].dependsOn.push("resource/missing"); refresh(input.graph); refusal(input, "graph_integrity");
  });

  it("refuses resource cycles and a partition cycle even when the individual resource graph is acyclic", () => {
    const input = fixture(); input.graph.nodes.find((node) => node.address === DB)!.dependsOn.push(FN); refresh(input.graph); refusal(input, "dependency_cycle");
    const partial = singleProvider(4);
    const other = binding("aws"); other.id = "second"; other.connection.id = "conn-second"; other.stateKey = `zenith/${WS}/${ENV}/second.tfstate`;
    partial.bindings.push(other);
    partial.assignments[1].bindingId = "second"; partial.assignments[3].bindingId = "second";
    partial.graph.nodes.find((node) => node.address === "resource/n0")!.dependsOn = ["resource/n1"];
    partial.graph.nodes.find((node) => node.address === "resource/n3")!.dependsOn = ["resource/n2"];
    refresh(partial.graph); refusal(partial, "dependency_cycle");
  });

  it("accepts explicit same-provider subplans with different state keys, but refuses actual state overlap", () => {
    const input = singleProvider(2);
    const second = binding("aws"); second.id = "second"; second.connection.id = "conn-second"; second.stateKey = `zenith/${WS}/${ENV}/second.tfstate`;
    input.bindings.push(second); input.assignments[1].bindingId = "second";
    expect(planMixedPartitions(input).partitions).toHaveLength(2);
    second.stateKey = input.bindings[0].stateKey; refusal(input, "state_overlap");
    // Changing encryption/config metadata cannot disguise the same state object.
    second.backend = { ...second.backend, region: "us-east-1", sseKmsKeyId: "alias/changed" } as PartitionBinding["backend"];
    refusal(input, "state_overlap");
  });

  it.each(["aws", "oci"] as const)("refuses a %s state object that is another partition's lock object in either binding order", provider => {
    const input = s3Pair(provider);
    expect(planMixedPartitions(input).partitions).toHaveLength(2);
    input.bindings[1].stateKey = `${input.bindings[0].stateKey}.tflock`;
    expect(input.bindings[0].connection.id).not.toBe(input.bindings[1].connection.id);
    refusal(input, "state_overlap");
    input.bindings.reverse(); refusal(input, "state_overlap");
  });

  it.each(["aws", "oci"] as const)("permits a %s binding's own literal .tflock state name with a distinct sibling lock", provider => {
    const input = s3Pair(provider); input.bindings[0].stateKey += ".tflock";
    const plan = planMixedPartitions(input);
    expect(plan.partitions).toHaveLength(2);
    for (const partition of plan.partitions) {
      expect(partition.identity.backendObjectDigests).toHaveLength(2);
      expect(new Set(partition.identity.backendObjectDigests).size).toBe(2);
      expect(partition.identity.backendObjectDigests).toContain(partition.identity.stateLocationDigest);
      expect(Object.isFrozen(partition.identity.backendObjectDigests)).toBe(true);
    }
    expect(plan.executionEnabled).toBe(false);
  });

  it.each(["connection/account", "region", "encryption"] as const)("cannot disguise an AWS state/lock collision by changing %s metadata", change => {
    const input = s3Pair("aws"), second = input.bindings[1], config = second.connection.config;
    if (config.provider !== "aws" || second.backend.kind !== "s3") throw new Error("fixture");
    second.stateKey = `${input.bindings[0].stateKey}.tflock`;
    if (change === "connection/account") {
      config.accountId = "999999999999"; second.accountId = config.accountId;
      config.observeRoleArn = `arn:aws:iam::${config.accountId}:role/observe`;
      config.deployRoleArn = `arn:aws:iam::${config.accountId}:role/deploy`;
    } else if (change === "region") {
      config.region = "us-west-2"; second.region = config.region; second.backend.region = config.region; input.graph.nodes[1].region = config.region;
    } else second.backend.sseKmsKeyId = "alias/different-encryption";
    refresh(input.graph); refusal(input, "state_overlap");
  });

  it("cannot disguise an OCI state/lock collision with a different claimed tenancy or compartment", () => {
    const input = s3Pair("oci"), second = input.bindings[1], config = second.connection.config;
    if (config.provider !== "oci") throw new Error("fixture");
    second.stateKey = `${input.bindings[0].stateKey}.tflock`;
    config.tenancyOcid = "ocid1.tenancy.oc1..another"; second.accountId = config.tenancyOcid;
    config.compartmentOcid = "ocid1.compartment.oc1..another";
    refusal(input, "state_overlap");
  });

  it.each(["cn-north-1", "us-gov-west-1"])("keeps the supported AWS partition's physical bucket namespace distinct for %s", region => {
    const input = s3Pair("aws"), second = input.bindings[1], config = second.connection.config;
    if (config.provider !== "aws" || second.backend.kind !== "s3") throw new Error("fixture");
    const partition = region.startsWith("cn-") ? "aws-cn" : "aws-us-gov";
    config.region = region; second.region = region; second.backend.region = region; input.graph.nodes[1].region = region;
    config.observeRoleArn = `arn:${partition}:iam::${ACCOUNT}:role/observe`;
    config.deployRoleArn = `arn:${partition}:iam::${ACCOUNT}:role/deploy`;
    second.stateKey = `${input.bindings[0].stateKey}.tflock`; refresh(input.graph);
    const plan = planMixedPartitions(input);
    expect(plan.partitions).toHaveLength(2);
    expect(new Set(plan.partitions.flatMap(child => child.identity.backendObjectDigests)).size).toBe(4);
    expect(plan.executionEnabled).toBe(false);
  });

  it("keeps distinct canonical OCI endpoint namespaces separate while pinning their state and lock objects", () => {
    const input = s3Pair("oci"), second = input.bindings[1], config = second.connection.config;
    if (config.provider !== "oci" || second.backend.kind !== "s3") throw new Error("fixture");
    config.stateNamespace = "anothernamespace";
    second.backend.endpoint = `https://${config.stateNamespace}.compat.objectstorage.${config.region}.oraclecloud.com`;
    second.stateKey = `${input.bindings[0].stateKey}.tflock`;
    expect(planMixedPartitions(input).partitions).toHaveLength(2);
  });

  it("keeps state and lock object collisions scoped to the physical backend family", () => {
    const input = fixture(), aws = input.bindings[0], gcp = input.bindings[1];
    if (aws.connection.config.provider !== "aws" || gcp.connection.config.provider !== "gcp" || aws.backend.kind !== "s3" || gcp.backend.kind !== "gcs") throw new Error("fixture");
    gcp.connection.config.stateBucket = aws.backend.bucket; gcp.backend.bucket = aws.backend.bucket;
    // Identical bucket and object spellings in different services are not the
    // same physical object. The GCS lock also is not its state plus .tflock.
    aws.stateKey = `${gcp.backend.prefix}/default.tflock`;
    const plan = planMixedPartitions(input);
    expect(plan.partitions).toHaveLength(3);
    expect(new Set(plan.partitions.flatMap(child => child.identity.backendObjectDigests)).size).toBe(5);
    const gcs = plan.partitions.find(child => child.identity.provider === "gcp")!;
    expect(gcs.identity.backendObjectDigests).toContain(digest({service:"gcs",bucket:gcp.backend.bucket,key:`${gcp.backend.prefix}/default.tflock`}));
    expect(gcs.identity.backendObjectDigests).not.toContain(digest({service:"gcs",bucket:gcp.backend.bucket,key:`${gcp.backend.prefix}/default.tfstate.tflock`}));
    expect(plan.executionEnabled).toBe(false);
  });

  it("deduplicates Azure's own state-blob lease without inventing an S3-style sibling lock", () => {
    const input = singleProvider(2), first = binding("azure"), second = binding("azure");
    second.id = "azure-second"; second.connection.id = "conn-azure-second";
    second.stateKey = `${first.stateKey}.tflock`;
    input.bindings = [first,second]; input.assignments.forEach((item,index)=>{item.bindingId=input.bindings[index].id;});
    for (const node of input.graph.nodes) { node.provider="azure";node.region="eastus";node.kind="postgres";node.nativeType="azure:postgres"; }
    refresh(input.graph); const plan = planMixedPartitions(input);
    expect(plan.partitions).toHaveLength(2);
    expect(plan.partitions.every(child=>child.identity.backendObjectDigests.length===1)).toBe(true);
    second.stateKey = first.stateKey; refusal(input,"state_overlap");
  });

  it("preserves literal S3 dot segments when checking derived lock-object overlap", () => {
    const input = s3Pair("aws"); input.bindings[0].stateKey=`zenith/${WS}/${ENV}/./child.tfstate`;
    input.bindings[1].stateKey=`zenith/${WS}/${ENV}/child.tfstate.tflock`;
    expect(planMixedPartitions(input).partitions).toHaveLength(2);
    input.bindings[1].stateKey=`${input.bindings[0].stateKey}.tflock`;refusal(input,"state_overlap");
  });

  it.each(["aws", "oci"] as const)("includes the derived %s lock suffix in the canonical 1024-byte object bound", provider => {
    const input=s3Pair(provider), prefix=`zenith/${WS}/${ENV}/`;
    input.bindings[0].stateKey=prefix+"a".repeat(1017-prefix.length);
    expect(planMixedPartitions(input).partitions).toHaveLength(2);
    input.bindings[0].stateKey+="a"; refusal(input,"binding_mismatch");
  });

  it("includes GCS's derived default state name in the canonical object bound", () => {
    const input=gcsPair(), backend=input.bindings[0].backend, prefix=`zenith/${WS}/${ENV}/`;
    if(backend.kind!=="gcs")throw new Error("fixture");
    backend.prefix=prefix+"a".repeat(1008-prefix.length);
    expect(planMixedPartitions(input).partitions).toHaveLength(2);
    backend.prefix+="a"; refusal(input,"binding_mismatch");
  });

  it("cannot use a cross-workspace lock-looking state key to evade binding scope", () => {
    const input=s3Pair("aws");input.bindings[1].stateKey="zenith/foreign/env-mix/child.tfstate.tflock";
    refusal(input,"binding_mismatch");
  });

  it("refuses account crossing, foreign backend ownership and AWS cloud partition mismatch", () => {
    let input = fixture(); input.bindings[0].accountId = "999999999999"; refusal(input, "binding_mismatch");
    input = fixture(); const aws = input.bindings[0].connection.config; if (aws.provider === "aws") aws.deployRoleArn = "arn:aws:iam::999999999999:role/deploy"; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].backend = { kind: "s3", bucket: "another-account-state" }; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[1].backend = { kind: "gcs", bucket: "another-project-state", prefix: `zenith/${WS}/${ENV}` }; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[2].backend = { kind: "azurerm", storageAccountName: "foreignstate", containerName: "tofu-state" }; refusal(input, "binding_mismatch");
    input = fixture(); const partition = input.bindings[0].connection.config; if (partition.provider === "aws") partition.observeRoleArn = `arn:aws-cn:iam::${ACCOUNT}:role/observe`; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].stateKey = "zenith/foreign/env/default.tfstate"; refusal(input, "binding_mismatch");
    input = fixture(); const gcp = input.bindings[1].connection.config; if (gcp.provider === "gcp") gcp.deployServiceAccount = "deploy@foreign-project.iam.gserviceaccount.com"; refusal(input, "binding_mismatch");
    input = fixture(); const encrypted = input.bindings[0].connection.config; if (encrypted.provider === "aws") encrypted.stateKmsKeyArn = `arn:aws:kms:us-east-1:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000`; refusal(input, "binding_mismatch");
  });

  it.each([
    [FN, "arn:aws:lambda:us-east-1:999999999999:function:foreign"],
    [FN, `arn:aws:lambda:us-west-2:${ACCOUNT}:function:wrong-region`],
    [WEB, "projects/foreign-project/zones/us-central1-a/instances/foreign"],
    [WEB, "https://www.googleapis.com/compute/v1/projects/zenith-mix/zones/us-west1-a/instances/wrong-region"],
    [DB, "/subscriptions/99999999-9999-9999-9999-999999999999/resourceGroups/foreign/providers/Microsoft.DBforPostgreSQL/flexibleServers/db"],
  ])("refuses a contradictory account-bearing external identity for %s", (address, externalRef) => {
    const input = fixture(); input.graph.nodes.find((node) => node.address === address)!.externalRef = externalRef;
    refresh(input.graph); refusal(input, "binding_mismatch");
  });

  it("retains the existing OCI runner backend profile as logical metadata, with no credential parameters", () => {
    const input = ociFixture();
    expect(planMixedPartitions(input).partitions[0].identity).toMatchObject({ provider: "oci", accountId: "ocid1.tenancy.oc1..logical", backendKind: "s3" });
    expect(planMixedPartitions(input).executionEnabled).toBe(false);
  });

  it.each([
    { label: "missing", endpointNamespace: "undefined" },
    { label: "number", namespace: 123, endpointNamespace: "123" },
    { label: "null", namespace: null, endpointNamespace: "null" },
    { label: "boolean", namespace: true, endpointNamespace: "true" },
    { label: "array", namespace: [123], endpointNamespace: "123" },
    { label: "empty", namespace: "", endpointNamespace: "" },
    { label: "uppercase", namespace: "LogicalNamespace", endpointNamespace: "LogicalNamespace" },
    { label: "punctuation", namespace: "logical_namespace", endpointNamespace: "logical_namespace" },
    { label: "overflow", namespace: "n".repeat(64), endpointNamespace: "n".repeat(64) },
  ])("refuses an OCI $label saved namespace even when its interpolated endpoint agrees", (testCase) => {
    const input = ociFixture();
    const config = input.bindings[0].connection.config as unknown as Record<string, unknown>;
    if ("namespace" in testCase) config.stateNamespace = testCase.namespace;
    else delete config.stateNamespace;
    const backend = input.bindings[0].backend;
    if (backend.kind !== "s3") throw new Error("fixture");
    backend.endpoint = `https://${testCase.endpointNamespace}.compat.objectstorage.us-phoenix-1.oraclecloud.com`;
    refusal(input, "binding_mismatch");
  });

  it.each(["n", "n".repeat(63)])("accepts a canonical OCI namespace at the string bounds: %s", (namespace) => {
    const input = ociFixture(); const config = input.bindings[0].connection.config;
    if (config.provider !== "oci" || input.bindings[0].backend.kind !== "s3") throw new Error("fixture");
    config.stateNamespace = namespace;
    input.bindings[0].backend.endpoint = `https://${namespace}.compat.objectstorage.us-phoenix-1.oraclecloud.com`;
    expect(planMixedPartitions(input).partitions[0].identity.provider).toBe("oci");
    expect(planMixedPartitions(input).executionEnabled).toBe(false);
  });

  it("detects GCS overlap using its actual prefix rather than an ignored stateKey", () => {
    const input = fixture();
    const second = binding("gcp"); second.id = "gcp-second"; second.connection.id = "conn-gcp-second";
    second.stateKey = `zenith/${WS}/${ENV}/ignored-other-key.tfstate`;
    input.bindings.push(second);
    refusal(input, "state_overlap");
  });

  it("refuses a GCS dot-segment alias of another partition's state and lock objects", () => {
    const input = gcsPair();
    const plan = planMixedPartitions(input);
    expect(plan.partitions).toHaveLength(2);
    expect(new Set(plan.partitions.map((partition) => partition.identity.stateLocationDigest)).size).toBe(2);
    const second = input.bindings[1];
    expect(second.connection.id).not.toBe(input.bindings[0].connection.id);
    expect(second.stateKey).not.toBe(input.bindings[0].stateKey);
    if (second.backend.kind !== "gcs") throw new Error("fixture");
    second.backend.prefix = `zenith/${WS}/${ENV}/./child`;
    refusal(input, "binding_mismatch");
    second.backend.prefix = `zenith/${WS}/${ENV}/child`;
    refusal(input, "state_overlap");
  });

  it.each(["./child", "child/.", "child/./nested"])("refuses GCS noncanonical effective prefix segments in %s, including the stateKey fallback", (suffix) => {
    const explicit = gcsPair();
    if (explicit.bindings[1].backend.kind !== "gcs") throw new Error("fixture");
    explicit.bindings[1].backend.prefix = `zenith/${WS}/${ENV}/${suffix}`;
    refusal(explicit, "binding_mismatch");

    const fallback = gcsPair();
    if (fallback.bindings[1].backend.kind !== "gcs") throw new Error("fixture");
    delete fallback.bindings[1].backend.prefix;
    fallback.bindings[1].stateKey = `zenith/${WS}/${ENV}/fallback-child`;
    expect(planMixedPartitions(fallback).partitions).toHaveLength(2);
    fallback.bindings[1].stateKey = `zenith/${WS}/${ENV}/${suffix}`;
    refusal(fallback, "binding_mismatch");
  });

  it.each(["child.v2", ".hidden"])("preserves a canonical GCS segment containing a literal period: %s", (segment) => {
    const input = gcsPair();
    if (input.bindings[1].backend.kind !== "gcs") throw new Error("fixture");
    input.bindings[1].backend.prefix = `zenith/${WS}/${ENV}/${segment}`;
    expect(planMixedPartitions(input).partitions).toHaveLength(2);
    expect(planMixedPartitions(input).executionEnabled).toBe(false);
  });

  it("keeps the GCS normalization restriction local to GCS rather than rewriting literal S3 keys", () => {
    const input = singleProvider(2);
    input.bindings[0].stateKey = `zenith/${WS}/${ENV}/child.tfstate`;
    const second = binding("aws"); second.id = "aws-second"; second.connection.id = "conn-aws-second";
    second.stateKey = `zenith/${WS}/${ENV}/./child.tfstate`;
    input.bindings.push(second); input.assignments[1].bindingId = second.id;
    const plan = planMixedPartitions(input);
    expect(plan.partitions).toHaveLength(2);
    expect(new Set(plan.partitions.map((partition) => partition.identity.stateLocationDigest)).size).toBe(2);
    expect(plan.executionEnabled).toBe(false);
  });

  it("does not treat a verified connection snapshot as current broker authorization", () => {
    const input = fixture();
    expect(planMixedPartitions(input).executionEnabled).toBe(false);
    input.bindings[0].connection.revokedAt = "2026-10-03T01:00:00Z"; refusal(input, "binding_mismatch");
    delete input.bindings[0].connection.revokedAt; input.bindings[0].connection.status = "pending_verification"; refusal(input, "binding_mismatch");
    input.bindings[0].connection.status = "verified";
    const cfg = input.bindings[0].connection.config; if (cfg.provider === "aws") cfg.mode = "static_dev";
    refusal(input, "binding_mismatch");
    const approved = fixture() as MixedPartitionInput & { approved: boolean }; approved.approved = true; refusal(approved, "invalid_input");
  });

  it("pins non-secret AWS role/boundary/session selectors and refuses a missing assume-role ExternalId", () => {
    const input = fixture(); const before = planMixedPartitions(input);
    const cfg = input.bindings[0].connection.config;
    if (cfg.provider !== "aws") throw new Error("fixture");
    cfg.codeBuildRoleArn = `arn:aws:iam::${ACCOUNT}:role/build`;
    cfg.bootstrapNameSuffix = "-mixed";
    cfg.sessionDurationSec = 900;
    expect(classifyMixedPlanChange(before, planMixedPartitions(input)).classification).toBe("review_required");
    cfg.mode = "aws_assume_role"; refusal(input, "binding_mismatch");
    cfg.externalId = "external-logical-id";
    expect(JSON.stringify(planMixedPartitions(input))).not.toContain("external-logical-id");
    cfg.secretWriterRoleArn = "arn:aws:iam::999999999999:role/writer"; refusal(input, "binding_mismatch");
  });

  it("requires typed, scoped references with direct declared dependencies and unique consumer fields", () => {
    let input = fixture(); input.references.pop(); refusal(input, "reference_contract");
    input = fixture(); input.references[0].scope.environmentId = "other-env"; refusal(input, "reference_contract");
    input = fixture(); input.references[0].consumer.type = "resource_id"; refusal(input, "reference_contract");
    input = fixture(); input.graph.nodes.find((node) => node.address === WEB)!.dependsOn = []; refresh(input.graph); refusal(input, "reference_contract");
    input = fixture(); input.references.push({ ...input.references[0], id: "duplicate-target" }); refusal(input, "reference_contract");
    input = fixture(); input.references.push({ ...input.references[0], id: "wrong-type", consumer: { ...input.references[0].consumer, input: "another_input", type: "string" }, producer: { ...input.references[0].producer, type: "string" } }); refusal(input, "reference_contract");
    input = fixture(); input.graph.edges.find((edge) => edge.from === WEB)!.relation = "reads_secret"; refresh(input.graph); refusal(input, "reference_contract");
  });

  it("materializes in dependency order while keeping immutable desired digests and requiring exact changed-effect review", () => {
    const input = fixture(); const before = planMixedPartitions(input);
    materialize(input, "db-host"); const partial = planMixedPartitions(input);
    expect(partial.desiredDigest).toBe(before.desiredDigest);
    expect(partial.partitions.map((partition) => partition.subplanDigest)).toEqual(before.partitions.map((partition) => partition.subplanDigest));
    expect(partitionFor(partial, WEB).blockedByReferences).toEqual([]);
    expect(partitionFor(partial, FN).blockedByReferences).toEqual(["web-host"]);
    expect(classifyMixedPlanChange(before, partial)).toMatchObject({ classification: "review_required", requiredParentDigest: partial.parentDigest, reasons: ["materialized_effects_changed", "output_custody_changed"] });
    expect(classifyMixedPlanChange(before, partial).affectedPartitionIds).toContain(partitionFor(partial, FN).id);
    materialize(input, "web-host"); const after = planMixedPartitions(input);
    expect(after.partitions.every((partition) => partition.blockedByReferences.length === 0)).toBe(true);
    expect(after.executionEnabled).toBe(false);
    expect(classifyMixedPlanChange(after, planMixedPartitions(input)).classification).toBe("unchanged");
    expect(() => classifyMixedPlanChange(JSON.parse(JSON.stringify(after)) as MixedPartitionPlan, after)).toThrow(MixedPartitionError);
  });

  it.each(["workspaceId", "environmentId", "connectionId", "provider", "accountId", "region", "producerAddress", "producerSpecDigest", "producerSubplanDigest", "producerEffectDigest", "receiptDigest", "artifactDigest"] as const)("refuses mismatched or missing provenance field %s", (field) => {
    const input = fixture(); materialize(input, "db-host");
    const value = input.references[0].materialization;
    if (value.state !== "available") throw new Error("fixture");
    (value.provenance as unknown as Record<string, unknown>)[field] = "mismatched";
    refusal(input, "provenance_mismatch");
    delete (value.provenance as unknown as Record<string, unknown>)[field];
    refusal(input, "invalid_input");
  });

  it("refuses a receipt from an earlier producer effect after an incoming artifact changes", () => {
    const input = fixture(); materialize(input, "db-host"); materialize(input, "web-host");
    const db = input.references[0].materialization;
    if (db.state !== "available") throw new Error("fixture");
    db.provenance.artifactDigest = H("replaced-upstream-artifact");
    refusal(input, "provenance_mismatch");
    input.references[1].materialization = { state: "unavailable", reason: "not_produced" };
    const pending = planMixedPartitions(input);
    expect(partitionFor(pending, FN).blockedByReferences).toEqual(["web-host"]);
  });

  it("rejects an available downstream output from a producer with unresolved partial dependencies", () => {
    const input = fixture();
    // The helper can describe metadata, but the planner refuses that producer.
    materialize(input, "web-host"); refusal(input, "provenance_mismatch");
  });

  it("requires reapproval on migration/backend/ownership/topology change rather than destructive compensation", () => {
    const input = fixture(); const before = planMixedPartitions(input);
    input.bindings[0].stateKey = `zenith/${WS}/${ENV}/migrated.tfstate`;
    const moved = planMixedPartitions(input);
    expect(classifyMixedPlanChange(before, moved).reasons).toContain("desired_inputs_changed");
    expect(partitionFor(moved, FN).nodes[0].address).toBe(FN);
    input.graph.nodes.find((node) => node.address === FN)!.ownership = "referenced";
    input.references = input.references.filter((ref) => ref.consumer.address !== FN);
    input.graph.edges = input.graph.edges.filter((edge) => edge.from !== FN);
    refresh(input.graph);
    expect(classifyMixedPlanChange(before, planMixedPartitions(input)).classification).toBe("review_required");
  });

  it("accepts scoped versioned secret references, pins pointer identity and never returns values or vault paths", () => {
    const input = fixture();
    input.references[0].producer.output = "password_ref"; input.references[0].producer.type = "secret_ref";
    input.references[0].consumer.input = "database_password_ref"; input.references[0].consumer.type = "secret_ref";
    materialize(input, "db-host"); const plan = planMixedPartitions(input);
    expect(plan.references[0].state).toBe("available");
    expect(JSON.stringify(plan)).not.toContain("vault:");
    const materialization = input.references[0].materialization;
    if (materialization.state !== "available" || !materialization.secret) throw new Error("fixture");
    materialization.secret.consumerConnectionId = "foreign-consumer"; refusal(input, "provenance_mismatch");
    materialization.secret.consumerConnectionId = "conn-gcp";
    materialization.valueDigest = H("hash-of-raw-password-is-not-a-pointer"); refusal(input, "provenance_mismatch");
  });

  it.each([
    { password: "canary-value" },
    { password: { value: "canary-value" } },
    { credentials: ["canary-value"] },
    { env: [{ key: "DATABASE_PASSWORD", value: "canary-value" }] },
    { url: "https://user:canary-value@example.invalid" },
    { url: "https://example.invalid?token=canary-value" },
    { arbitrary: "-----BEGIN PRIVATE KEY-----canary-value" },
  ])("refuses inline credential shapes without echoing data %#", (spec) => {
    const input = fixture(); input.graph.nodes[0].spec = spec; refresh(input.graph); refusal(input, "secret_data");
  });

  it("refuses raw output payloads, backend credential parameters and local/file state backends", () => {
    let input = fixture(); materialize(input, "db-host");
    (input.references[0].materialization as unknown as Record<string, unknown>).value = "canary-value"; refusal(input, "invalid_input");
    input = fixture(); (input.bindings[0].backend as unknown as Record<string, unknown>).access_key = "canary-value"; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].backend = { kind: "local", path: "/private/credential-canary-value" }; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].backend = { kind: "http", address: "https://canary-value@backend.invalid" }; refusal(input, "binding_mismatch");
    input = fixture(); input.bindings[0].connection.verificationDetail = "/private/canary-value";
    expect(JSON.stringify(planMixedPartitions(input))).not.toContain("canary-value");
  });

  it("rejects getters, cycles, prototypes, non-JSON primitives and unknown top-level contracts", () => {
    let input = fixture(); let calls = 0;
    Object.defineProperty(input.graph.nodes[0].spec, "getter", { enumerable: true, get: () => { calls++; return "canary-value"; } });
    refusal(input, "invalid_input"); expect(calls).toBe(0);
    input = fixture(); input.graph.nodes[0].spec = new Proxy({}, { ownKeys: () => { calls++; throw new Error("canary-value"); } });
    refusal(input, "invalid_input"); expect(calls).toBe(0);
    input = fixture(); input.graph.nodes[0].spec.self = input.graph.nodes[0].spec; refusal(input, "invalid_input");
    input = fixture(); input.graph.nodes[0].spec = Object.create({ inherited: "canary-value" }) as Record<string, unknown>; refusal(input, "invalid_input");
    for (const value of [undefined, BigInt(1), NaN, Infinity, () => "canary-value"]) {
      input = fixture(); input.graph.nodes[0].spec.bad = value; refusal(input, "invalid_input");
    }
  });
});

describe("exact mixed planning bounds", () => {
  it("accepts exactly 256 nodes and refuses the next node", () => {
    expect(planMixedPartitions(singleProvider(MIXED_PARTITION_LIMITS.nodes)).partitions[0].nodes).toHaveLength(256);
    refusal(singleProvider(MIXED_PARTITION_LIMITS.nodes + 1), "bounds");
  });

  it("accepts exactly 32 bindings and refuses the next binding", () => {
    const input = singleProvider(33); input.bindings = [];
    for (let i = 0; i < 32; i++) {
      const item = binding("aws"); item.id = `binding-${i}`; item.connection.id = `conn-${i}`;
      item.stateKey = `zenith/${WS}/${ENV}/partition-${i}.tfstate`; input.bindings.push(item); input.assignments[i].bindingId = item.id;
    }
    input.assignments[32].bindingId = "binding-0";
    expect(planMixedPartitions(input).partitions).toHaveLength(32);
    input.bindings.push(binding("aws")); refusal(input, "bounds");
  });

  it("accepts exactly 1024 incident edges without manufacturing dependency cycles, then refuses the next edge", () => {
    const input = singleProvider(256);
    input.graph.edges = Array.from({ length: 1024 }, (_, i) => ({ from: `resource/n${i % 256}`, to: `resource/n${(i % 256 + 1 + Math.floor(i / 256)) % 256}`, relation: "connects_to" }));
    refresh(input.graph); expect(planMixedPartitions(input).partitions).toHaveLength(1);
    input.graph.edges.push({ from: "resource/n0", to: "resource/n255", relation: "routes_to" }); refresh(input.graph); refusal(input, "bounds");
  });

  it("accepts exactly 512 declared references and refuses the next reference", () => {
    const input = fixture();
    input.references = Array.from({ length: 511 }, (_, i) => {
      const ref = reference(`ref-${i}`, DB, WEB); ref.producer.output = `output_${i}`; return ref;
    });
    input.references.push(reference("web-host", WEB, FN));
    expect(planMixedPartitions(input).references).toHaveLength(512);
    input.references.push(reference("too-many", DB, WEB)); refusal(input, "bounds");
  });

  it("accepts the depth/string/UTF-8 content budgets exactly and refuses one beyond each", () => {
    const nest = (depth: number): unknown => { let value: unknown = null; for (let i = 0; i < depth; i++) value = { item: value }; return value; };
    let input = singleProvider(1); input.graph.nodes[0].spec = { content: nest(MIXED_PARTITION_LIMITS.jsonDepth - 5) }; refresh(input.graph);
    expect(planMixedPartitions(input).partitions).toHaveLength(1);
    input.graph.nodes[0].spec = { content: nest(MIXED_PARTITION_LIMITS.jsonDepth - 4) }; refresh(input.graph); refusal(input, "bounds");
    input = singleProvider(1); input.graph.nodes[0].spec = { content: "x".repeat(MIXED_PARTITION_LIMITS.stringBytes) }; refresh(input.graph);
    expect(planMixedPartitions(input).partitions).toHaveLength(1);
    input.graph.nodes[0].spec.content = String(input.graph.nodes[0].spec.content) + "x"; refresh(input.graph); refusal(input, "bounds");
    const bytes = (value: unknown): number => typeof value === "string" ? Buffer.byteLength(value) : !value || typeof value !== "object" ? 0
      : Array.isArray(value) ? value.reduce((sum: number, child) => sum + bytes(child), 0)
        : Object.entries(value).reduce((sum, [key, child]) => sum + Buffer.byteLength(key) + bytes(child), 0);
    input = singleProvider(1); input.graph.notes = ["", ...Array.from({ length: 63 }, () => "x".repeat(MIXED_PARTITION_LIMITS.stringBytes))];
    input.graph.notes[0] = "x".repeat(MIXED_PARTITION_LIMITS.jsonBytes - bytes(input));
    expect(bytes(input)).toBe(MIXED_PARTITION_LIMITS.jsonBytes);
    expect(planMixedPartitions(input).partitions).toHaveLength(1);
    input.graph.notes[0] += "x"; refusal(input, "bounds");
  });

  it("accepts exactly 65536 JSON values and refuses the next value", () => {
    const count = (value: unknown): number => 1 + (!value || typeof value !== "object" ? 0 : Object.values(value).reduce<number>((sum, child) => sum + count(child), 0));
    const input = singleProvider(1); const items: number[] = []; input.graph.nodes[0].spec = { items }; refresh(input.graph);
    const remaining = MIXED_PARTITION_LIMITS.jsonValues - count(input);
    for (let i = 0; i < remaining; i++) items.push(0);
    refresh(input.graph);
    expect(count(input)).toBe(MIXED_PARTITION_LIMITS.jsonValues);
    expect(planMixedPartitions(input).partitions).toHaveLength(1);
    items.push(0); refresh(input.graph); refusal(input, "bounds");
  });
});
