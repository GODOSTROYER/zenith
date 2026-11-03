/** Mock GitHub API contracts, including credential scope and leak refusal. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { api, binding, INSTALL_TOKEN, USER_TOKEN, json, keys, tokenResponse } from "./fixtures";

let material: Awaited<ReturnType<typeof keys>>;
beforeAll(async () => { material = await keys(); });
afterAll(async () => { await material.close(); });

describe("GitHub App credentials", () => {
  it("signs an RS256 App JWT with bounded iat/exp and single-repository contents:read scope", async () => {
    const fetchImpl = api(); const now = Date.now(); const consume = vi.fn(async () => ({ digest: "source-digest" }));
    expect(await createGithubApp(material.config, { fetchImpl, now: () => now }).withRepositoryAccess(binding, consume)).toEqual({ digest: "source-digest" });
    const calls = fetchImpl.mock.calls;
    const headers = calls[0][1]?.headers as Record<string, string>;
    const jwt = headers.Authorization.slice(7); const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iss: "42", iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), material.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ repository_ids: [99], permissions: { contents: "read" } });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]?.length).toBe(1);
    expect(calls.every(([url, init]) => !String(url).includes(INSTALL_TOKEN) && init?.redirect === "error")).toBe(true);
  });
  it("mints a new token on every use and never reuses one from storage", async () => {
    const fetchImpl = api(); const app = createGithubApp(material.config, { fetchImpl });
    await app.withRepositoryAccess(binding, async () => "ok"); await app.withRepositoryAccess(binding, async () => "ok");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/access_tokens"))).toHaveLength(2);
  });
  it.each(["installation", "app", "suspension", "repository", "extra-repository", "write", "extra-permission", "expired", "malformed-token"])("refuses mismatched %s before handing a token to C3", async (kind) => {
    const fetchImpl = api();
    if (["installation", "app", "suspension"].includes(kind)) fetchImpl.mockResolvedValueOnce(json({ id: kind === "installation" ? 8 : 7, app_id: kind === "app" ? 43 : 42, suspended_at: kind === "suspension" ? "today" : null }));
    else {
      const result = tokenResponse();
      if (kind === "repository") result.repositories[0].id = 100;
      if (kind === "extra-repository") result.repositories.push({ id: 100, full_name: "acme/other" });
      if (kind === "write") result.permissions.contents = "write";
      if (kind === "extra-permission") Object.assign(result.permissions, { issues: "read" });
      if (kind === "expired") result.expires_at = new Date(0).toISOString();
      if (kind === "malformed-token") result.token = "bad\r\nheader";
      fetchImpl.mockResolvedValueOnce(json({ id: 7, app_id: 42, suspended_at: null })).mockResolvedValueOnce(json(result));
    }
    const consume = vi.fn(async () => "ok");
    await expect(createGithubApp(material.config, { fetchImpl }).withRepositoryAccess(binding, consume)).rejects.toThrow("could not be confirmed");
    expect(consume).not.toHaveBeenCalled();
  });
  it("refuses a binding for a different registered App without any request", async () => {
    const fetchImpl = api(); await expect(createGithubApp(material.config, { fetchImpl }).withRepositoryAccess({ ...binding, appId: "43" }, async () => "ok")).rejects.toThrow("refused");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("checks GitHub user access to the installation/repository before binding", async () => {
    const fetchImpl = api();
    const result = await createGithubApp(material.config, { fetchImpl }).verifyUserRepository({ ...binding, code: "synthetic-code", verifier: "synthetic-pkce", callbackUrl: "https://zenith.test/api/platform/v1/github/callback" });
    expect(result).toBe(99);
    const exchange = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(exchange.code_verifier === "synthetic-pkce" && exchange.redirect_uri === "https://zenith.test/api/platform/v1/github/callback").toBe(true);
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.every((url) => !url.includes(USER_TOKEN) && !url.includes(exchange.client_secret) && !url.includes("synthetic-code"))).toBe(true);
    expect(urls[1]).toBe("https://api.github.com/user/installations/7/repositories?per_page=100&page=1");
  });
  it("refuses a spoofed installation with a repository invisible to the GitHub user", async () => {
    const fetchImpl = api(); fetchImpl.mockResolvedValueOnce(json({ access_token: USER_TOKEN, token_type: "bearer" })).mockResolvedValueOnce(json({ repositories: [{ id: 100, full_name: "foreign/private" }] }));
    await expect(createGithubApp(material.config, { fetchImpl }).verifyUserRepository({ ...binding, code: "code", verifier: "proof", callbackUrl: "https://zenith.test/callback" })).rejects.toThrow("refused");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not let a repository reader delegate private code to a shared workspace", async () => {
    const fetchImpl = api();
    fetchImpl.mockResolvedValueOnce(json({ access_token: USER_TOKEN, token_type: "bearer" }))
      .mockResolvedValueOnce(json({ repositories: [{ id: 99, full_name: "acme/app", permissions: { pull: true, admin: false } }] }));
    await expect(createGithubApp(material.config, { fetchImpl }).verifyUserRepository({ ...binding, code: "code", verifier: "proof", callbackUrl: "https://zenith.test/callback" }))
      .rejects.toMatchObject({ code: "refused" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("discovers only user-and-installation repositories administrable by the initiating user", async () => {
    const fetchImpl = api();
    fetchImpl.mockResolvedValueOnce(json({ access_token: USER_TOKEN, token_type: "bearer" }))
      .mockResolvedValueOnce(json({ id: 7, app_id: 42, suspended_at: null }))
      .mockResolvedValueOnce(json({ repositories: [
        { id: 99, full_name: "acme/app", private: true, default_branch: "develop", permissions: { admin: true } },
        { id: 100, full_name: "foreign/reader", private: true, permissions: { admin: false } },
      ] }));
    const result = await createGithubApp(material.config, { fetchImpl }).discoverUserRepositories({ installationId: 7, code: "code", verifier: "proof", callbackUrl: "https://zenith.test/callback" });
    expect(result).toEqual({ repositories: [{ owner: "acme", repo: "app", repositoryId: 99, private: true, defaultBranch: "develop" }], truncated: false });
    expect(JSON.stringify(result)).not.toContain(USER_TOKEN);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes(USER_TOKEN))).toBe(true);
  });
  it("paginates with fixed URLs and does not follow externally supplied Link headers", async () => {
    const fetchImpl = api(); fetchImpl.mockResolvedValueOnce(json({ access_token: USER_TOKEN, token_type: "bearer" })).mockResolvedValueOnce(json({ repositories: Array.from({ length: 100 }, (_, id) => ({ id: id + 100, full_name: "other/repo" })) }));
    expect(await createGithubApp(material.config, { fetchImpl }).verifyUserRepository({ ...binding, code: "code", verifier: "proof", callbackUrl: "https://zenith.test/callback" })).toBe(99);
    expect(String(fetchImpl.mock.calls[2][0])).toBe("https://api.github.com/user/installations/7/repositories?per_page=100&page=2");
  });
  it("lists branch metadata with an exact repository token and fixed pagination URLs", async () => {
    const fetchImpl = api(), delegate = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => String(url).includes("/branches?")
      ? json([{ name: "release/school", commit: { sha: "a".repeat(40) }, protected: true }])
      : delegate(url, init));
    const result = await createGithubApp(material.config, { fetchImpl }).branches(binding, 2);
    expect(result).toEqual({ branches: [{ name: "release/school", commitSha: "a".repeat(40), protected: true }], nextCursor: null });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({ repository_ids: [99], permissions: { contents: "read" } });
    expect(String(fetchImpl.mock.calls[2][0])).toBe("https://api.github.com/repos/acme/app/branches?per_page=100&page=2");
    expect((fetchImpl.mock.calls[2][1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${INSTALL_TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(INSTALL_TOKEN);
  });
  it("refuses malformed branch metadata and invalid pagination before it can reach a picker", async () => {
    const fetchImpl = api(), delegate = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => String(url).includes("/branches?")
      ? json([{ name: "main", commit: { sha: "mutable-reference" }, protected: true }])
      : delegate(url, init));
    const app = createGithubApp(material.config, { fetchImpl });
    for (const page of [0, -1, 1.1, 1001]) await expect(app.branches(binding, page)).rejects.toMatchObject({ code: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(app.branches(binding)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("scrubs transport, response and consumer failures and produces no logs", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      for (const fetchImpl of [vi.fn<typeof fetch>(async () => { throw new Error(INSTALL_TOKEN); }), vi.fn<typeof fetch>(async () => new Response(INSTALL_TOKEN, { status: 403 }))]) {
        const error = await createGithubApp(material.config, { fetchImpl }).withRepositoryAccess(binding, async () => "ok").catch((error: unknown) => error);
        expect(String(error).includes(INSTALL_TOKEN)).toBe(false);
      }
      const error = await createGithubApp(material.config, { fetchImpl: api() }).withRepositoryAccess(binding, async () => { throw new Error(INSTALL_TOKEN); }).catch((error: unknown) => error);
      expect(String(error).includes(INSTALL_TOKEN)).toBe(false);
      expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
    } finally { logs.forEach((log) => log.mockRestore()); }
  });
  it("bounds responses, refuses redirects and handles cancellation without leaking abort reasons", async () => {
    for (const response of [new Response(INSTALL_TOKEN, { status: 302, headers: { location: "https://foreign.test/" } }), new Response("x".repeat(1024 * 1024 + 1)), new Response("{}", { headers: { "content-length": "1048577" } })]) {
      await expect(createGithubApp(material.config, { fetchImpl: vi.fn(async () => response) }).withRepositoryAccess(binding, async () => "ok")).rejects.toThrow("could not be confirmed");
    }
    const controller = new AbortController(); const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const pending = createGithubApp(material.config, { fetchImpl }).withRepositoryAccess(binding, async () => "ok", controller.signal);
    controller.abort(INSTALL_TOKEN); await expect(pending).rejects.toThrow("could not be confirmed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps absent configuration anonymous and rejects partial/invalid configuration", () => {
    expect(githubAppConfig({})).toBeUndefined();
    for (const env of [{ ZENITH_GITHUB_APP_ID: "42" }, { ZENITH_GITHUB_APP_PRIVATE_KEY_FILE: material.config.privateKeyFile }, { ZENITH_GITHUB_APP_ID: "canary", ZENITH_GITHUB_APP_PRIVATE_KEY_FILE: "relative.pem" }]) expect(() => githubAppConfig(env)).toThrow("could not be confirmed");
  });
  it("interrupts an already-started transport even when that transport ignores the signal", async () => {
    const controller = new AbortController(); let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(() => { started(); return new Promise(() => undefined); });
    const operation = createGithubApp(material.config, { fetchImpl }).withRepositoryAccess(binding, async () => "ok", controller.signal);
    await ready; controller.abort(INSTALL_TOKEN);
    const error = await operation.catch((error: unknown) => error);
    expect(String(error)).toContain("could not be confirmed"); expect(String(error).includes(INSTALL_TOKEN)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("scrubs unreadable or invalid key files", async () => {
    const fetchImpl = api();
    await expect(createGithubApp({ ...material.config, privateKeyFile: material.config.privateKeyFile + ".missing" }, { fetchImpl }).withRepositoryAccess(binding, async () => "ok")).rejects.toThrow("could not be confirmed");
    await writeFile(material.config.privateKeyFile, INSTALL_TOKEN);
    await expect(createGithubApp(material.config, { fetchImpl }).withRepositoryAccess(binding, async () => "ok")).rejects.toThrow("could not be confirmed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
