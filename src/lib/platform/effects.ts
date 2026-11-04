/**
 * Composition root for external-effect resolution (PROD-DUR-07 / PROD-DUR-08).
 *
 * Existing pieces only:
 *  - store      the platform control store (`platform.external_effects`)
 *  - readback   AWS: a read-only reconcile observation session (`composeReconcilePorts().withObserveSession`),
 *               which asks the capability broker for `infrastructure.observe` under the reconciler principal
 *               and opens an `observe` credential session for the effect's verified connection.
 *               Cleanup: Zenith's own reconcile observations (`platform.resource_observations`).
 *               Other providers: no independent readback exists, and the effect says so.
 *  - roles      the capability broker's role resolver, asked on every call
 *  - approval   a signed-in human in the browser (`assertBrowserSession`, same-origin, identity verified live),
 *               an admin, deciding on the exact binding digest of this effect version and its readback
 *
 * Nothing here retries an effect. Readback is read-only; resolution only changes the ledger.
 */
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import type { Sql } from "@/lib/controlplane/types";
import { platformBroker } from "@/lib/capabilities/platform";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { ROLE_RANK } from "@/lib/capabilities/ports";
import { platformDb, repos } from "@/lib/controlplane/db";
import { loadPlatformEnvironment } from "@/lib/reconcile/platform";
import type { AwsSession } from "@/lib/credentials/types";
import type { EffectRecord } from "@/lib/effects/types";
import { ResolverRegistry, cleanupObservationResolver } from "@/lib/effects/readback";
import { awsBuildLaunchResolver } from "@/lib/effects/resolvers/aws-codebuild";
import { gcpBuildLaunchResolver } from "@/lib/effects/resolvers/gcp-cloudbuild";
import { azureBuildLaunchResolver } from "@/lib/effects/resolvers/azure-acr";
import { proxyRequestHintResolver } from "@/lib/effects/proxy";
import type { GcpSession, AzureSession as AzureSessionType } from "@/lib/credentials/types";
import { createPlatformEffects, type PlatformEffects } from "./effects-service";
import { platformCredentialBroker } from "./credentials";
import { composeReconcilePorts } from "./reconcile";
import { ensurePlatformApp } from "./app";

type G = typeof globalThis & { __zenithEffects?: Promise<PlatformEffects> };

export function platformEffects(): Promise<PlatformEffects> {
  const g = globalThis as G;
  g.__zenithEffects ??= build().catch((e) => {
    delete g.__zenithEffects;
    throw e;
  });
  return g.__zenithEffects;
}

/** Test isolation only. */
export function resetPlatformEffectsForTests(): void {
  delete (globalThis as G).__zenithEffects;
}

/** Resolvers over an explicit store; the platform composition and the tests share this. */
export function createEffectResolvers(db: Sql, sessions: {
  aws?: { withClient: Parameters<typeof awsBuildLaunchResolver>[0]["withClient"] };
  gcp?: { withSession: Parameters<typeof gcpBuildLaunchResolver>[0]["withSession"] };
  azure?: { withSession: Parameters<typeof azureBuildLaunchResolver>[0]["withSession"] };
} = {}): ResolverRegistry {
  const registry = new ResolverRegistry();
  // Mutating requests sent through runner HTTP proxies have no generic independent read; the readback names what to read.
  registry.add(proxyRequestHintResolver());
  if (sessions.gcp) registry.add(gcpBuildLaunchResolver(sessions.gcp));
  if (sessions.azure) registry.add(azureBuildLaunchResolver(sessions.azure));
  const aws = sessions.aws;
  if (aws) {
    registry.add(awsBuildLaunchResolver({
      withClient: aws.withClient,
      async otherBuildIds(effect) {
        const owned = await db.query<{ id: string | null }>(
          `select provider_receipt->>'resourceId' as id from platform.external_effects
            where workspace_id = $1 and family = 'build_launch' and provider = 'aws' and effect_id <> $2 and provider_receipt is not null
           union
           select build_id as id from platform.build_launches where workspace_id = $1 and build_id is not null`,
          [effect.workspaceId, effect.effectId]
        );
        return new Set(owned.map((r) => r.id).filter((v): v is string => !!v));
      },
    }));
  }
  registry.add(cleanupObservationResolver({
    async reviewedAddresses(effect) {
      const planDigest = effect.target.planDigest;
      const rows = await repos.evidence.list(db, effect.workspaceId, { operationId: effect.operationId, limit: 200 });
      const plan = rows.find((r) => r.kind === "tofu_plan" && !r.simulated && r.digest === planDigest && Array.isArray(r.summary.destroyAddresses));
      return plan ? (plan.summary.destroyAddresses as unknown[]).filter((a): a is string => typeof a === "string") : undefined;
    },
    async latestObservations(workspaceId, environmentId) {
      return (await repos.observations.latestObservationsByEnvironment(db, workspaceId, environmentId))
        .map((o) => ({ address: o.address, presence: o.presence === "present" || o.presence === "missing" ? o.presence : "unknown" as const, observedAt: o.observedAt, simulated: o.simulated }));
    },
  }));
  return registry;
}

async function build(): Promise<PlatformEffects> {
  if (!(await ensurePlatformApp())) throw new BrokerError("platform_store_unavailable", "The platform store is not configured; effects are unavailable.");
  const db = await platformDb();
  const broker = await platformBroker();
  const credentials = platformCredentialBroker(db);
  const reconcile = composeReconcilePorts(db, credentials);
  /** One read-only observe session (the reconciler's `infrastructure.observe` read grant) for the effect's environment. */
  const observed = <T>(effect: EffectRecord, provider: "aws" | "gcp" | "azure", signal: AbortSignal, fn: (session: unknown, region: string) => Promise<T>): Promise<T> => {
    const environmentId = effect.environmentId, region = effect.target.region;
    if (!environmentId || typeof region !== "string") throw new Error("effect_not_readable");
    return loadPlatformEnvironment(db, effect.workspaceId, environmentId).then((env) => {
      if (!env || env.provider !== provider || env.region !== region || !env.connection || env.connection.status !== "verified") throw new Error("connection_unavailable");
      return reconcile.withObserveSession({ workspaceId: effect.workspaceId, projectId: env.projectId, environmentId, provider, region, connectionId: env.connection.id, correlationId: `effect-${effect.effectId}`.slice(0, 120), signal }, (session) => fn(session, region));
    });
  };
  const registry = createEffectResolvers(db, {
    aws: { withClient: (effect, signal, fn) => observed(effect, "aws", signal, async (session, region) => {
      const aws = session as AwsSession;
      if (aws.provider !== "aws" || aws.accountId !== effect.target.accountId || aws.region !== region) throw new Error("session_mismatch");
      return fn(aws.client(CodeBuildClient));
    }) },
    gcp: { withSession: (effect, signal, fn) => observed(effect, "gcp", signal, async (session) => {
      const gcp = session as GcpSession;
      if (gcp.provider !== "gcp") throw new Error("session_mismatch");
      return fn(gcp);
    }) },
    azure: { withSession: (effect, signal, fn) => observed(effect, "azure", signal, async (session) => {
      const az = session as AzureSessionType;
      if (az.provider !== "azure") throw new Error("session_mismatch");
      return fn(az);
    }) },
  });
  return createPlatformEffects({
    db, registry,
    async authorize(principal, workspaceId, need) {
      const access = await broker.deps.roles.resolve(principal, workspaceId);
      // A non-member and a foreign workspace are the same 404; a member below the needed role is told so.
      if (access.role === "none") throw notFound();
      if (ROLE_RANK[access.role] < ROLE_RANK[need]) throw new BrokerError("role_insufficient", `This needs the ${need} role in this workspace.`);
      if (principal.kind === "integration" && !access.integrationScopes?.includes(need === "viewer" ? "read" : "write")) throw new BrokerError("role_insufficient", "This credential lacks the scope for that.");
    },
  });
}


export { createPlatformEffects, type PlatformEffects } from "./effects-service";
