/**
 * Choosing the managed-database provider for a substrate. Kept apart from the
 * port (`database.ts`) so the port does not import its own adapters.
 */
import { DATABASE_UNCONFIGURED_REASON, unavailableDatabaseProvider, type DatabaseProviderDeps, type ManagedDatabaseProvider } from "./database";
import { createNeonProvider } from "./neon";
import type { ZenithSubstrate } from "./substrate";

/** The Neon adapter when the substrate configures one, `unavailable` (naming the variables to set) when it does not. */
export function createManagedDatabaseProvider(substrate: ZenithSubstrate, deps: DatabaseProviderDeps): ManagedDatabaseProvider {
  if (!substrate.database) return unavailableDatabaseProvider(DATABASE_UNCONFIGURED_REASON);
  return createNeonProvider(substrate.database, deps);
}
