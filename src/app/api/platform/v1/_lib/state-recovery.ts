/** Composition of the state recovery service over the platform store, broker roles and the existing credential broker. */
import { platformBroker } from "@/lib/capabilities/platform";
import { platformDb, repos } from "@/lib/controlplane/db";
import { platformCredentialBroker } from "@/lib/platform/credentials";
import { createStateRecovery, type StateRecovery } from "@/lib/platform/state-recovery";
import { createStateSessionPort } from "@/lib/platform/state-session";

export async function stateRecoveryService(): Promise<StateRecovery> {
  const [broker, db] = await Promise.all([platformBroker(), platformDb()]);
  return createStateRecovery({
    db, roles: broker.deps.roles,
    connection: (workspaceId, id) => repos.connections.get(db, workspaceId, id),
    withSession: createStateSessionPort(platformCredentialBroker(db)),
  });
}
