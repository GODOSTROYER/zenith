/** Composition root for operator continuation after a restore (PROD-OPS-04): the platform store plus the broker's role resolver. */
import { platformBroker } from "@/lib/capabilities/platform";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { ROLE_RANK } from "@/lib/capabilities/ports";
import { platformDb } from "@/lib/controlplane/db";
import { ensurePlatformApp } from "./app";
import { createPlatformRecovery, type PlatformRecovery } from "./recovery-service";

type G = typeof globalThis & { __zenithRecovery?: Promise<PlatformRecovery> };

export function platformRecovery(): Promise<PlatformRecovery> {
  const g = globalThis as G;
  g.__zenithRecovery ??= build().catch((e) => {
    delete g.__zenithRecovery;
    throw e;
  });
  return g.__zenithRecovery;
}

/** Test isolation only. */
export function resetPlatformRecoveryForTests(): void {
  delete (globalThis as G).__zenithRecovery;
}

async function build(): Promise<PlatformRecovery> {
  if (!(await ensurePlatformApp())) throw new BrokerError("platform_store_unavailable", "The platform store is not configured; recovery is unavailable.");
  const [db, broker] = await Promise.all([platformDb(), platformBroker()]);
  return createPlatformRecovery({
    db,
    async authorize(principal, workspaceId, need) {
      const access = await broker.deps.roles.resolve(principal, workspaceId);
      if (access.role === "none") throw notFound();
      if (ROLE_RANK[access.role] < ROLE_RANK[need]) throw new BrokerError("role_insufficient", `This needs the ${need} role in this workspace.`);
      if (principal.kind === "integration" && !access.integrationScopes?.includes(need === "viewer" ? "read" : "write")) throw new BrokerError("role_insufficient", "This credential lacks the scope for that.");
    },
  });
}

export { createPlatformRecovery, type PlatformRecovery } from "./recovery-service";
