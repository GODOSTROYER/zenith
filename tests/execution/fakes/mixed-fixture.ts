/**
 * Logical mixed-graph fixture for the orchestration tests (PROD-MIX-03/04). A three child chain:
 * DB (azure) <- WEB (gcp) <- FN (aws). These are pure planning snapshots: no cloud API is called and
 * nothing here proves traffic or custody (contract level).
 */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderConnection } from "@/lib/credentials/types";
import { parentViewOf, type ParentPlanView } from "@/lib/execution/mixed-orchestration/child-view";
import { applyOutputs, assessOutputConsumption, parseTypedOutput, validateOutput, type TypedOutput } from "@/lib/execution/mixed-orchestration/outputs";
import { applyRunEvent, createRunState, type AnyRunEvent, type MixedRunState } from "@/lib/execution/mixed-orchestration/run";
import { planMixedPartitions, type MixedPartitionInput, type MixedPartitionPlan, type PartitionBinding, type PartitionReference } from "@/lib/execution/mixed-partitions";
import { finalizeGraph, GraphBuilder } from "@/lib/resources/expand-support";
import { backendForConnection } from "@/lib/tofu/backends";

export const WS = "ws-mix";
export const ENV = "env-mix";
export const PARENT = "op-parent";
export const DB = "resource/db";
export const WEB = "service/web";
export const FN = "service/functions";
export const ACCOUNT = "123456789012";
export const SUB = "11111111-2222-3333-4444-555555555555";
export const TENANT = "22222222-3333-4444-5555-666666666666";
export const CLIENT = "33333333-4444-5555-6666-777777777777";
export const H = (label: string): string => digest(label);
export const T0 = Date.parse("2026-10-07T12:00:00.000Z");
export const NOW = new Date(T0);
export const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

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

function reference(id: string, producer: string, consumer: string, type: PartitionReference["producer"]["type"] = "endpoint", output = "endpoint"): PartitionReference {
  return { id, scope: { workspaceId: WS, environmentId: ENV },
    producer: { address: producer, output, type },
    consumer: { address: consumer, input: `input_${id}`, type },
    materialization: { state: "unavailable", reason: "not_produced" } };
}

export function fixture(options: { secret?: boolean } = {}): MixedPartitionInput {
  const b = new GraphBuilder(ENV);
  b.add({ address: DB, kind: "postgres", place: { provider: "azure", region: "eastus" }, spec: { storageGb: 32 }, origin: ["db"] });
  b.add({ address: WEB, kind: "compute_instance", place: { provider: "gcp", region: "us-central1" }, spec: { machineType: "logical-compute", database: DB }, origin: ["web"], dependsOn: [DB] });
  b.add({ address: FN, kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { sourceService: WEB }, origin: ["functions"], dependsOn: [WEB] });
  b.edge(WEB, DB, options.secret ? "reads_secret" : "connects_to");
  b.edge(FN, WEB, "connects_to");
  return { workspaceId: WS, graph: finalizeGraph(b, ENV, H("manifest-logical-mix")),
    bindings: [binding("aws"), binding("gcp"), binding("azure")],
    assignments: [{ address: WEB, bindingId: "gcp" }, { address: DB, bindingId: "azure" }, { address: FN, bindingId: "aws" }],
    references: [options.secret ? reference("db-secret", DB, WEB, "secret_ref", "password") : reference("db-host", DB, WEB), reference("web-host", WEB, FN)] };
}

export interface World {
  input: MixedPartitionInput;
  plan: MixedPartitionPlan;
  view: ParentPlanView;
  state: MixedRunState;
  ids: { db: string; web: string; fn: string };
}

export function partitionOf(plan: MixedPartitionPlan, address: string) {
  return plan.partitions.find((partition) => partition.nodes.some((node) => node.address === address))!;
}

export function world(options: { secret?: boolean; expiresInMinutes?: number; childTimeoutMs?: number } = {}): World {
  const input = fixture(options);
  const plan = planMixedPartitions(input);
  const view = parentViewOf(plan, input.references);
  const state = createRunState(view, { parentOperationId: PARENT, expiresAt: at(options.expiresInMinutes ?? 120), childTimeoutMs: options.childTimeoutMs ?? 10 * 60_000, now: NOW });
  return { input, plan, view, state, ids: { db: partitionOf(plan, DB).id, web: partitionOf(plan, WEB).id, fn: partitionOf(plan, FN).id } };
}

/** Drive events through the reducer. */
export function drive(state: MixedRunState, view: ParentPlanView | undefined, ...events: AnyRunEvent[]): MixedRunState {
  return events.reduce((current, event) => applyRunEvent(current, event, view), state);
}

export const start = (childId: string, state: MixedRunState, minute: number): AnyRunEvent => ({ kind: "start", childId, attemptId: `attempt-${childId.slice(-6)}-${minute}`, approvedEffectDigest: state.children[childId].effectDigest, at: at(minute) });
export const succeed = (childId: string, minute: number): AnyRunEvent => ({ kind: "succeed", childId, receiptDigest: H(`receipt-${childId}`), at: at(minute) });

/** Start and succeed a child at the given minute. */
export function finish(state: MixedRunState, view: ParentPlanView, childId: string, minute: number): MixedRunState {
  return drive(state, view, start(childId, state, minute), succeed(childId, minute + 1));
}

/** The typed output a succeeded producer hands to the consumer of `referenceId`. */
export function outputFor(w: Pick<World, "plan" | "input" | "state">, referenceId: string, over: { value?: string; secret?: boolean; state?: MixedRunState } = {}): TypedOutput {
  const reference = w.input.references.find((item) => item.id === referenceId)!;
  const producer = partitionOf(w.plan, reference.producer.address);
  const consumer = partitionOf(w.plan, reference.consumer.address);
  const state = over.state ?? w.state;
  const secret = reference.producer.type === "secret_ref" ? { ref: "vault:project/service/password", versionDigest: H(`secret-version-${over.value ?? "1"}`) } : undefined;
  return parseTypedOutput({
    referenceId, type: reference.producer.type,
    scope: { workspaceId: WS, environmentId: ENV, consumerChildId: consumer.id, consumerConnectionId: consumer.identity.connectionId },
    provenance: { producerChildId: producer.id, producerAddress: reference.producer.address, producerOutput: reference.producer.output, producerConnectionId: producer.identity.connectionId,
      producerSubplanDigest: producer.subplanDigest, producerEffectDigest: state.children[producer.id].effectDigest, receiptDigest: state.children[producer.id].receiptDigest ?? H("none"), artifactDigest: H(`artifact-${referenceId}`) },
    valueDigest: secret ? digest({ ref: secret.ref, versionDigest: secret.versionDigest }) : H(`value-${referenceId}-${over.value ?? "1"}`),
    ...(secret ? { secret } : {}),
  });
}

/**
 * Consume one reference the way an executor would with a person's review of the exact new parent digest:
 * validate, assess, rebind with the review. Returns the next state and the next approved planner input.
 */
export function consume(w: Pick<World, "view" | "plan">, state: MixedRunState, input: MixedPartitionInput, referenceId: string, minute: number): { state: MixedRunState; input: MixedPartitionInput } {
  const output = validateOutput(outputFor({ plan: w.plan, input, state }, referenceId), state, w.view);
  const decision = assessOutputConsumption({ approvedInput: input, parentOperationId: PARENT, outputs: [output], preauthorizations: [], now: NOW });
  const next = drive(state, w.view, {
    kind: "rebind", decision, at: at(minute),
    ...(decision.classification === "review_required" ? { review: { approvalId: "appr-review", approvedParentDigest: decision.requiredParentDigest } } : {}),
  });
  return { state: next, input: applyOutputs(input, planMixedPartitions(input), [output]) };
}

/** DB and WEB applied, their outputs consumed; FN not started. The run is open and healthy. */
export function throughWeb(w: World): { state: MixedRunState; input: MixedPartitionInput } {
  let state = finish(w.state, w.view, w.ids.db, 1);
  let step = consume(w, state, w.input, w.input.references.find((r) => r.producer.address === DB)!.id, 3);
  state = finish(step.state, w.view, w.ids.web, 4);
  step = consume(w, state, step.input, "web-host", 6);
  return step;
}

/** Every child applied. */
export function complete(w: World): { state: MixedRunState; input: MixedPartitionInput } {
  const step = throughWeb(w);
  return { state: finish(step.state, w.view, w.ids.fn, 7), input: step.input };
}
