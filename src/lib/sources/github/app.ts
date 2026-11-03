/**
 * GitHub App HTTP boundary: fixed origins, capped bodies/deadlines, RS256 App JWTs.
 * Keys are read from server files, never cached or included in diagnostics.
 * Installation and OAuth credentials never leave callbacks or enter URLs/state.
 * Mock HTTP contracts are not evidence of a live GitHub installation.
 */
import { createPrivateKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { GithubDiscoveredRepository } from "./store";
import { GithubSourceError, numericId, repository, type GithubAppConfig, type GithubRepository, type GithubSourceBinding } from "./types";

const API = "https://api.github.com";
const OAUTH = "https://github.com/login/oauth/access_token";
const MAX_JSON = 1024 * 1024;
export function githubAppConfig(env: Readonly<Record<string, string | undefined>> = process.env): GithubAppConfig | undefined {
  const appId = env.ZENITH_GITHUB_APP_ID;
  const privateKeyFile = env.ZENITH_GITHUB_APP_PRIVATE_KEY_FILE;
  if (!appId && !privateKeyFile) return undefined;
  if (!appId || !/^[1-9]\d{0,15}$/.test(appId) || !privateKeyFile || !isAbsolute(privateKeyFile)) throw new GithubSourceError("unavailable");
  return { appId, privateKeyFile, clientId: env.ZENITH_GITHUB_APP_CLIENT_ID, clientSecretFile: env.ZENITH_GITHUB_APP_CLIENT_SECRET_FILE };
}

async function secretFile(file: string): Promise<Buffer> {
  let handle;
  try {
    if (!isAbsolute(file)) throw new GithubSourceError("unavailable");
    // Custody (same posture as the webhook secret): a private regular file owned by this process, reached without a
    // symlink or a second hard link. POSIX checks uid and mode and opens with O_NOFOLLOW. Windows has no POSIX
    // ownership or mode, so it reuses the CLI's native-security-API check that the file's NTFS ACL is owner-only; any
    // failure of that check refuses (reads as "unavailable", never as a weaker mode).
    const win = process.platform === "win32";
    const uid = process.getuid?.();
    if (!win && (uid === undefined || constants.O_NOFOLLOW === undefined)) throw new GithubSourceError("unavailable");
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1) throw new GithubSourceError("unavailable");
    if (win) await (await import("@/cli/config")).verifyWindowsOwnerOnlyAcl(file);
    else if (before.uid !== uid || (before.mode & 0o077) !== 0) throw new GithubSourceError("unavailable");
    handle = await open(file, win ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 || stat.ino !== before.ino || stat.dev !== before.dev) throw new GithubSourceError("unavailable");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 64 * 1024) { bytes.fill(0); throw new GithubSourceError("unavailable"); }
    return bytes.subarray(0, bytesRead);
  } catch { throw new GithubSourceError("unavailable"); }
  finally { await handle?.close().catch(() => undefined); }
}

async function appJwt(config: GithubAppConfig, nowMs: number): Promise<string> {
  const bytes = await secretFile(config.privateKeyFile);
  try {
    const key = createPrivateKey(bytes);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new GithubSourceError("unavailable");
    const now = Math.floor(nowMs / 1000);
    const data = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: config.appId, iat: now - 60, exp: now + 540 })).toString("base64url")}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
  } catch { throw new GithubSourceError("unavailable"); }
  finally { bytes.fill(0); }
}

/** Race injected transports too; discard their errors and response diagnostics. */
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new GithubSourceError("unavailable")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, () => { signal.removeEventListener("abort", abort); reject(new GithubSourceError("unavailable")); });
    if (signal.aborted) abort();
  });
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GithubSourceError("unavailable");
  return raw as Record<string, unknown>;
}
function credential(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._-]{1,8192}$/.test(raw)) throw new GithubSourceError("unavailable");
  return raw;
}

export function createGithubApp(config: GithubAppConfig, deps: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  async function request(path: string, bearer?: string, body?: unknown, signal?: AbortSignal, oauth = false, array = false, method?: "DELETE"): Promise<Record<string, unknown>> {
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
    let res: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (deadline.aborted) throw new GithubSourceError("unavailable");
      const pending = (deps.fetchImpl ?? fetch)(oauth ? OAUTH : `${API}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"), redirect: "error", signal: deadline,
        headers: { Accept: "application/vnd.github+json", "User-Agent": "zenith-github-source", "X-GitHub-Api-Version": "2026-03-10", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      void pending.then((late) => { if (deadline.aborted) void late.body?.cancel().catch(() => undefined); }, () => undefined);
      res = await bounded(pending, deadline);
      if (method === "DELETE") { if (res.status !== 204) throw new GithubSourceError("unavailable"); return {}; }
      if (!res.ok || !res.body || Number(res.headers.get("content-length")) > MAX_JSON) throw new GithubSourceError("unavailable");
      reader = res.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const chunk = await bounded(reader.read(), deadline);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_JSON) throw new GithubSourceError("unavailable");
        chunks.push(chunk.value);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      if (array) { if (!Array.isArray(parsed)) throw new GithubSourceError("unavailable"); return { items: parsed }; }
      return object(parsed);
    } catch { throw new GithubSourceError("unavailable"); }
    finally { if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } else { void res?.body?.cancel().catch(() => undefined); } }
  }
  async function installation(repo: GithubRepository, installationId: number, signal?: AbortSignal): Promise<string> {
    const jwt = await appJwt(config, now());
    const result = await request(`/repos/${repo.owner}/${repo.repo}/installation`, jwt, undefined, signal);
    if (result.id !== installationId || String(result.app_id) !== config.appId || result.suspended_at !== null) throw new GithubSourceError("refused");
    return jwt;
  }
  async function repositoryToken(repo: GithubRepository, installationId: number, repositoryId: number, jwt: string, signal?: AbortSignal, proofOnly = false): Promise<string> {
    const result = await request(`/app/installations/${installationId}/access_tokens`, jwt, { repository_ids: [repositoryId], permissions: { contents: "read" } }, signal);
    let token: string | undefined;
    try {
      token = credential(result.token);
      const permissions = object(result.permissions);
      if (permissions.contents !== "read" || Object.entries(permissions).some(([key, value]) => !["contents", "metadata"].includes(key) || value !== "read") || !Array.isArray(result.repositories) || result.repositories.length !== 1) throw new GithubSourceError("refused");
      const item = object(result.repositories[0]);
      if (item.id !== repositoryId || typeof item.full_name !== "string" || item.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}` || typeof result.expires_at !== "string" || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= now() + 60_000) throw new GithubSourceError("refused");
      return token;
    } finally {
      // A verification credential is immediately revoked even if the returned
      // repository metadata fails validation. Cleanup has a fresh short bound.
      if (proofOnly && token) try { await request("/installation/token", token, undefined, AbortSignal.timeout(5_000), false, false, "DELETE"); }
      finally { token = undefined; }
    }
  }
  const app = {
    async installUrl(state: string, signal?: AbortSignal): Promise<string> {
      const result = await request("/app", await appJwt(config, now()), undefined, signal);
      if (String(result.id) !== config.appId || typeof result.slug !== "string" || !/^[a-z0-9-]{1,100}$/.test(result.slug)) throw new GithubSourceError("unavailable");
      return `https://github.com/apps/${result.slug}/installations/new?state=${encodeURIComponent(state)}`;
    },
    async verifyUserRepository(input: { code: string; verifier: string; callbackUrl: string; installationId: number } & GithubRepository, signal?: AbortSignal): Promise<number> {
      const repo = repository(input.owner, input.repo); numericId(input.installationId);
      if (!config.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
      const bytes = await secretFile(config.clientSecretFile);
      let token: string | undefined;
      try {
        const result = await request("", undefined, { client_id: config.clientId, client_secret: bytes.toString("utf8").trim(), code: input.code, code_verifier: input.verifier, redirect_uri: input.callbackUrl }, signal, true);
        if (result.token_type !== "bearer" || result.error) throw new GithubSourceError("refused");
        token = credential(result.access_token);
        // The explicit owner/name path is independent of the bounded discovery
        // list. A user token proves current visibility and administration; an
        // App-authenticated lookup independently proves this installation's
        // selection. The callback pins the returned stable repository ID.
        const item = await request(`/repos/${repo.owner}/${repo.repo}`, token, undefined, signal);
        if (typeof item.full_name !== "string" || item.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`) throw new GithubSourceError("refused");
        if (!item.permissions || object(item.permissions).admin !== true) throw new GithubSourceError("refused", "A GitHub repository administrator must connect this repository to the workspace.");
        const repositoryId = numericId(item.id);
        const jwt = await installation(repo, input.installationId, signal);
        // Name-based installation lookup alone cannot prove stable identity if
        // a repository is renamed/recreated between the two provider reads.
        await repositoryToken(repo, input.installationId, repositoryId, jwt, signal, true);
        return repositoryId;
      } finally { bytes.fill(0); token = undefined; }
    },
    async discoverUserRepositories(input: { code: string; verifier: string; callbackUrl: string; installationId: number }, signal?: AbortSignal): Promise<{ repositories: GithubDiscoveredRepository[]; truncated: boolean }> {
      numericId(input.installationId);
      if (!config.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
      const bytes = await secretFile(config.clientSecretFile);
      let token: string | undefined;
      try {
        const result = await request("", undefined, { client_id: config.clientId, client_secret: bytes.toString("utf8").trim(), code: input.code, code_verifier: input.verifier, redirect_uri: input.callbackUrl }, signal, true);
        if (result.token_type !== "bearer" || result.error) throw new GithubSourceError("refused");
        token = credential(result.access_token);
        const installed = await request(`/app/installations/${input.installationId}`, await appJwt(config, now()), undefined, signal);
        if (installed.id !== input.installationId || String(installed.app_id) !== config.appId || installed.suspended_at !== null) throw new GithubSourceError("refused");
        const repositories: GithubDiscoveredRepository[] = [];
        for (let page = 1; page <= 10; page++) {
          const result = await request(`/user/installations/${input.installationId}/repositories?per_page=100&page=${page}`, token, undefined, signal);
          if (!Array.isArray(result.repositories) || result.repositories.length > 100) throw new GithubSourceError("unavailable");
          for (const raw of result.repositories) {
            const item = object(raw);
            if (!item.permissions || object(item.permissions).admin !== true) continue;
            if (typeof item.full_name !== "string" || typeof item.private !== "boolean") throw new GithubSourceError("unavailable");
            const parts = item.full_name.split("/");
            if (parts.length !== 2) throw new GithubSourceError("unavailable");
            const location = repository(parts[0], parts[1]);
            const defaultBranch = typeof item.default_branch === "string" && item.default_branch.length <= 250 ? item.default_branch : "main";
            repositories.push({ ...location, repositoryId: numericId(item.id), private: item.private, defaultBranch });
          }
          if (result.repositories.length < 100) return { repositories, truncated: false };
        }
        return { repositories, truncated: true };
      } finally { bytes.fill(0); token = undefined; }
    },
    async branches(binding: GithubSourceBinding, page = 1, signal?: AbortSignal): Promise<{ branches: { name: string; commitSha: string; protected: boolean }[]; nextCursor: string | null }> {
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new GithubSourceError("invalid");
      return app.withRepositoryAccess(binding, async token => {
        const result = await request(`/repos/${binding.owner}/${binding.repo}/branches?per_page=100&page=${page}`, token, undefined, signal, false, true);
        if (!Array.isArray(result.items) || result.items.length > 100) throw new GithubSourceError("unavailable");
        const branches = result.items.map(raw => {
          const branch = object(raw), commit = object(branch.commit);
          if (typeof branch.name !== "string" || branch.name.length > 250 || typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha) || typeof branch.protected !== "boolean") throw new GithubSourceError("unavailable");
          return { name: branch.name, commitSha: commit.sha, protected: branch.protected };
        });
        return { branches, nextCursor: branches.length === 100 && page < 1000 ? String(page + 1) : null };
      }, signal);
    },
    async withRepositoryAccess<T>(binding: GithubSourceBinding, fn: (token?: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const repo = repository(binding.owner, binding.repo);
      numericId(binding.installationId); numericId(binding.repositoryId);
      if (binding.appId !== config.appId) throw new GithubSourceError("refused");
      let token: string | undefined;
      try {
        const jwt = await installation(repo, binding.installationId, signal);
        token = await repositoryToken(repo, binding.installationId, binding.repositoryId, jwt, signal);
        return await fn(token);
      } catch (error) { if (error instanceof GithubSourceError && error.detail) throw error; throw new GithubSourceError("unavailable"); }
      finally { token = undefined; }
    },
  };
  return app;
}
