/**
 * MySQL bootstrap credentials: generate ephemerally, persist via value_wo in
 * the existing per-resource Key Vault, then read that exact version with an
 * ephemeral resource. Retrying a partial apply or replacing the server uses
 * the stored password, never a newly generated value unrelated to the vault.
 * The vault is owned by the MySQL node, so environment secret sync cannot
 * overwrite it. No password is exported as a local/output or read by Zenith.
 * Schema support is documented in AzureRM 5.7.0; live Azure is unverified.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { block, mergeBlocks } from "@/lib/providers/azure/compile-util";
import { exportRef } from "@/lib/providers/azure/exports";
import { cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { compileKeyVaultSecret, kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";

export function mysqlBootstrap(node: ResourceNode, ctx: CompileContext) {
  const secretRef = `vault:generated/${ctx.environmentId}/${node.address}/password`;
  // Reuse the existing vault naming, tags, RBAC and retention policy. It is
  // part of this node's fragment, not a separately synced environment secret.
  const vault = compileKeyVaultSecret({ ...node, kind: "secret", spec: { secretRef, store: "zenith_vault", purpose: "environment" } }, ctx);
  // A secret node named "db" may already own <prefix>-db-kv. Keep this
  // bootstrap vault's cloud name distinct while retaining the node's tags.
  const vaultBody = vault.resource!.azurerm_key_vault[tfLabel(node.address, "kv")];
  vaultBody.name = cloudName(ctx, node.address, { max: 24, suffix: "mysql-kv" });
  const label = tfLabel(node.address, "bootstrap");
  const stored = `azurerm_key_vault_secret.${label}`;
  const name = kvSecretName(secretRef);
  const ephemeral: NonNullable<TofuFragment["ephemeral"]> = {
    random_password: { [label]: { length: 32, special: true, override_special: "!#$%&*()-_=+", min_lower: 1, min_upper: 1, min_numeric: 1, min_special: 1 } },
    azurerm_key_vault_secret: { [label]: { name, key_vault_id: exportRef(node.address, "vault_id"), version: `\${${stored}.version}` } },
  };
  return {
    resource: mergeBlocks(vault.resource ?? {}, block("azurerm_key_vault_secret", label, {
      name, key_vault_id: exportRef(node.address, "vault_id"),
      value_wo: `\${ephemeral.random_password.${label}.result}`,
      value_wo_version: 1,
      lifecycle: { prevent_destroy: true },
    })),
    ephemeral,
    locals: vault.locals ?? {},
    server: {
      administrator_login: "zenith_admin",
      administrator_password_wo: `\${ephemeral.azurerm_key_vault_secret.${label}.value}`,
      // A public version marker triggers an update if the stored secret is
      // recovered/recreated. 48 bits fit exactly in JS and the provider int.
      administrator_password_wo_version: `\${parseint(substr(sha256(${stored}.version), 0, 12), 16) + 1}`,
    },
  };
}
