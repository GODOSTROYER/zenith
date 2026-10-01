/**
 * Registering the Kubernetes provider's drivers under `provider = zenith`, with
 * the tenancy wrapper around every call.
 *
 * The Kubernetes drivers (WS-K8S) are REUSED, not copied: this wrapper takes a
 * `ResourceDriver<KubernetesSession>` and returns a `ResourceDriver<ZenithSession>`
 * that, for every call,
 *   1. asserts the session belongs to the operation's workspace AND environment
 *      (a session for one tenant can never observe or operate another);
 *   2. forces the node into the tenant namespace and rewrites its hosts to
 *      managed hostnames (`zenithNodeView`) — the same view the renderer used,
 *      so observe and expectedAttributes compare like with like;
 *   3. hands the base driver a session whose Kubernetes connection allows ONLY
 *      the tenant namespace, so even a base-driver bug cannot reach beyond it;
 *   4. strips any `namespace` from operation input (the tenant's namespace is
 *      not negotiable) and stamps provenance onto what comes back.
 *
 * Differences from the base driver, all deliberate:
 *   - `compile` is absent: a managed environment is applied by server-side
 *     apply (`applyZenithEnvironment`), not OpenTofu.
 *   - `discover` is absent: a tenant cannot discover or adopt objects in a
 *     shared cluster; everything in its namespace is Zenith's.
 *   - evidence is `contract` for every claim, whatever the base driver
 *     declared: this layer has never run against a managed cluster.
 *
 * `static_site` decision: `static_site` on `zenith` serves through THIS path (a
 * prebuilt static-server image as a Deployment + Service + HTTPRoute), not
 * through `src/lib/hosted`. See docs/platform/MANAGED-PLATFORM.md,
 * "static_site and the hosted-apps subsystem", for why.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { DriverContext, NativeOperation, ResourceDriver } from "@/lib/drivers/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { zenithNodeView } from "../../render";
import type { ZenithSession } from "../../session";
import { contractEvidence, scopedContext } from "../common";

export const zenithDriverId = (nativeType: string): string => `zenith.${nativeType.replace(/^k8s:/, "").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}@1`;

const view = (ctx: DriverContext<ZenithSession>, node: ResourceNode): ResourceNode => zenithNodeView(node, ctx.session.tenant, ctx.session.substrate);

function stamp(o: Observation, id: string, base: string): Observation {
  return { ...o, source: id, native: { ...(o.native ?? {}), delegatedTo: base } };
}

export function wrapKubernetesDriver(base: ResourceDriver<KubernetesSession>): ResourceDriver<ZenithSession> {
  const id = zenithDriverId(base.nativeType);
  const claims = [
    ...(base.capabilities.observe ? ["observe"] : []),
    ...(base.capabilities.runtime ? ["runtime"] : []),
    ...(base.capabilities.verify ? ["verify"] : []),
    ...base.capabilities.operations,
  ];
  const driver: ResourceDriver<ZenithSession> = {
    id,
    provider: "zenith",
    kind: base.kind,
    nativeType: base.nativeType,
    capabilities: {
      compile: false,
      observe: base.capabilities.observe,
      runtime: base.capabilities.runtime,
      verify: base.capabilities.verify,
      discover: false,
      operations: [...base.capabilities.operations],
      evidence: contractEvidence(claims),
    },
  };
  if (base.observe) {
    const observe = base.observe.bind(base);
    driver.observe = async (ctx, node, externalId) => stamp(await observe(scopedContext(ctx), view(ctx, node), externalId), id, base.id);
  }
  if (base.runtime) {
    const runtime = base.runtime.bind(base);
    driver.runtime = async (ctx, node, externalId) => ({ ...(await runtime(scopedContext(ctx), view(ctx, node), externalId)), source: id });
  }
  if (base.verify) {
    const verify = base.verify.bind(base);
    driver.verify = async (ctx, node, observation, runtime) => verify(scopedContext(ctx), view(ctx, node), observation, runtime);
  }
  if (base.expectedAttributes) {
    const expected = base.expectedAttributes.bind(base);
    // no session here, so no tenant: the attributes that matter do not depend on the namespace or hosts
    driver.expectedAttributes = (node) => expected(node);
  }
  if (base.operations) {
    const ops: Record<string, NativeOperation<ZenithSession>> = {};
    for (const [name, op] of Object.entries(base.operations)) {
      ops[name] = async (ctx, node, input) => {
        const rest: Record<string, unknown> = { ...input };
        delete rest.namespace;
        return op(scopedContext(ctx), view(ctx, node), rest);
      };
    }
    driver.operations = ops;
  }
  return driver;
}
