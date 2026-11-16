/**
 * `object_store` on the managed platform.
 *
 * Two modes, chosen per call from the substrate and the session, never from a flag a caller can flip:
 *
 * 1. SCOPED (PROD-MAN-03): the substrate holds an IAM-admin credential reference
 *    (`ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF`) and the session carries the provisioning ports. Each object store
 *    is the key prefix `<prefixRoot>/<workspace>/<environment>/<store>/` of the shared bucket, reachable only with a credential
 *    scoped to exactly that prefix by its own principal and inline policy (`@/lib/managed-serving/storage`). `observe` reads
 *    the recorded active key, the provider's key list and the provider's current policy digest; `verify` demands that the
 *    credential exists at the provider and that the policy the provider holds IS the scoped policy for this prefix. Nothing
 *    here reads or lists tenant objects, and no key or secret value is ever read into an observation.
 *
 * 2. UNSUPPORTED (otherwise, exactly as before): without per-tenant credentials a prefix is a naming convention, not isolation,
 *    and handing every tenant the platform bucket credential would let one workspace read another's data. The driver says so
 *    and never pretends: observe is `unknown` with the reason, verify is `failed` with the reason, nothing is created or read.
 *
 * Registered under the contract table's `zenith:object_store` type. A native mapping is vocabulary, never a claim that the
 * service has been implemented or verified; evidence stays `contract`.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import { storageIntentFromNode } from "@/lib/managed-serving/storage";
import { assertSessionMatches, type ZenithSession } from "../../session";
import { tenantObjectPrefix } from "../../substrate";
import { contractEvidence, known, observation, unknownValue, verifyAgainst } from "../common";

export const OBJECT_STORE_DRIVER_ID = "zenith.object_store@1";
/** Retained export for compatibility; this is now the accepted contract value. */
export const PROPOSED_OBJECT_STORE_NATIVE_TYPE = "zenith:object_store";

export const OBJECT_STORE_UNSUPPORTED_REASON =
  "Object storage is not offered on the Zenith-managed platform yet: isolating tenants in a shared bucket needs per-tenant, prefix-scoped credentials (STS with workload identity, or per-tenant keys), which the platform does not have. Sharing one credential would let a workspace read another's data.";

const EXPECTED = { provisioned: true, scoped: true, credentialActive: true } as const;

export function createObjectStoreDriver(nativeType: string): ResourceDriver<ZenithSession> {
  const id = OBJECT_STORE_DRIVER_ID;
  const reasonFor = (session: ZenithSession): string =>
    session.substrate.objectStorage
      ? OBJECT_STORE_UNSUPPORTED_REASON
      : `${OBJECT_STORE_UNSUPPORTED_REASON} Object storage is also not configured (ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT, ZENITH_MANAGED_OBJECT_STORAGE_BUCKET).`;
  const scopedMode = (session: ZenithSession): boolean => session.substrate.objectStorage?.adminCredentialRef !== undefined && session.storage !== undefined;

  return {
    id,
    provider: "zenith",
    kind: "object_store",
    nativeType,
    capabilities: {
      compile: false,
      observe: true,
      runtime: false,
      verify: true,
      discover: false,
      operations: [],
      evidence: contractEvidence(["observe", "verify"]),
    },

    async observe(ctx, node) {
      assertSessionMatches(ctx.session, ctx);
      const { session } = ctx;
      if (!scopedMode(session)) {
        const reserved = tenantObjectPrefix(session.tenant, session.substrate);
        return observation({
          ctx,
          node,
          source: id,
          presence: "unknown",
          attributes: { provisioned: unknownValue("not_supported", "object storage is not offered on the managed platform") },
          native: { supported: false, ...(reserved ? { reservedPrefix: reserved.prefix } : {}) },
          error: reasonFor(session),
        });
      }
      const ports = session.storage!;
      let intent;
      try {
        intent = storageIntentFromNode(session.tenant, session.substrate, node);
      } catch (error) {
        return observation({ ctx, node, source: id, presence: "unknown", error: error instanceof Error ? error.message : "The object store could not be derived." });
      }
      const availability = ports.admin.availability();
      if (!availability.available) return observation({ ctx, node, source: id, presence: "unknown", native: { prefix: intent.prefix }, error: availability.reason });
      try {
        const active = await ports.store.active(node.address);
        if (!active) return observation({ ctx, node, source: id, presence: "missing", native: { prefix: intent.prefix } });
        const [keys, digest] = await Promise.all([
          ports.admin.listAccessKeys(intent.principalName, { signal: ctx.signal }),
          ports.admin.readPolicyDigest(intent.principalName, { signal: ctx.signal }),
        ]);
        const now = ctx.now();
        const attributes = {
          provisioned: known(true, now),
          scoped: digest.ok ? known(digest.value === intent.policyDigest && active.policyDigest === intent.policyDigest && active.prefix === intent.prefix, now) : unknownValue("error", digest.error.message),
          credentialActive: keys.ok ? known(keys.value.includes(active.accessKeyId), now) : unknownValue("error", keys.error.message),
        };
        // references and non-secret facts only: no access key id, no secret, no policy body
        return observation({ ctx, node, source: id, presence: "present", externalId: intent.principalName, attributes, native: { bucket: intent.bucket, prefix: intent.prefix, keyIdRef: intent.keyIdRef, secretRef: intent.secretRef } });
      } catch {
        return observation({ ctx, node, source: id, presence: "unknown", error: "The object store's records could not be read." });
      }
    },

    async verify(ctx, node, observed) {
      assertSessionMatches(ctx.session, ctx);
      if (!scopedMode(ctx.session)) {
        return {
          address: node.address,
          status: "failed",
          checks: [{ id: "supported", description: "object storage is offered on the managed platform", passed: false, detail: reasonFor(ctx.session) }],
          checkedAt: ctx.now().toISOString(),
          simulated: false,
        };
      }
      return verifyAgainst(ctx, node, observed, { ...EXPECTED }, []);
    },

    expectedAttributes() {
      return {};
    },
  };
}
