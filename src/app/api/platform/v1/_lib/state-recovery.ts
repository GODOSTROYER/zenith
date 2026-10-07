/** Composition of the state recovery service over the platform store, broker roles and workspace vault. */
import { platformBroker } from "@/lib/capabilities/platform";
import { platformDb, repos } from "@/lib/controlplane/db";
import { readSecretValueAsync } from "@/lib/secrets";
import { createStateRecovery, type StateRecovery } from "@/lib/platform/state-recovery";

export async function stateRecoveryService(): Promise<StateRecovery> {
  const [broker, db] = await Promise.all([platformBroker(), platformDb()]);
  return createStateRecovery({
    db, roles: broker.deps.roles,
    connection: (workspaceId, id) => repos.connections.get(db, workspaceId, id),
    secret: (workspaceId, ref) => readSecretValueAsync(workspaceId, ref),
  });
}
