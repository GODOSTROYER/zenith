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

export const USER_ASSIGNED_IDENTITY = { type: "Microsoft.ManagedIdentity/userAssignedIdentities", apiVersion: API.identity } as const;

/** Built-in role definition GUIDs → names, for reading assignments back. */
export const BUILTIN_ROLE_IDS: Readonly<Record<string, string>> = {
  "4633458b-17de-408a-b874-0445c86b69e6": ROLE.keyVaultSecretsUser,
  "b86a8fe4-44ce-4948-aee5-eccb2c155cd7": ROLE.keyVaultSecretsOfficer,
  "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1": ROLE.blobReader,
  "ba92f5b4-2d11-453d-a403-e96b0029c9fe": ROLE.blobContributor,
  "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39": ROLE.serviceBusSender,
  "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0": ROLE.serviceBusReceiver,
  "7f951dda-4ed3-4680-a7ca-43fe172d538d": ROLE.acrPull,
};

export interface RoleGrant {
  target: string;
  role: string;
  /** which export of the target node holds the scope's resource id */
  scopeKey: ExportKey;
}

const KNOWN_VERBS = new Set(["pull", "read", "list", "write", "delete", "publish", "consume", "read_credentials"]);
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
        if (has("pull")) add(g.target, ROLE.acrPull, "id");
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

  const resource = mergeBlocks(
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
        description: `Zenith grant on ${r.target}`,
      })
    )
  );
  return fragment({
    resource,
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
