/**
 * Logical fixtures for the mixed parent/child plan tests. Contract level: provider
 * connections are stored-shape records (no cloud is reached), graphs come from the
 * real graph builder, and every digest is computed by the production code.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderConnection } from "@/lib/credentials/types";
import { buildParentPlan, type BuildParentPlanInput } from "@/lib/execution/mixed/parent-plan";
import type { ChildEnvironmentCandidate } from "@/lib/execution/mixed/partitioner";
import type { MixedParentPlan } from "@/lib/execution/mixed/types";
import { finalizeGraph, GraphBuilder, graphDigestOf, specDigestOf } from "@/lib/resources/expand-support";
import type { ResourceGraph } from "@/lib/resources/types";

export const WS = "ws-mix";
export const PARENT_ENV = "env-parent";
export const PROJECT = "proj-mix";
export const ACCOUNT = "123456789012";
export const SUB = "11111111-2222-3333-4444-555555555555";
export const TENANT = "22222222-3333-4444-5555-666666666666";
export const CLIENT = "33333333-4444-5555-6666-777777777777";
export const DB = "resource/db";
export const WEB = "service/web";
export const FN = "service/functions";

export type Provider = "aws" | "gcp" | "azure";

export function connection(provider: Provider, over: { id?: string; status?: ProviderConnection["status"]; workspaceId?: string; deployRole?: string; noBucket?: boolean } = {}): ProviderConnection {
  const config: ProviderConnection["config"] = provider === "aws"
    ? { provider, mode: "oidc_web_identity", accountId: ACCOUNT, region: "us-east-1", observeRoleArn: `arn:aws:iam::${ACCOUNT}:role/observe`, deployRoleArn: over.deployRole ?? `arn:aws:iam::${ACCOUNT}:role/deploy`, ...(over.noBucket ? {} : { stateBucket: "zenith-mix-aws" }) }
    : provider === "gcp"
      ? { provider, mode: "oidc_web_identity", projectId: "zenith-mix", region: "us-central1", workloadIdentityProvider: "projects/123456/locations/global/workloadIdentityPools/zenith/providers/zenith", observeServiceAccount: "observe@zenith-mix.iam.gserviceaccount.com", deployServiceAccount: "deploy@zenith-mix.iam.gserviceaccount.com", stateBucket: "zenith-mix-gcp" }
      : { provider, mode: "oidc_web_identity", subscriptionId: SUB, tenantId: TENANT, clientId: CLIENT, region: "eastus", stateStorageAccount: "zenithmixstate", stateContainer: "tofu-state" };
  const status = over.status ?? "verified";
  return {
    id: over.id ?? `conn-${provider}`, workspaceId: over.workspaceId ?? WS, status, createdBy: "user-logical", createdAt: "2026-10-03T00:00:00Z", config,
    ...(status === "revoked" ? { revokedAt: "2026-10-04T00:00:00Z" } : {}),
  };
}

/** Azure Postgres <- GCP compute <- AWS functions, ordered by node dependencies only (no cross-partition data edges). */
export function mixedGraph(): ResourceGraph {
  const b = new GraphBuilder(PARENT_ENV);
  b.add({ address: DB, kind: "postgres", place: { provider: "azure", region: "eastus" }, spec: { storageGb: 32 }, origin: ["db"] });
  b.add({ address: WEB, kind: "compute_instance", place: { provider: "gcp", region: "us-central1" }, spec: { machineType: "logical-compute" }, origin: ["web"], dependsOn: [DB] });
  b.add({ address: FN, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { sourceService: WEB }, origin: ["functions"], dependsOn: [WEB] });
  return finalizeGraph(b, PARENT_ENV, digest("manifest-logical-mix"));
}

/** Two AWS functions in one region, for ambiguity and pinning. */
export function twoAwsGraph(): ResourceGraph {
  const b = new GraphBuilder(PARENT_ENV);
  b.add({ address: "service/a", kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 1 }, origin: ["a"] });
  b.add({ address: "service/b", kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 2 }, origin: ["b"] });
  return finalizeGraph(b, PARENT_ENV, digest("manifest-two-aws"));
}

export function candidates(over: { aws?: ProviderConnection; gcp?: ProviderConnection; azure?: ProviderConnection } = {}): ChildEnvironmentCandidate[] {
  return [
    { childEnvironmentId: "env-aws", connection: over.aws ?? connection("aws") },
    { childEnvironmentId: "env-gcp", connection: over.gcp ?? connection("gcp") },
    { childEnvironmentId: "env-azure", connection: over.azure ?? connection("azure") },
  ];
}

export function plan(over: Partial<BuildParentPlanInput> = {}): MixedParentPlan {
  return buildParentPlan({ workspaceId: WS, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph: mixedGraph(), candidates: candidates(), ...over });
}

/** Re-derive digests after mutating a graph in place, as the existing partition tests do. */
export function refresh(graph: ResourceGraph): void {
  graph.nodes.forEach((node) => { node.specDigest = specDigestOf(node); });
  graph.nodes.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  graph.edges.sort((a, b) => {
    const left = `${a.from}\0${a.to}\0${a.relation}\0${a.detail ?? ""}`;
    const right = `${b.from}\0${b.to}\0${b.relation}\0${b.detail ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  graph.graphDigest = graphDigestOf(graph.nodes, graph.edges);
}
