/** Resolve membership in a Postgres scope and persist any accepted invitation. */
import { flushPendingAsync, runInStoreScope } from "@/lib/db/store";
import { destinationAfterAuth } from "@/lib/server/workspace";

export function resolveAuthDestination(next?: string | null): Promise<string> {
  return runInStoreScope(async () => {
    const destination = await destinationAfterAuth(next);
    await flushPendingAsync();
    return destination;
  });
}
