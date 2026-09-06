/** Browser-safe secret-reference helpers. No store, crypto, filesystem or env imports. */
export const VAULT_PREFIX = "vault:";

export const isVaultRef = (ref: string): boolean => ref.startsWith(VAULT_PREFIX);

export function vaultRef(projectId: string, serviceId: string, key: string): string {
  return `${VAULT_PREFIX}${projectId}/${serviceId}/${key}`;
}

export interface VaultRefParts {
  key: string;
  projectId?: string;
  serviceId?: string;
  legacy: boolean;
}

export function parseVaultRef(ref: string): VaultRefParts | undefined {
  if (!isVaultRef(ref)) return undefined;
  const parts = ref.slice(VAULT_PREFIX.length).split("/");
  if (parts.length === 1) return { key: parts[0], legacy: true };
  if (parts.length === 3)
    return { projectId: parts[0], serviceId: parts[1], key: parts[2], legacy: false };
  return { key: parts[parts.length - 1], legacy: false };
}
