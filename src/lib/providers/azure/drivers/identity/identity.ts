/**
 * `azure:user_assigned_identity` — portable `identity` (principal: workload).
 *
 * One user-assigned managed identity per workload, plus one role assignment per
 * `IdentitySpec.grants` entry that has an Azure role. Least privilege by
 * construction:
 *   - every assignment is scoped to ONE target resource (the registry, the blob
 *     container, the queue, the secret's vault) — never a resource group or the
 *     subscription, never a wildcard;
 *   - roles come from a closed table of narrow built-in data roles; Owner,
 *     Contributor, User Access Administrator and RBAC Administrator can never
 *     be produced (`FORBIDDEN_ROLE_NAMES`, asserted in tests);
 *   - an unknown target kind or verb is a compile error, never a silently
 *     dropped permission.
 *
 *   target kind / verbs                     role (scope)
 *   container_registry  pull                AcrPull (registry)
 *   object_store        read, list          Storage Blob Data Reader (container)
 *                       write, delete       Storage Blob Data Contributor (container)
 *   queue / pubsub      publish             Azure Service Bus Data Sender (queue/topic)
 *                       consume             Azure Service Bus Data Receiver (queue/topic)
 *   secret (managed)    read                Key Vault Secrets User (the secret's vault)
 *   log_group           write               — none: Container Apps delivers logs itself
 *   postgres            read_credentials    — none: Entra database roles are a SQL step
 *   secret (referenced) read                — none: Zenith never changes what it does not own
 *
 * Observation: the identity's principal plus the set of built-in role names
 * assigned to it (subscription-wide listing by principal id).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { IdentityGrant, IdentitySpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, mergeBlocks, requireNode, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef, type ExportKey } from "@/lib/providers/azure/exports";
import { defineAzureDriver, findTagged, getById, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient, type ArmResource, type Json } from "@/lib/providers/azure/arm";
import { azureTags, cloudName, hash6, nodeKindOf, tfLabel } from "@/lib/providers/azure/naming";
import { API, FORBIDDEN_ROLE_NAMES, ROLE } from "@/lib/providers/azure/platform";
import { workloadTrust } from "@/lib/providers/gcp/drivers/identity/workload-trust";
import { tfLiteral } from "@/lib/providers/azure/drivers/more-util";
import { assertRoleFitsTarget } from "@/lib/providers/azure/data-plane-rbac";
import { azureCloud } from "@/lib/providers/azure/cloud";

export const USER_ASSIGNED_IDENTITY = { type: "Microsoft.ManagedIdentity/userAssignedIdentities", apiVersion: API.identity } as const;

/** Built-in role definition GUIDs → names, for reading assignments back. */
export const BUILTIN_ROLE_IDS: Readonly<Record<string, string>> = {
  "4633458b-17de-408a-b874-0445c86b69e6": ROLE.keyVaultSecretsUser,
  "b86a8fe4-44ce-4948-aee5-eccb2c155cd7": ROLE.keyVaultSecretsOfficer,
  "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1": ROLE.blobReader,
  "ba92f5b4-2d11-453d-a403-e96b0029c9fe": ROLE.blobContributor,
  "b7e6dc6d-f1e8-4753-8033-0f276bb0955b": ROLE.blobOwner,
  "974c5e8b-45b9-4653-ba55-5f855dd0fb88": ROLE.storageQueueContributor,
  "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39": ROLE.serviceBusSender,
  "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0": ROLE.serviceBusReceiver,
  "7f951dda-4ed3-4680-a7ca-43fe172d538d": ROLE.acrPull,
  "8311e382-0749-4cb8-b61a-304f252e45ec": ROLE.acrPush,
};

export interface RoleGrant {
  target: string;
  role: string;
  /** which export of the target node holds the scope's resource id */
  scopeKey: ExportKey;
}

const KNOWN_VERBS = new Set(["pull", "push", "read", "list", "write", "delete", "publish", "consume", "read_credentials"]);
const NO_ROLE_KINDS = new Set(["log_group", "postgres", "mysql", "redis"]);

/**
 * Grants → Azure roles by target KIND (from the address), which is all
 * `expectedAttributes` has. `referencedSecret` narrows secret handling at
 * compile time, where the target node is known.
 */
export function rolesForGrants(grants: readonly IdentityGrant[], referencedSecret: (address: string) => boolean = () => false, where?: string): RoleGrant[] {
  const out: RoleGrant[] = [];
  const add = (target: string, role: string, scopeKey: ExportKey) => {
    if (FORBIDDEN_ROLE_NAMES.includes(role)) throw new AzureCompileError(`role ${role} is never granted by Zenith.`, where);
    // Workload grants are data-plane roles from the catalog, meant for this kind of target (data-plane-rbac.ts).
    try {
      assertRoleFitsTarget(role, nodeKindOf(target));
    } catch (e) {
      throw new AzureCompileError(e instanceof Error ? e.message : `role ${role} is not grantable.`, where);
    }
    out.push({ target, role, scopeKey });
  };
  for (const g of [...grants].sort((x, y) => (x.target < y.target ? -1 : x.target > y.target ? 1 : 0))) {
    if (g.target.includes("*") || g.access.some((v) => v.includes("*"))) throw new AzureCompileError(`grant on "${g.target}" contains a wildcard.`, where);
    for (const verb of g.access) if (!KNOWN_VERBS.has(verb)) throw new AzureCompileError(`grant on ${g.target} has unknown verb "${verb}".`, where);
    const kind = nodeKindOf(g.target);
    const has = (...v: string[]) => g.access.some((x) => v.includes(x));
    if (NO_ROLE_KINDS.has(kind)) continue;
    switch (kind) {
      case "container_registry":
        // push implies pull, so a grant with both gets the single AcrPush role (least privilege: one role, one scope)
        if (has("push")) add(g.target, ROLE.acrPush, "id");
        else if (has("pull")) add(g.target, ROLE.acrPull, "id");
        break;
      case "object_store":
        if (has("write", "delete")) add(g.target, ROLE.blobContributor, "resource_manager_id");
        else if (has("read", "list")) add(g.target, ROLE.blobReader, "resource_manager_id");
        break;
      case "queue":
      case "pubsub":
        if (has("publish")) add(g.target, ROLE.serviceBusSender, "id");
        if (has("consume")) add(g.target, ROLE.serviceBusReceiver, "id");
        break;
      case "secret":
        if (has("read") && !referencedSecret(g.target)) add(g.target, ROLE.keyVaultSecretsUser, "vault_id");
        break;
      default:
        throw new AzureCompileError(`no Azure role mapping for a grant on "${g.target}" (kind "${kind}").`, where);
    }
  }
  return out;
}

export function compileIdentity(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<IdentitySpec>(node);
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const L = tfLabel(a, "uai");
  const isReferencedSecret = (address: string) => ctx.node(address)?.ownership !== "managed";
  for (const g of spec.grants) requireNode(ctx, g.target, "a grant target", a);
  const roles = rolesForGrants(spec.grants, isReferencedSecret, a);
  const trust = workloadTrust(node, ctx);
  const federation: NonNullable<TofuFragment["resource"]> = {};
  if (trust.state === "ready") {
    const issuerLabel = tfLabel(a, "cluster_issuer");
    const issuerDeployment = `azurerm_resource_group_template_deployment.${issuerLabel}`;
    // The AKS driver uses an ARM template to avoid kubeconfig LIST calls.
    // An outputs-only deployment reads ONLY its public issuer; no azurerm
    // cluster data source, extra provider or guessed issuer URL is needed.
    federation.azurerm_resource_group_template_deployment = { [issuerLabel]: {
      name: cloudName(ctx, a, { max: 64, suffix: "issuer" }),
      resource_group_name: exportRef(resolveNetwork(trust.cluster, ctx), "rg_name"),
      deployment_mode: "Incremental",
      template_content: JSON.stringify({
        $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        contentVersion: "1.0.0.0",
        parameters: { clusterId: { type: "string" } },
        resources: [],
        outputs: { issuer: { type: "string", value: "[reference(parameters('clusterId'), '2024-10-01').oidcIssuerProfile.issuerURL]" } },
      }),
      parameters_content: JSON.stringify({ clusterId: { value: exportRef(trust.cluster.address, "id") } }),
    } };
    federation.azurerm_federated_identity_credential = { [tfLabel(a, "workload_trust")]: {
      name: cloudName(ctx, a, { max: 120, suffix: "trust" }),
      // azurerm 5.x: the credential hangs off the identity by id (parent_id/resource_group_name are gone)
      user_assigned_identity_id: `\${azurerm_user_assigned_identity.${L}.id}`,
      issuer: `\${jsondecode(${issuerDeployment}.output_content).issuer.value}`,
      subject: trust.subject,
      audience: [azureCloud(ctx.azureCloud).federationAudience],
    } };
  }

  const resource = mergeBlocks(
    federation,
    block("azurerm_user_assigned_identity", L, {
      name: cloudName(ctx, a, { max: 128, suffix: "id" }),
      location: node.region,
      resource_group_name: exportRef(net, "rg_name"),
      tags: azureTags(ctx, node),
    }),
    ...roles.map((r) =>
      block("azurerm_role_assignment", tfLabel(a, `ra_${hash6(`${r.target}|${r.role}`)}`), {
        scope: exportRef(r.target, r.scopeKey),
        role_definition_name: r.role,
        principal_id: `\${azurerm_user_assigned_identity.${L}.principal_id}`,
        principal_type: "ServicePrincipal",
        // The identity is created in this same apply: skip the Entra existence pre-check that fails with
        // PrincipalNotFound while the new service principal replicates (the documented managed-identity race).
        skip_service_principal_aad_check: true,
        description: `Zenith grant on ${r.target}`,
      })
    )
  );
  return fragment({
    resource,
    ...(trust.state === "unresolved" ? { output: { [`${tfLabel(a)}_trust_note`]: { value: tfLiteral(trust.note) } } } : {}),
    locals: exportLocals(a, {
      id: `\${azurerm_user_assigned_identity.${L}.id}`,
      principal_id: `\${azurerm_user_assigned_identity.${L}.principal_id}`,
      client_id: `\${azurerm_user_assigned_identity.${L}.client_id}`,
      name: `\${azurerm_user_assigned_identity.${L}.name}`,
    }),
  });
}

/* --------------------------------- observe ---------------------------------- */

export function expectedIdentity(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<IdentitySpec>(node);
  let roles: string[] = [];
  try {
    roles = [...new Set(rolesForGrants(spec.grants).map((r) => r.role))].sort();
  } catch {
    /* compile reports unmappable grants */
  }
  return { roles };
}

async function locateIdentity(ctx: AzureCtx, node: ResourceNode, externalId?: string): Promise<Located> {
  const arm = armClient(ctx.session, ctx.signal);
  let id = externalId;
  if (!id) {
    const found = await findTagged(ctx, node.address, arm, USER_ASSIGNED_IDENTITY.type);
    if (!("matches" in found)) return found;
    if (found.matches.length === 0) return { state: "missing" };
    if (found.matches.length > 1) return { state: "unknown", detail: `ambiguous: ${found.matches.length} identities carry this node's tags` };
    id = found.matches[0].id;
  }
  const got = await getById(arm, id, API.identity);
  if (got.state !== "found") return got;
  const principalId = pick<string>(props(got.resource), "principalId");
  const extra: Json = {};
  if (principalId && /^[0-9a-f-]{36}$/i.test(principalId)) {
    try {
      const { items } = await arm.list<ArmResource>(`/subscriptions/${ctx.session.subscriptionId}/providers/Microsoft.Authorization/roleAssignments`, { apiVersion: API.authorization, query: { $filter: `principalId eq '${principalId}'` } }, 3);
      const names = new Set<string>();
      for (const ra of items) {
        const defId = String(pick<string>(ra, "properties", "roleDefinitionId") ?? "");
        const guid = defId.split("/").pop()?.toLowerCase() ?? "";
        names.add(BUILTIN_ROLE_IDS[guid] ?? `custom-or-unknown:${guid.slice(0, 8)}`);
      }
      extra.zenithRoles = [...names].sort();
    } catch {
      /* roles stay unknown (the attribute becomes unknown below) */
    }
  }
  return { state: "found", resource: { ...got.resource, properties: { ...props(got.resource), ...extra } } };
}

export const identityDriver = defineAzureDriver({
  id: "azure.user_assigned_identity@1",
  kind: "identity",
  nativeType: "azure:user_assigned_identity",
  arm: USER_ASSIGNED_IDENTITY,
  locate: locateIdentity,
  compile: compileIdentity,
  expected: expectedIdentity,
  read: (res) => ({ roles: props(res).zenithRoles }),
  native: (res) => ({ principalId: props(res).principalId, clientId: props(res).clientId, roles: props(res).zenithRoles }),
});
