/**
 * Choosing the managed-database provider for a substrate. Kept apart from the
 * port (`database.ts`) so the port does not import its own adapters.
 * The vault composition binds provider operations to one tenant and managed
 * Postgres address set. Neon remains contract-tested, never live-verified.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { asyncSecretsBackend, type AsyncSecretsBackend } from "@/lib/secrets/backend";
import { createConnectionSecretSink, createSecretResolver } from "@/lib/secrets/resolver";
import type { SecretTenant } from "@/lib/secrets/delivery";
import { DATABASE_UNCONFIGURED_REASON, dbError, unavailableDatabaseProvider, type DatabaseProviderDeps, type DatabaseTarget, type ManagedDatabaseProvider } from "./database";
import { createNeonProvider } from "./neon";
import type { ZenithSubstrate } from "./substrate";
import { ZenithError } from "./types";

/** The Neon adapter when the substrate configures one, `unavailable` (naming the variables to set) when it does not. */
export function createManagedDatabaseProvider(substrate: ZenithSubstrate, deps: DatabaseProviderDeps): ManagedDatabaseProvider {
  if (!substrate.database) return unavailableDatabaseProvider(DATABASE_UNCONFIGURED_REASON);
  return createNeonProvider(substrate.database, deps);
}

/**
 * Pair the Neon sink and workload resolver over the same encrypted vault scope.
 * Pass `databases` to openZenithSession and `resolveSecret` to applyZenithEnvironment;
 * apply already awaits database convergence before any workload writes.
 * The injected resolver reads only platform API credentials. It is never exposed
 * to workloads, whose resolver enforces workspace/project/environment boundaries.
 */
export function createVaultDatabaseRuntime(
  input: SecretTenant & { substrate: ZenithSubstrate; nodes: readonly ResourceNode[] },
  deps: Omit<DatabaseProviderDeps, "sink"> & { backend?: AsyncSecretsBackend }
): { databases: ManagedDatabaseProvider; resolveSecret: (ref: string) => Promise<string | undefined> } {
  const resourceAddresses = input.nodes.filter((node) => node.provider === "zenith" && node.ownership === "managed" && node.kind === "postgres").map((node) => node.address);
  const scope = { workspaceId: input.workspaceId, projectId: input.projectId, environmentId: input.environmentId, resourceAddresses };
  const backend = deps.backend ?? asyncSecretsBackend();
  const provider = createManagedDatabaseProvider(input.substrate, {
    fetch: deps.fetch,
    resolveSecret: deps.resolveSecret,
    timeoutMs: deps.timeoutMs,
    sink: createConnectionSecretSink(scope, backend),
  });
  const matches = (target: Pick<DatabaseTarget, "environmentId" | "address">) =>
    target.environmentId === scope.environmentId && resourceAddresses.includes(target.address);
  const matchesTenant = (target: DatabaseTarget) => target.workspaceId === scope.workspaceId && matches(target);
  const denied = () => dbError("forbidden", "The managed database target is outside this vault scope.", false);
  const databases: ManagedDatabaseProvider = {
    id: provider.id,
    availability: () => provider.availability(),
    create: (spec, options) => matchesTenant(spec) ? provider.create(spec, options) : Promise.resolve(denied()),
    get: (target, options) => matchesTenant(target) ? provider.get(target, options) : Promise.resolve(denied()),
    delete: (target, options) => matchesTenant(target) ? provider.delete(target, options) : Promise.resolve(denied()),
    connectionSecretRef: (target) => {
      if (!matches(target)) throw new ZenithError("tenant_mismatch", "The managed database reference is outside this vault scope.");
      return provider.connectionSecretRef(target);
    },
  };
  return { databases, resolveSecret: createSecretResolver(scope, backend) };
}
