/** Synthetic credentials and mocked HTTP only; nothing here contacts GitHub. */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { GithubAppConfig, GithubSourceBinding } from "@/lib/sources/github/types";

export const binding: GithubSourceBinding = { workspaceId: "ws-a", owner: "acme", repo: "app", installationId: 7, repositoryId: 99, appId: "42", version: 1 };
export const INSTALL_TOKEN = "synthetic-installation-canary";
export const USER_TOKEN = "synthetic-user-canary";
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
export const tokenResponse = () => ({ token: INSTALL_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: "read", metadata: "read" }, repositories: [{ id: 99, full_name: "acme/app" }] });
export function api() {
  return vi.fn<typeof fetch>(async (url) => {
    const value = String(url);
    if (value === "https://api.github.com/app") return json({ id: 42, slug: "zenith-test" });
    if (value === "https://api.github.com/repos/acme/app/installation") return json({ id: 7, app_id: 42, suspended_at: null });
    if (value === "https://api.github.com/app/installations/7/access_tokens") return json(tokenResponse());
    if (value === "https://github.com/login/oauth/access_token") return json({ access_token: USER_TOKEN, token_type: "bearer" });
    if (value.startsWith("https://api.github.com/user/installations/7/repositories?")) return json({ repositories: [{ id: 99, full_name: "acme/app" }] });
    throw new Error("Unexpected synthetic GitHub request.");
  });
}
export async function keys() {
  const dir = await mkdtemp(path.join(tmpdir(), "zenith-github-source-"));
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyFile = path.join(dir, "app.pem"); const clientSecretFile = path.join(dir, "oauth-secret");
  await writeFile(privateKeyFile, pair.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  await writeFile(clientSecretFile, "synthetic-client-secret-canary", { mode: 0o600 });
  const config: GithubAppConfig = { appId: "42", privateKeyFile, clientId: "Iv1.synthetic", clientSecretFile };
  return { config, publicKey: pair.publicKey, async close() {
    const target = path.resolve(dir); const root = path.resolve(tmpdir());
    if (!target.startsWith(root + path.sep)) throw new Error("Synthetic key cleanup is outside temp.");
    await rm(target, { recursive: true, force: true });
  } };
}
