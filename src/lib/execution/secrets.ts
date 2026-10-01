/**
 * Activity-local secret delivery, before deployWorkloads rolls any service.
 * Values are resolved only inside a brokered callback and never enter activity
 * arguments/results, events, evidence or diagnostic errors. Exact target refs
 * must be signed in grant.constraints.secretResources; missing grants fail closed.
 * OCI and AWS runner value writes are refused pending sealed request bodies.
 * Completed targets and partial/unknown outcomes are recorded without values.
 * Live clouds are unverified; providers are exercised by contract tests.
 */
import { digest } from "@/lib/controlplane/digest";
import { LeaseLostError } from "@/lib/controlplane/types";
import type { ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { LeaseRef } from "@/lib/workflows/types";
import { writeAwsSecret } from "@/lib/providers/aws/secret-writer";
import { writeGcpSecret } from "@/lib/providers/gcp/secret-writer";
import { syncSecretValue, SecretSyncError } from "@/lib/providers/azure/secrets";
import { kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";
import { renderObjects } from "@/lib/providers/kubernetes/render";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { createK8sClient, readObject, ownedBy } from "@/lib/providers/kubernetes/client";
import { ANNOTATION, SECRET_DATA_KEY, type K8sObject } from "@/lib/providers/kubernetes/types";
import { assertVaultScope, createSecretResolver, type SecretResolverScope } from "@/lib/secrets/resolver";
import { assertSecretGrant, sameSecret, SecretDeliveryError, secretFailure, type SecretFailure, type SecretWriteResult } from "@/lib/secrets/delivery";
import type { ExecContext } from "./context";
import { StepFailedError } from "./errors";
import { driverContext, withProviderSession } from "./session";
import type { Runtime } from "./runtime";

interface Target { node: ResourceNode; ref: string; id: string; vaultUri?: string; containerId?: string; object?: K8sObject }
export interface SecretSyncReport { status: "done" | "partial" | "failed"; total: number; completed: number; changed: number; reason?: SecretFailure; outcomeUnknown?: true }

export async function syncEnvironmentSecrets(rt: Runtime, ec: ExecContext, graph: ResourceGraph, connection: ProviderConnection, lease: LeaseRef, signal: AbortSignal): Promise<SecretSyncReport> {
  const nodes = graph.nodes.filter((n) => n.kind === "secret" && typeof n.spec.secretRef === "string" && n.spec.secretRef.startsWith("vault:"));
  const localNodes = graph.nodes.filter((n) => n.ownership === "managed" && ["kubernetes", "zenith"].includes(n.provider) && ["secret", "postgres", "redis"].includes(n.kind));
  if (!nodes.length && !localNodes.length) return { status: "done", total: 0, completed: 0, changed: 0 };
  const scope: SecretResolverScope = { workspaceId: ec.workspaceId, environmentId: ec.environmentId, projectId: ec.product.project.id, resourceAddresses: graph.nodes.filter((n) => n.ownership === "managed").map((n) => n.address) };
  const results: { address: string; changed: boolean; versionId?: string }[] = [];
  let total = nodes.length;
  let attempting = false;
  try {
    if (connection.workspaceId !== ec.workspaceId || connection.config.provider !== ec.product.environment.provider) throw new SecretDeliveryError("denied");
    if (nodes.some((n) => n.ownership !== "managed" || n.provider !== connection.config.provider)) throw new SecretDeliveryError("denied");
    if (connection.config.provider === "oci" || connection.config.mode === "runner") throw new SecretDeliveryError("unsupported");
    for (const node of nodes) assertVaultScope(node.spec.secretRef as string, scope);
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    const targets: Target[] = [];
    if (connection.config.provider === "kubernetes") {
      for (const node of localNodes) {
        const objects = renderObjects(node, { environmentId: ec.environmentId, node: (a) => graph.nodes.find((n) => n.address === a), nodes: () => graph.nodes });
        for (const object of objects.filter((o) => o.kind === "Secret")) {
          const ref = object.metadata.annotations?.[ANNOTATION.secretRef];
          if (!ref) throw new SecretDeliveryError("invalid");
          assertVaultScope(ref, scope);
          targets.push({ node, ref, id: `kubernetes:${object.metadata.namespace}/${object.metadata.name}`, object });
        }
      }
    } else {
      const rows = await rt.d.resources.list(ec.workspaceId, ec.environmentId);
      await withProviderSession(rt, ec, { purpose: "observe", capability: "infrastructure.observe", connection, fence: lease }, async (session) => {
        for (const node of nodes.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0)) {
          const row = rows.find((r) => r.address === node.address);
          if (row && (row.workspaceId !== ec.workspaceId || row.environmentId !== ec.environmentId || row.provider !== node.provider)) throw new SecretDeliveryError("denied");
          const driver = rt.drivers(node.provider, node.nativeType);
          if (!driver?.observe) throw new SecretDeliveryError("unsupported");
          const readSignal = AbortSignal.any([signal, AbortSignal.timeout(rt.limits.nodeTimeoutMs)]);
          const observation = await driver.observe(driverContext(rt, ec, session, readSignal, { node, fence: lease }), node, row?.externalId);
          if (observation.simulated || observation.address !== node.address || observation.presence !== "present" || !observation.externalId) throw new SecretDeliveryError(observation.presence === "inaccessible" ? "denied" : "missing");
          // The broker independently joins these observations to the reviewed
          // graph and compiled identities before signing the exact target set.
          if (row) await rt.d.resources.appendObservation({ workspaceId: ec.workspaceId, resourceId: row.id, observation });
          const ref = node.spec.secretRef as string;
          if (session.provider === "azure") {
            const id = observation.externalId;
            const match = /^\/subscriptions\/([0-9a-f-]+)\/resourceGroups\/[^/]+\/providers\/Microsoft\.KeyVault\/vaults\/([a-z0-9-]{3,24})$/i.exec(id);
            if (!match || match[1].toLowerCase() !== session.subscriptionId.toLowerCase()) throw new SecretDeliveryError("denied");
            const vaultUri = `https://${match[2].toLowerCase()}.vault.azure.net/`;
            targets.push({ node, ref, id: `${vaultUri}secrets/${kvSecretName(ref)}`, vaultUri, containerId: id });
          } else targets.push({ node, ref, id: observation.externalId });
        }
      });
    }
    total = targets.length;
    if (new Set(targets.map((t) => t.id)).size !== targets.length) throw new SecretDeliveryError("conflict");
    const { claims } = await rt.d.broker.issueGrant(ec.op.id, "worker", { scope: lease.scope, fenceToken: lease.fenceToken }, { capability: "secret.write", durationSec: 900 }).catch(() => { throw new SecretDeliveryError("denied"); });
    assertSecretGrant(claims, scope, targets.map((t) => t.id), rt.now().getTime());
    if (claims.op !== ec.op.id || claims.fence !== lease.fenceToken || claims.digest !== ec.op.proposalDigest) throw new SecretDeliveryError("denied");
    const resolve = createSecretResolver({ ...scope, allowedRefs: targets.map((t) => t.ref) });
    for (const target of targets) {
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      signal.throwIfAborted();
      const result = await rt.d.credentials.withSession({ connectionId: connection.id, grant: claims, purpose: connection.config.provider === "aws" ? "secret.write" : "deploy", secretResources: [target.id], durationSec: 900 }, async (session) => {
        if (session.provider !== connection.config.provider) throw new SecretDeliveryError("denied");
        // Recheck expiry after every exchange. Nothing is decrypted before this.
        assertSecretGrant(claims, scope, targets.map((t) => t.id), rt.now().getTime());
        attempting = true;
        return writeTarget(rt, ec, target, session, () => resolve(target.ref), AbortSignal.any([signal, AbortSignal.timeout(rt.limits.nodeTimeoutMs)]));
      });
      attempting = false;
      results.push({ address: target.node.address, ...result });
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    }
    const report: SecretSyncReport = { status: "done", total, completed: results.length, changed: results.filter((r) => r.changed).length };
    await record(report);
    return report;
  } catch (err) {
    const failure = secretFailure(err);
    const unknown = attempting && failure.reason === "unreachable";
    const report: SecretSyncReport = { status: results.length || unknown ? "partial" : "failed", total, completed: results.length, changed: results.filter((r) => r.changed).length, reason: failure.reason, ...(unknown ? { outcomeUnknown: true } : {}) };
    await record(report);
    if (err instanceof LeaseLostError) throw new LeaseLostError(lease.scope, lease.fenceToken);
    const message = `Secret sync ${report.status} (${failure.reason}): ${report.completed}/${total} completed; workloads were not rolled.${unknown ? " The current write outcome is unknown; reconcile is required." : ""}${failure.reason === "unsupported" ? " OCI and runner delivery require sealed secret request bodies." : ""}`;
    if (unknown) throw new Error(message);
    throw new StepFailedError(message);
  }
  async function record(report: SecretSyncReport) {
    // Do not pass provider errors to runtime writers (their diagnostics are text).
    try {
      await rt.evidence(ec.scope, { kind: "observation", digest: digest({ operationId: ec.op.id, report, results }), summary: { kind: "secret.sync", ...report, results }, simulated: false, key: `secret-sync:${digest({ report, results })}` }, { critical: false });
    } catch { rt.log("error", "secret sync evidence unavailable", { completed: results.length, total }); }
  }
}

async function writeTarget(rt: Runtime, ec: ExecContext, target: Target, session: ProviderSession, resolve: () => Promise<string | undefined>, signal: AbortSignal): Promise<SecretWriteResult> {
  const tenant = { workspaceId: ec.workspaceId, environmentId: ec.environmentId, projectId: ec.product.project.id };
  if (session.provider === "aws") return writeAwsSecret(session, { ...tenant, node: target.node, secretArn: target.id, fingerprintKey: rt.d.fingerprintKey, resolve, signal });
  if (session.provider === "gcp") return writeGcpSecret(session, { ...tenant, node: target.node, secretId: target.id, resolve, signal });
  if (session.provider === "azure") {
    let value: string | undefined;
    try {
      const response = await session.authorizedFetch(`https://management.azure.com${target.containerId}?api-version=2023-07-01`, { signal, redirect: "error" });
      if (!response.ok) throw secretFailure({ status: response.status });
      const container = await response.json() as { id?: unknown; tags?: Record<string, unknown>; properties?: { vaultUri?: unknown } };
      const tags = container.tags ?? {};
      if (typeof container.id !== "string" || container.id.toLowerCase() !== target.containerId?.toLowerCase() || tags["zenith:managed"] !== "true" || tags["zenith:workspace"] !== ec.workspaceId || tags["zenith:environment"] !== ec.environmentId || tags["zenith:resource"] !== target.node.address || container.properties?.vaultUri !== target.vaultUri) throw new SecretDeliveryError("denied");
      value = await resolve();
      if (value === undefined) throw new SecretDeliveryError("missing");
      const result = await syncSecretValue(session, { vaultUri: target.vaultUri!, secretRef: target.ref, value }, signal);
      return { changed: result.status !== "unchanged" };
    } catch (err) {
      if (err instanceof SecretSyncError) throw new SecretDeliveryError(err.reason === "forbidden_by_rbac" || err.reason === "forbidden_by_firewall" ? "denied" : err.reason === "throttled" ? "throttled" : err.reason === "unreachable" ? "unreachable" : "invalid");
      throw secretFailure(err);
    } finally { value = undefined; }
  }
  if (session.provider === "kubernetes" && target.object) {
    const object = target.object;
    const client = createK8sClient(session, { environmentId: ec.environmentId, signal });
    const namespace = object.metadata.namespace!;
    await client.guard.assert(namespace);
    const live = await readObject(client, { apiVersion: "v1", kind: "Secret", name: object.metadata.name, namespace });
    if (live) {
      const meta = live.metadata as { annotations?: Record<string, unknown> } | undefined;
      if (!ownedBy(live, ec.environmentId).owned || meta?.annotations?.[ANNOTATION.resource] !== target.node.address || (meta.annotations["zenith.dev/workspace"] !== undefined && meta.annotations["zenith.dev/workspace"] !== ec.workspaceId)) throw new SecretDeliveryError("denied");
    }
    let value: string | undefined;
    try {
      value = await resolve();
      if (value === undefined) throw new SecretDeliveryError("missing");
      const current = (live?.data as Record<string, unknown> | undefined)?.[SECRET_DATA_KEY];
      if (typeof current === "string" && sameSecret(Buffer.from(current, "base64"), value)) return { changed: false };
      const desired = { ...object, metadata: { ...object.metadata, annotations: { ...object.metadata.annotations, "zenith.dev/workspace": ec.workspaceId } } };
      const report = await serverSideApply([desired], session, { environmentId: ec.environmentId, signal, resolveSecret: async (ref) => {
        if (ref !== target.ref) throw new SecretDeliveryError("denied");
        return value;
      } });
      if (!report.ok) {
        const code = report.results.find((r) => r.errorCode)?.errorCode;
        throw new SecretDeliveryError(["forbidden", "unauthorized", "ownership_conflict", "namespace_forbidden"].includes(code ?? "") ? "denied" : code === "field_conflict" ? "conflict" : "unreachable");
      }
      return { changed: true };
    } finally { value = undefined; }
  }
  throw new SecretDeliveryError("unsupported");
}
