/**
 * Selects the restore adapter for a brokered provider session. The session is the only source of credentials: its provider
 * must match the backend kind. Anything without an adapter is refused with a reason (Azure Blob and OCI Object Storage included).
 */
import type { BackendConfig } from "@/lib/tofu/backend-config";
import type { ProviderSession } from "@/lib/credentials/types";
import { gcsStoreFromSession } from "@/lib/tofu/state-backend-gcs";
import { s3StoreFromSession, StateBackendError, type StateBackendStore } from "@/lib/tofu/state-backend-s3";

export async function openStateStoreFromSession(session: ProviderSession, backend: BackendConfig, region: string, stateKey: string): Promise<StateBackendStore> {
  if (session.provider === "aws" && backend.kind === "s3") return s3StoreFromSession(session, backend, region, stateKey);
  if (session.provider === "gcp" && backend.kind === "gcs") return gcsStoreFromSession(session, backend, stateKey);
  throw new StateBackendError("unsupported_backend", `A ${session.provider} session has no restore adapter for the ${backend.kind} state backend.`);
}
