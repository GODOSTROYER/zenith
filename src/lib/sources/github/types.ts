/** Non-secret GitHub source identifiers. Tokens exist only inside access callbacks. */
export interface GithubRepository { owner: string; repo: string }
export interface GithubAccessScope extends GithubRepository {
  workspaceId?: string;
  environmentId?: string;
  signal?: AbortSignal;
}
export interface GithubSourceBinding extends GithubRepository {
  workspaceId: string;
  appId: string;
  installationId: number;
  repositoryId: number;
  version: number;
}
export interface GithubAppConfig {
  appId: string;
  privateKeyFile: string;
  clientId?: string;
  clientSecretFile?: string;
}
export class GithubSourceError extends Error {
  constructor(readonly code: "invalid" | "unavailable" | "refused" | "conflict") {
    super({ invalid: "GitHub source input is invalid.", unavailable: "GitHub source access could not be confirmed.", refused: "GitHub source access was refused.", conflict: "GitHub source binding changed; start again." }[code]);
    this.name = "GithubSourceError";
  }
}
export function repository(owner: string, repo: string): GithubRepository {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || [".", ".."].includes(repo)) throw new GithubSourceError("invalid");
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}
export function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new GithubSourceError("invalid");
  return value;
}
export function numericId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new GithubSourceError("invalid");
  return value;
}
