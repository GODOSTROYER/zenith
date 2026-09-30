/**
 * `gcp:log_bucket` — `log_group` on GCP.
 *
 * Decision (documented, deliberate): this driver COMPILES NOTHING. Cloud Run,
 * Cloud SQL, Load Balancing and the other services Zenith deploys already write
 * to Cloud Logging, into the project's `_Default` log bucket, without any
 * per-workload log group to create. A dedicated bucket per workload would need
 * a log sink plus an exclusion on `_Default` to avoid storing every line
 * twice, and editing `_Default`'s sink or retention changes the customer's
 * whole project, not just Zenith's resources. So the fragment is empty and
 * `LogGroupSpec.retentionDays` is honoured as a CHECK, not as configuration:
 *
 *   - `observe` reads `_Default` through the Logging API (`retentionDays`,
 *     lifecycle state);
 *   - `expectedAttributes` is empty (no drift is reported against a setting
 *     Zenith does not manage);
 *   - `verify` passes the retention check when `_Default` retains at least
 *     `retentionDays`, and FAILS it when it retains less, so the gap is visible
 *     rather than silently accepted. Raising the project's retention is the
 *     customer's (or a `provider.native`) decision.
 *
 * Reading logs themselves is the observability source (`observability.ts`).
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { LogGroupSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { contractCapabilities, nameResolver, specOf } from "../../driver-util";
import { makeReaders, num, str, tail, type ReadSpec } from "../../read-kit";
import type { GcpDriverContext } from "../../types";

export const DRIVER_ID = "gcp.log_bucket@1";
const LOGGING = "https://logging.googleapis.com/v2";

const defaultBucket = (ctx: GcpDriverContext): string => `projects/${ctx.session.projectId}/locations/global/buckets/_Default`;

function expectedAttributes(_node: ResourceNode): Record<string, unknown> {
  return {};
}

function compile(_node: ResourceNode, _ctx: CompileContext): TofuFragment {
  return { addresses: [] };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:log_bucket",
  kind: "log_group",
  attributes: ["retentionDays", "lifecycleState"],
  resolve: nameResolver((p) => `projects/${p}/locations/[a-z0-9-]{2,40}/buckets/[A-Za-z0-9_-]{1,100}`, LOGGING, "log bucket"),
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    return {
      externalId: name,
      name: tail(name),
      attributes: { retentionDays: num(o.retentionDays), lifecycleState: str(o.lifecycleState) },
      native: { locked: o.locked === true, analyticsEnabled: o.analyticsEnabled === true },
    };
  },
  checks(node, obs) {
    const want = specOf<LogGroupSpec>(node).retentionDays;
    const have = obs.attributes.retentionDays;
    if (obs.presence !== "present" || typeof want !== "number") return [];
    if (have?.state !== "known" || typeof have.value !== "number") return [{ id: "retention", description: `log retention covers ${want} days`, passed: "unknown", detail: "retention was not read" }];
    const ok = have.value >= want;
    return [
      {
        id: "retention",
        description: `log retention covers ${want} days`,
        passed: ok,
        ...(ok ? {} : { detail: `the project's _Default bucket retains ${have.value} days; Zenith does not change project-wide log retention` }),
      },
    ];
  },
};

const readers = makeReaders(spec, expectedAttributes);

export const logBucketDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "log_group",
  nativeType: "gcp:log_bucket",
  capabilities: contractCapabilities({ compile: true }),
  compile,
  observe: (ctx, node, externalId) => readers.observe(ctx, node, externalId ?? defaultBucket(ctx)),
  verify: readers.verify,
  expectedAttributes,
};
