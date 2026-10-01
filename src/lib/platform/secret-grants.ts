/**
 * Derive exact secret targets from the operation's immutable revision and original
 * reviewed graph. Tenant-scoped, non-simulated observations must identify the
 * compiled container, never an arbitrary caller-supplied ARN. Kubernetes targets
 * come from the same value-free renderer as sync, including generated DB Secrets.
 * Missing/foreign/stale identities fail closed. No vault values are read here.
 */
import { repos } from "@/lib/controlplane/db";
import type { OperationRecord, Sql } from "@/lib/controlplane/types";
import { createConnectionsPort, createProductPort, StepFailedError } from "@/lib/execution";
import { parseOperationInput } from "@/lib/execution/context";
import { buildDesiredState } from "@/lib/execution/graph";
import { namePrefix } from "@/lib/execution/session";
import { renderObjects } from "@/lib/providers/kubernetes/render";
import { ANNOTATION } from "@/lib/providers/kubernetes/types";
import { kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";
import { assertVaultScope } from "@/lib/secrets/resolver";
import { partitionOfRegion } from "@/lib/providers/aws/drivers/shared/arn";
import { platformDriverLookup } from "./driver-lookup";

const refuse = (): never => { throw new StepFailedError("Secret grant targets are unavailable or outside the reviewed environment."); };

export async function secretResourcesForOperation(db: Sql, op: OperationRecord): Promise<string[]> {
  const { revisionId, deploymentId } = parseOperationInput(op);
  if (!op.environmentId || !op.projectId || !op.planDigest || !revisionId) return refuse();
  const product = await createProductPort().loadContext({ workspaceId: op.workspaceId, environmentId: op.environmentId, revisionId, deploymentId });
  if (product.project.id !== op.projectId) return refuse();
  const { graph } = buildDesiredState(product);
  if (!graph || graph.environmentId !== op.environmentId) return refuse();
  // Match the original review artifact, not a later re-plan or client claim.
  const evidence = await db.query<{ graph_digest: string }>(
    `select summary->>'graphDigest' as graph_digest from platform.evidence
     where workspace_id = $1 and operation_id = $2 and kind = 'tofu_plan'
       and digest = $3 and simulated = false and summary->>'stage' = 'plan'
     order by created_at, id limit 1`, [op.workspaceId, op.id, op.planDigest]);
  if (evidence[0]?.graph_digest !== graph.graphDigest) return refuse();
  const connection = await createConnectionsPort(db).resolve({ workspaceId: op.workspaceId, connectionId: product.environment.connectionId });
  if (!connection || connection.status !== "verified" || connection.workspaceId !== op.workspaceId || connection.config.provider !== product.environment.provider || connection.config.mode === "runner") return refuse();
  const scope = { workspaceId: op.workspaceId, projectId: op.projectId, environmentId: op.environmentId,
    resourceAddresses: graph.nodes.filter((n) => n.ownership === "managed").map((n) => n.address) };
  const targets: string[] = [];
  if (connection.config.provider === "kubernetes") {
    for (const node of graph.nodes.filter((n) => n.ownership === "managed" && ["kubernetes", "zenith"].includes(n.provider) && ["secret", "postgres", "redis"].includes(n.kind))) {
      for (const object of renderObjects(node, { environmentId: op.environmentId, node: (a) => graph.nodes.find((n) => n.address === a), nodes: () => graph.nodes }).filter((o) => o.kind === "Secret")) {
        const ref = object.metadata.annotations?.[ANNOTATION.secretRef];
        if (!ref || !object.metadata.namespace || !object.metadata.name) return refuse();
        assertVaultScope(ref, scope);
        targets.push(`kubernetes:${object.metadata.namespace}/${object.metadata.name}`);
      }
    }
  } else {
    const rows = await repos.resources.listByEnvironment(db, op.workspaceId, op.environmentId);
    for (const node of graph.nodes.filter((n) => n.kind === "secret" && typeof n.spec.secretRef === "string" && n.spec.secretRef.startsWith("vault:"))) {
      if (node.ownership !== "managed" || node.provider !== connection.config.provider) return refuse();
      assertVaultScope(node.spec.secretRef as string, scope);
      const row = rows.find((r) => r.address === node.address);
      if (!row || row.workspaceId !== op.workspaceId || row.environmentId !== op.environmentId || row.projectId !== op.projectId || row.provider !== node.provider || row.nativeType !== node.nativeType || row.ownership !== "managed" || row.specDigest !== node.specDigest || row.revisionId !== revisionId || row.status === "deleted") return refuse();
      const observation = await repos.observations.latestObservation(db, op.workspaceId, row.id);
      if (!observation || observation.simulated || observation.address !== node.address || observation.presence !== "present" || !observation.externalId) return refuse();
      const fragment = platformDriverLookup(node.provider, node.nativeType)?.compile?.(node, {
        environmentId: op.environmentId, namePrefix: namePrefix(op.environmentId), region: node.region,
        tags: { "zenith:workspace": op.workspaceId, "zenith:environment": op.environmentId, "zenith:managed": "true" },
        node: (a) => graph.nodes.find((n) => n.address === a), ref: () => "${local.secret_grant_reference}",
      });
      const container = (type: string, field: string): string => {
        const values = Object.values(fragment?.resource?.[type] ?? {});
        const value = values.length === 1 ? values[0][field] : undefined;
        return typeof value === "string" && /^[A-Za-z0-9_/-]+$/.test(value) ? value : refuse();
      };
      const id = observation.externalId;
      switch (connection.config.provider) {
        case "aws": {
          const match = /^arn:(aws(?:-cn|-us-gov)?):secretsmanager:([a-z0-9-]+):(\d{12}):secret:(.+)-[A-Za-z0-9]{6}$/.exec(id);
          if (!match || match[1] !== partitionOfRegion(node.region) || match[2] !== node.region || match[3] !== connection.config.accountId || match[4] !== container("aws_secretsmanager_secret", "name")) return refuse();
          targets.push(id); break;
        }
        case "gcp":
          if (id !== `projects/${connection.config.projectId}/secrets/${container("google_secret_manager_secret", "secret_id")}`) return refuse();
          targets.push(id); break;
        case "azure": {
          const match = /^\/subscriptions\/([0-9a-f-]+)\/resourceGroups\/[^/]+\/providers\/Microsoft\.KeyVault\/vaults\/([a-z0-9-]{3,24})$/i.exec(id);
          if (!match || match[1].toLowerCase() !== connection.config.subscriptionId.toLowerCase() || match[2].toLowerCase() !== container("azurerm_key_vault", "name")) return refuse();
          targets.push(`https://${match[2].toLowerCase()}.vault.azure.net/secrets/${kvSecretName(node.spec.secretRef as string)}`); break;
        }
        default: return refuse();
      }
    }
  }
  if (!targets.length || new Set(targets).size !== targets.length || targets.some((id) => /[*?]/.test(id))) return refuse();
  return targets.sort();
}
