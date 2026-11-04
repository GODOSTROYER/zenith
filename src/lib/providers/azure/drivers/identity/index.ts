import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { identityDriver } from "@/lib/providers/azure/drivers/identity/identity";
import { keyVaultSecretDriver } from "@/lib/providers/azure/drivers/identity/key-vault-secret";

/** Identity group: workload identities with role assignments, Key Vault secrets. */
export const identityDrivers: ResourceDriver<AzureSession>[] = [identityDriver, keyVaultSecretDriver];
