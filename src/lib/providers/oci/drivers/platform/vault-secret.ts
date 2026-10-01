/**
 * `oci:vault_secret` — portable `secret` on OCI: a Vault secret CONTAINER.
 *
 * What compiles: an `oci_vault_secret` in the customer's `zenith-vault`,
 * encrypted with `zenith-secrets-key` (both looked up by name, see
 * vault-lookup.ts). OCI cannot create an empty secret, so the container is born
 * with an AUTO-GENERATED placeholder (`enable_auto_generation`, a random
 * passphrase nobody sees). The real value is written later by the sync helper
 * (`ops/secret-sync.ts`, capability `secret.write`) as a new CURRENT version.
 * `lifecycle.ignore_changes` keeps OpenTofu from ever reconciling content, so
 * NO secret value is in configuration, plan or state.
 *
 * Only `vault:` (Zenith-store) refs are managed. A `referenced` secret (an OCI
 * secret the customer owns) compiles to nothing and is read by OCID.
 *
 * Observe never reads a secret BUNDLE (the value); it reads secret metadata
 * (`/secrets/{id}`): state and `currentVersionNumber`. `value_synced` (version
 * ≥ 2) means "something beyond the placeholder was written", not "the value is
 * right" — Zenith cannot know that without reading the secret.
 *
 * Destroying a secret schedules deletion (OCI keeps it 1–30 days), so there is
 * no `prevent_destroy`: the value is recoverable from Zenith's own vault.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, cloudName, interp, nameOf, zenithTags } from "../../naming";
import { asNumber, asRecord, asString, attributesOf, discoverWith, locate, observationOf, verifyWith, type OciContext } from "../../observe-kit";
import { secretLocateDef, syncSecretValue } from "../../ops/secret-sync";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { vaultLookup } from "../../vault-lookup";
import { addressList, isManaged, readOnlyFragment, res } from "../shared";

export const SECRET_NATIVE_TYPE = "oci:vault_secret";
const ID = ociDriverId(SECRET_NATIVE_TYPE);

export function compileVaultSecret(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const secret = res("oci_vault_secret", node);
  const lookup = vaultLookup(ctx, node);
  return {
    data: lookup.data,
    resource: {
      oci_vault_secret: {
        [secret.label]: {
          compartment_id: compartmentOf(ctx),
          vault_id: lookup.vaultId,
          key_id: lookup.keyId,
          secret_name: cloudName(ctx.namePrefix, nameOf(node.address), 255),
          description: "Zenith secret container; the value is written by the control plane, never by OpenTofu.",
          enable_auto_generation: true,
          secret_generation_context: { generation_type: "PASSPHRASE", generation_template: "SECRETS_DEFAULT_PASSWORD", passphrase_length: 32 },
          freeform_tags: zenithTags(ctx, node),
          lifecycle: { ignore_changes: ["secret_content", "enable_auto_generation", "secret_generation_context", "metadata"] },
        },
      },
    },
    locals: { [auxName(node.address, "id")]: interp(`${secret.address}.id`) },
    output: { [`${secret.label}_id`]: { value: interp(`${secret.address}.id`), description: `OCID of the Vault secret container for ${node.address} (a reference, not a value)` } },
    addresses: addressList(secret.address, lookup.addresses),
  };
}

export const vaultSecretExpected = (_node: ResourceNode): Record<string, unknown> => ({});

export async function observeVaultSecret(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, secretLocateDef);
  if (located.presence !== "present" || !located.item || !located.externalId) return observationOf(ctx, node, ID, located);
  let item = located.item;
  if (asNumber(item.currentVersionNumber) === undefined) {
    // list summaries omit the version number; read the secret's METADATA (never its bundle)
    const r = await ociCall(ctx, { service: "vault", region: node.region || ctx.region, method: "GET", path: ociPath("vault", "secrets", located.externalId) });
    if (r.requestId) located.requestIds.push(r.requestId);
    if (r.ok && asRecord(r.body)) item = asRecord(r.body)!;
  }
  const version = asNumber(item.currentVersionNumber);
  const at = ctx.now().toISOString();
  const attributes = attributesOf(at, { valueSynced: version === undefined ? undefined : version >= 2, lifecycleState: asString(item.lifecycleState) });
  return observationOf(ctx, node, ID, located, attributes, { lifecycleState: item.lifecycleState, currentVersionNumber: version ?? null, secretName: item.secretName });
}

export const vaultSecretDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "secret",
  nativeType: SECRET_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true, operations: ["secret.write"] }),
  compile: compileVaultSecret,
  observe: observeVaultSecret,
  expectedAttributes: vaultSecretExpected,
  verify: async (ctx, node, observation) => {
    const synced = observation.attributes.valueSynced;
    return verifyWith({
      node,
      observation,
      expected: vaultSecretExpected(node),
      now: ctx.now(),
      extra: [
        {
          id: "value_synced",
          description: "a Zenith-written value exists (version beyond the generated placeholder)",
          passed: !synced || synced.state !== "known" ? "unknown" : synced.value === true,
          ...(synced && synced.state === "known" && synced.value !== true ? { detail: "only the auto-generated placeholder exists; run secret.write" } : {}),
        },
      ],
    });
  },
  discover: (ctx) =>
    discoverWith(ctx, {
      ...secretLocateDef,
      kind: "secret",
      nativeType: SECRET_NATIVE_TYPE,
      nameOf: (i) => asString(i.secretName) ?? asString(i.id) ?? "secret",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "" }),
    }),
  operations: {
    /**
     * Input: `{ resolveValue: () => string | Promise<string> }`. A closure, never a
     * `value` property, so the value cannot land in serialized operation input.
     */
    "secret.write": async (ctx, node, input) => {
      if ("value" in input) return { ok: false, simulated: false, summary: "Pass resolveValue(), not a value: secret values must not travel in operation input." };
      const resolve = input.resolveValue;
      if (typeof resolve !== "function") return { ok: false, simulated: false, summary: "secret.write needs a resolveValue() function." };
      return syncSecretValue(ctx, {
        node,
        resolveValue: resolve as () => Promise<string> | string,
        idempotencyKey: ctx.operationId ?? "",
      });
    },
  },
};
