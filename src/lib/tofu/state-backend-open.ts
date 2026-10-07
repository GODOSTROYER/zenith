/** One entry point that selects the restore adapter for a backend kind. Anything without an adapter is refused with a reason. */
import type { BackendConfig } from "@/lib/tofu/backend-config";
import { openAzureStateStore, openGcsStateStore, openOciStateStore, type Fetch } from "@/lib/tofu/state-backend-http";
import { openS3StateStore, parseStateCredentials, StateBackendError, type StateBackendStore } from "@/lib/tofu/state-backend-s3";

export async function openStateStore(backend: BackendConfig, region: string, stateKey: string, rawSecret: string, f?: Fetch): Promise<StateBackendStore> {
  switch (backend.kind) {
    case "s3": return typeof backend.endpoint === "string" ? openOciStateStore(backend, stateKey, rawSecret, f) : openS3StateStore(backend, region, stateKey, parseStateCredentials(rawSecret));
    case "gcs": return openGcsStateStore(backend, stateKey, rawSecret, f);
    case "azurerm": return openAzureStateStore(backend, stateKey, rawSecret, f);
    default: throw new StateBackendError("unsupported_backend", `The ${backend.kind} state backend has no restore adapter.`);
  }
}
