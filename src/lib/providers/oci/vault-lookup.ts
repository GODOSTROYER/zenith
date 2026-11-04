/**
 * The customer's Vault and master encryption key, found by NAME with data
 * sources.
 *
 * OCI secrets need a `vault_id` and a `key_id`. A KMS vault is a long-lived,
 * slow-to-delete, quota-limited object that belongs to the customer, not to an
 * environment: creating one per secret (or per environment) is wrong. The
 * bootstrap module (deploy/oci) creates ONE vault named `zenith-vault` and ONE
 * AES key named `zenith-secrets-key` in the Zenith compartment; drivers that
 * need them look them up with data sources and fail the plan with a clear
 * message (a `postcondition`) if they are missing or ambiguous.
 *
 * Nothing secret is involved: only OCIDs and endpoints flow through here.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "./context";
import { interp, tfLabel } from "./naming";

export const OCI_VAULT_DISPLAY_NAME = "zenith-vault";
export const OCI_KEY_DISPLAY_NAME = "zenith-secrets-key";

export interface VaultLookup {
  data: NonNullable<TofuFragment["data"]>;
  /** `data.<type>.<label>` addresses, for `TofuFragment.addresses` */
  addresses: string[];
  vaultId: string;
  keyId: string;
}

/** Data sources scoped to `node` (labels carry the node label + `suffix`), plus the expressions that read them. */
export function vaultLookup(ctx: CompileContext, node: ResourceNode, suffix = ""): VaultLookup {
  const compartment = compartmentOf(ctx);
  const base = `${tfLabel(node.address)}${suffix}`;
  const vaults = `${base}_vaults`;
  const keys = `${base}_keys`;
  return {
    data: {
      oci_kms_vaults: {
        [vaults]: {
          compartment_id: compartment,
          filter: [
            { name: "display_name", values: [OCI_VAULT_DISPLAY_NAME] },
            { name: "state", values: ["ACTIVE"] },
          ],
          lifecycle: {
            postcondition: [{ condition: interp("length(self.vaults) == 1"), error_message: `Expected exactly one ACTIVE vault named ${OCI_VAULT_DISPLAY_NAME} in the Zenith compartment; run the deploy/oci bootstrap module.` }],
          },
        },
      },
      oci_kms_keys: {
        [keys]: {
          compartment_id: compartment,
          management_endpoint: interp(`data.oci_kms_vaults.${vaults}.vaults[0].management_endpoint`),
          filter: [
            { name: "display_name", values: [OCI_KEY_DISPLAY_NAME] },
            { name: "state", values: ["ENABLED"] },
          ],
          lifecycle: {
            postcondition: [{ condition: interp("length(self.keys) == 1"), error_message: `Expected exactly one ENABLED key named ${OCI_KEY_DISPLAY_NAME} in the vault; run the deploy/oci bootstrap module.` }],
          },
        },
      },
    },
    addresses: [`data.oci_kms_vaults.${vaults}`, `data.oci_kms_keys.${keys}`],
    vaultId: interp(`data.oci_kms_vaults.${vaults}.vaults[0].id`),
    keyId: interp(`data.oci_kms_keys.${keys}.keys[0].id`),
  };
}
