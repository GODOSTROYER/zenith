/**
 * `object_store` on the managed platform: UNSUPPORTED, on purpose.
 *
 * The design the task describes is a key prefix per tenant inside one shared
 * S3-compatible bucket, with per-tenant credentials. The prefix derivation is
 * implemented and tested (`tenantObjectPrefix`). The credential half is not:
 * a prefix is only an isolation boundary if the credential a tenant's workload
 * holds cannot read or write outside it. That needs one of
 *   - an STS-style service that mints short-lived credentials scoped by a
 *     session policy to `<bucket>/<prefix>*`, reachable from the tenant's pod
 *     through workload identity (a projected, audience-bound service account
 *     token — which the restricted tenancy baseline deliberately does not
 *     mount today), or
 *   - a per-tenant IAM user/key created and rotated by the platform.
 * Neither exists. Handing every tenant the platform's bucket credential would
 * make the "prefix" a naming convention, not isolation, and one workspace could
 * read another's data. So this driver refuses, says why, and never pretends.
 *
 * It is still registered, so a node that reaches it gets a precise answer
 * instead of a missing-driver error: observe is `unknown` with the reason,
 * verify is `failed` with the reason, and nothing is ever created or read.
 *
 * Registered under the contract table's `zenith:object_store` type so expanded
 * nodes reach this explicit refusal. A native mapping is vocabulary, never
 * a claim that the service has been implemented or verified.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import { assertSessionMatches, type ZenithSession } from "../../session";
import { tenantObjectPrefix } from "../../substrate";
import { contractEvidence, observation, unknownValue } from "../common";

export const OBJECT_STORE_DRIVER_ID = "zenith.object_store@1";
/** Retained export for compatibility; this is now the accepted contract value. */
export const PROPOSED_OBJECT_STORE_NATIVE_TYPE = "zenith:object_store";

export const OBJECT_STORE_UNSUPPORTED_REASON =
  "Object storage is not offered on the Zenith-managed platform yet: isolating tenants in a shared bucket needs per-tenant, prefix-scoped credentials (STS with workload identity, or per-tenant keys), which the platform does not have. Sharing one credential would let a workspace read another's data.";

export function createObjectStoreDriver(nativeType: string): ResourceDriver<ZenithSession> {
  const id = OBJECT_STORE_DRIVER_ID;
  const reasonFor = (session: ZenithSession): string =>
    session.substrate.objectStorage
      ? OBJECT_STORE_UNSUPPORTED_REASON
      : `${OBJECT_STORE_UNSUPPORTED_REASON} Object storage is also not configured (ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT, ZENITH_MANAGED_OBJECT_STORAGE_BUCKET).`;

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
      const reserved = tenantObjectPrefix(ctx.session.tenant, ctx.session.substrate);
      return observation({
        ctx,
        node,
        source: id,
        presence: "unknown",
        attributes: { provisioned: unknownValue("not_supported", "object storage is not offered on the managed platform") },
        native: { supported: false, ...(reserved ? { reservedPrefix: reserved.prefix } : {}) },
        error: reasonFor(ctx.session),
      });
    },

    async verify(ctx, node) {
      assertSessionMatches(ctx.session, ctx);
      return {
        address: node.address,
        status: "failed",
        checks: [{ id: "supported", description: "object storage is offered on the managed platform", passed: false, detail: reasonFor(ctx.session) }],
        checkedAt: ctx.now().toISOString(),
        simulated: false,
      };
    },

    expectedAttributes() {
      return {};
    },
  };
}
