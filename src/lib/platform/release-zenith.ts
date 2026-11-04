/**
 * Zenith-managed release ports (PROD-MAN-01).
 *
 * A managed environment's workloads ARE Kubernetes workloads in the tenant
 * namespace, so the rollout, readback and migration Job code is the Kubernetes
 * provider's (LIFE-07/LIFE-10), reused unchanged. This adapter does exactly
 * three things and nothing else:
 *   1. lets the managed `ZenithSession` stand in for the Kubernetes session it
 *      carries (`session.kubernetes`, scoped to the tenant namespace only);
 *   2. gives the Kubernetes code the node as the managed platform sees it (the
 *      forced tenant namespace, via `zenithNodeView`), because the stored node
 *      has no namespace of its own;
 *   3. refuses to roll out a BUILT image that is not in THIS tenant's
 *      repositories of the Zenith-operated registry.
 * Source builds are `createZenithBuildPort` (zenith-managed-build.ts).
 */
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError } from "@/lib/execution/errors";
import type { MigrationsPort, WorkloadsPort } from "@/lib/execution/ports";
import { createMigrationsPort } from "@/lib/providers/kubernetes/release/migrations";
import { createWorkloadsPort } from "@/lib/providers/kubernetes/release/workloads";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { zenithNodeView } from "@/lib/providers/zenith/render";
import { assertSessionMatches, type ZenithSession } from "@/lib/providers/zenith/session";
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";

function managedSession(ctx: DriverContext): ZenithSession {
  const session = ctx.session as Partial<ZenithSession> | undefined;
  if (ctx.provider !== "zenith" || session?.provider !== "zenith" || !session.kubernetes || !session.tenant || !session.substrate) {
    throw new StepFailedError("Managed release requires a Zenith-managed session.");
  }
  assertSessionMatches(session as ZenithSession, ctx);
  return session as ZenithSession;
}

/** The Kubernetes provider's view of one managed call: the tenant-scoped Kubernetes session and the namespaced node. */
function kubernetesView(ctx: DriverContext, node: ResourceNode): { ctx: DriverContext; node: ResourceNode } {
  const session = managedSession(ctx);
  if (node.provider !== "zenith" || node.ownership !== "managed") throw new StepFailedError("Managed release requires a managed Zenith workload.");
  const view = zenithNodeView(node, session.tenant, session.substrate);
  return { ctx: { ...ctx, provider: "kubernetes", session: session.kubernetes }, node: { ...view, provider: "kubernetes" } };
}

export function createZenithWorkloadsPort(managed: Pick<ManagedSubstratePort, "registry">): WorkloadsPort {
  const inner = createWorkloadsPort();
  return {
    async deployImage(ctx, node, image, opts) {
      const session = managedSession(ctx);
      const artifact = node.spec.artifact as ArtifactSpec | undefined;
      if (artifact?.type === "built") {
        const registry = managed.registry();
        if (!registry || !registry.ownsPinnedImage(session.tenant, image.uri)) {
          throw new StepFailedError("A built image may only be rolled out from this environment's own repositories on the Zenith-operated registry.");
        }
      }
      const v = kubernetesView(ctx, node);
      return inner.deployImage(v.ctx, v.node, image, opts);
    },
    async waitSteady(ctx, node, opts) {
      const v = kubernetesView(ctx, node);
      return inner.waitSteady(v.ctx, v.node, opts);
    },
    ...(inner.readServing ? { async readServing(ctx: DriverContext, node: ResourceNode) {
      const v = kubernetesView(ctx, node);
      return inner.readServing!(v.ctx, v.node);
    } } : {}),
    // No progressive (canary) rollout on the managed platform: the gateway does not split traffic, so the
    // release layer reports it unsupported by name rather than faking it.
  };
}

export function createZenithMigrationsPort(): MigrationsPort {
  const inner = createMigrationsPort();
  return {
    async runOneOffTask(ctx, node, command, opts) {
      const v = kubernetesView(ctx, node);
      return inner.runOneOffTask(v.ctx, v.node, command, opts);
    },
  };
}
