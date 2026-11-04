/**
 * `azure:key_vault_secret` — portable `secret` (`SecretSpec`: a reference,
 * never a value).
 *
 * Each managed secret node gets its OWN Key Vault, so a workload identity is
 * granted "Key Vault Secrets User" on a vault that holds exactly the secret it
 * was granted (least privilege by construction, and no shared-vault owner to
 * elect among nodes that cannot see each other). Vaults cost nothing at rest.
 * Names are global and soft-deleted vaults keep theirs for 90 days, so
 * re-creating a deleted secret node within that window fails until the old
 * vault is purged (purge protection forbids purging earlier).
 *
 * The vault, not the secret, is what tofu manages:
 *   - RBAC authorization (no access policies), purge protection, 90-day soft
 *     delete, standard SKU;
 *   - NO secret resource: the VALUE is written by `syncSecretValue`
 *     (`secrets.ts`) through the data-plane API at deploy time, so it never
 *     enters tofu config, plan or state;
 *   - the secret's versionless URI is exported (`secret_uri`) for Container Apps
 *     secret references.
 *
 * Network: the vault's public endpoint stays ENABLED, protected by Entra
 * authentication and RBAC only. This is the documented exception to "no public
 * network access on data services": `syncSecretValue` runs in Zenith's
 * execution worker, outside the customer VNet, and a private-only vault would
 * make every secret deploy fail. Runner mode (a runner inside the network) can
 * tighten this with a follow-up spec knob; it is not guessed here.
 *
 * `referenced` secrets (a Key Vault secret the customer owns) compile to
 * nothing: Zenith reads the reference, never mutates the vault.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { SecretSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, pick, props } from "@/lib/providers/azure/kit";
import { safeText, sendJson, type Json } from "@/lib/providers/azure/arm";
import { azureTags, cloudName, hash6, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";

export const KEY_VAULT = { type: "Microsoft.KeyVault/vaults", apiVersion: API.keyVault } as const;

/** Key Vault secret names: 1–127 of `[0-9A-Za-z-]`. */
export function kvSecretName(secretRef: string): string {
  const last = secretRef.split(/[/:]/).filter(Boolean).pop() ?? "secret";
  const base = last.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return base || `secret-${hash6(secretRef)}`;
}

export function compileKeyVaultSecret(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<SecretSpec>(node);
  const a = node.address;
  if (node.ownership !== "managed") return fragment({});
  if (spec.store !== "zenith_vault") throw new AzureCompileError(`managed secrets come from the Zenith vault; "${String(spec.store)}" is referenced, not managed.`, a);
  const net = resolveNetwork(node, ctx);
  const L = tfLabel(a, "kv");
  const secretName = kvSecretName(spec.secretRef);
  return fragment({
    resource: block("azurerm_key_vault", L, {
      name: cloudName(ctx, a, { max: 24, suffix: "kv" }),
      location: node.region,
      resource_group_name: exportRef(net, "rg_name"),
      tenant_id: exportRef(net, "tenant_id"),
      sku_name: "standard",
      rbac_authorization_enabled: true,
      purge_protection_enabled: true,
      soft_delete_retention_days: 90,
      public_network_access_enabled: true,
      tags: azureTags(ctx, node),
      lifecycle: { prevent_destroy: true },
    }),
    locals: exportLocals(a, {
      vault_id: `\${azurerm_key_vault.${L}.id}`,
      vault_uri: `\${azurerm_key_vault.${L}.vault_uri}`,
      name: `\${azurerm_key_vault.${L}.name}`,
      secret_uri: `\${azurerm_key_vault.${L}.vault_uri}secrets/${secretName}`,
    }),
  });
}

/* --------------------------------- observe ---------------------------------- */

const VERSIONS_API = API.keyVaultData;

export const expectedKeyVault = (): Record<string, unknown> => ({ rbacAuthorization: true, purgeProtection: true, softDeleteDays: 90, sku: "standard" });

export const keyVaultSecretDriver = defineAzureDriver({
  id: "azure.key_vault_secret@1",
  kind: "secret",
  nativeType: "azure:key_vault_secret",
  arm: KEY_VAULT,
  compile: compileKeyVaultSecret,
  expected: expectedKeyVault,
  read: (res) => {
    const p = props(res);
    return {
      rbacAuthorization: pick<boolean>(p, "enableRbacAuthorization"),
      purgeProtection: pick<boolean>(p, "enablePurgeProtection") ?? false,
      softDeleteDays: pick<number>(p, "softDeleteRetentionInDays"),
      sku: pick<string>(p, "sku", "name")?.toLowerCase(),
    };
  },
  native: (res) => ({ vaultUri: props(res).vaultUri, accessPolicies: Array.isArray(props(res).accessPolicies) ? (props(res).accessPolicies as unknown[]).length : undefined }),
  checks: async (ctx, node, res) => {
    // Does at least one enabled version of the secret exist? Reads version METADATA only; values are never requested.
    const vaultUri = pick<string>(props(res), "vaultUri");
    const spec = specOf<SecretSpec>(node);
    if (!vaultUri || !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/?$/.test(vaultUri)) return [{ id: "value_present", description: "the secret has a value", passed: "unknown" as const, detail: "vault URI unavailable" }];
    try {
      const r = await sendJson<{ value?: Json[] }>(ctx.session, ctx.signal, "GET", `${vaultUri.replace(/\/$/, "")}/secrets/${kvSecretName(spec.secretRef)}/versions?api-version=${VERSIONS_API}&maxresults=5`);
      const enabled = (r.body.value ?? []).filter((v) => pick<boolean>(v, "attributes", "enabled") !== false).length;
      return [{ id: "value_present", description: "the secret has a value", passed: enabled > 0, detail: `${enabled} enabled version${enabled === 1 ? "" : "s"}` }];
    } catch (e) {
      return [{ id: "value_present", description: "the secret has a value", passed: "unknown" as const, detail: e instanceof Error ? safeText(e.message) : "read failed" }];
    }
  },
});

