/**
 * GitHub App HTTP boundary: fixed origins, capped bodies/deadlines, RS256 App JWTs.
 * Keys are read from server files, never cached or included in diagnostics.
 * Installation and OAuth credentials never leave callbacks or enter URLs/state.
 * Mock HTTP contracts are not evidence of a live GitHub installation.
 */
import { createPrivateKey, sign } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
    handle = await open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) throw new GithubSourceError("unavailable");
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
  async function request(path: string, bearer?: string, body?: unknown, signal?: AbortSignal, oauth = false): Promise<Record<string, unknown>> {
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
    let res: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (deadline.aborted) throw new GithubSourceError("unavailable");
      const pending = (deps.fetchImpl ?? fetch)(oauth ? OAUTH : `${API}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: deadline,
        headers: { Accept: "application/vnd.github+json", "User-Agent": "zenith-github-source", "X-GitHub-Api-Version": "2026-03-10", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      void pending.then((late) => { if (deadline.aborted) void late.body?.cancel().catch(() => undefined); }, () => undefined);
      res = await bounded(pending, deadline);
      if (!res.ok || !res.body || Number(res.headers.get("content-length")) > MAX_JSON) throw new GithubSourceError("unavailable");
      reader = res.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const chunk = await bounded(reader.read(), deadline);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_JSON) throw new GithubSourceError("unavailable");
        chunks.push(chunk.value);
      }
      return object(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
    } catch { throw new GithubSourceError("unavailable"); }
    finally { if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } else { void res?.body?.cancel().catch(() => undefined); } }
  }
  async function installation(repo: GithubRepository, installationId: number, signal?: AbortSignal): Promise<string> {
    const jwt = await appJwt(config, now());
    const result = await request(`/repos/${repo.owner}/${repo.repo}/installation`, jwt, undefined, signal);
    if (result.id !== installationId || String(result.app_id) !== config.appId || result.suspended_at !== null) throw new GithubSourceError("refused");
    return jwt;
  }
  return {
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
        // Fixed pagination URLs, never provider-supplied Link URLs. Bound at 1,000 repositories.
        for (let page = 1; page <= 10; page++) {
          const result = await request(`/user/installations/${input.installationId}/repositories?per_page=100&page=${page}`, token, undefined, signal);
          if (!Array.isArray(result.repositories) || result.repositories.length > 100) throw new GithubSourceError("unavailable");
          for (const raw of result.repositories) {
            const item = object(raw);
            if (typeof item.full_name === "string" && item.full_name.toLowerCase() === `${repo.owner}/${repo.repo}`) {
              await installation(repo, input.installationId, signal);
              return numericId(item.id);
            }
          }
          if (result.repositories.length < 100) break;
        }
        throw new GithubSourceError("refused");
      } finally { bytes.fill(0); token = undefined; }
    },
    async withRepositoryAccess<T>(binding: GithubSourceBinding, fn: (token?: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const repo = repository(binding.owner, binding.repo);
      numericId(binding.installationId); numericId(binding.repositoryId);
      if (binding.appId !== config.appId) throw new GithubSourceError("refused");
      let token: string | undefined;
      try {
        const jwt = await installation(repo, binding.installationId, signal);
        const result = await request(`/app/installations/${binding.installationId}/access_tokens`, jwt, { repository_ids: [binding.repositoryId], permissions: { contents: "read" } }, signal);
        const permissions = object(result.permissions);
        if (permissions.contents !== "read" || Object.entries(permissions).some(([key, value]) => !["contents", "metadata"].includes(key) || value !== "read") || !Array.isArray(result.repositories) || result.repositories.length !== 1) throw new GithubSourceError("refused");
        const item = object(result.repositories[0]);
        if (item.id !== binding.repositoryId || typeof item.full_name !== "string" || item.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}` || typeof result.expires_at !== "string" || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= now() + 60_000) throw new GithubSourceError("refused");
        token = credential(result.token);
        return await fn(token);
      } catch (error) { if (error instanceof GithubSourceError && error.detail) throw error; throw new GithubSourceError("unavailable"); }
      finally { token = undefined; }
    },
  };
}
