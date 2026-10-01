/**
 * Browser-only GitHub install/bind form and both server-side callbacks.
 * A live human workspace admin, hashed expiring state, browser PKCE proof and
 * GitHub user access are all required before binding. Agent headers are refused.
 * No access token or external diagnostics reach HTML, redirects or stored state.
 */
import { NextResponse, type NextRequest } from "next/server";
import { platformDb } from "@/lib/controlplane/db/open";
import { route } from "@/lib/server/request";
import { ApiError } from "@/lib/server/errors";
import { requireWorkspace } from "@/lib/server/workspace";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { createGithubSourceStore, digest, INSTALL_LIFETIME_MS } from "@/lib/sources/github/store";
import { GithubSourceError, numericId, repository } from "@/lib/sources/github/types";
import { isBrokerError } from "@/lib/capabilities/errors";
import { assertBrowserSession, expectedOrigin } from "../../_lib/browser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const PATH = "/api/platform/v1/github/callback";
const COOKIE = "zenith-github-install";
const HEADERS = {
  "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  // The form's 303 navigation must be able to continue to the fixed GitHub origin.
  "content-security-policy": "default-src 'none'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'",
};
const form = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect GitHub source</title><main><h1>Connect GitHub source</h1><p>Install the Zenith GitHub App, then authorize access to the repository. This replaces this workspace's source binding.</p><form method="post" action="${PATH}"><label>Repository (owner/name) <input name="repository" required maxlength="140" autocomplete="off"></label><button type="submit">Install and bind repository</button></form></main></html>`;
const success = `<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub source connected</title><main><h1>GitHub source connected</h1><p>The workspace source binding was saved.</p><a href="/platform">Return to Zenith</a></main></html>`;

function callbackUrl(req: NextRequest): string {
  const origin = expectedOrigin(req); const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new GithubSourceError("unavailable");
  return `${origin}${PATH}`;
}
function parameter(req: NextRequest, key: string): string | undefined {
  const values = req.nextUrl.searchParams.getAll(key);
  if (values.length > 1) throw new GithubSourceError("invalid");
  return values[0];
}
function safeFailure(error: unknown): never {
  if (error instanceof GithubSourceError) throw new ApiError(error.message, { invalid: 400, refused: 403, conflict: 409, unavailable: 503 }[error.code]);
  throw new ApiError("GitHub source connection could not be confirmed. Start again.", 503);
}
function redirect(url: string): NextResponse { return new NextResponse(null, { status: 303, headers: { ...HEADERS, location: url } }); }
function cookieOptions(req: NextRequest) { return { httpOnly: true, secure: new URL(callbackUrl(req)).protocol === "https:", sameSite: "lax" as const, path: PATH, maxAge: INSTALL_LIFETIME_MS / 1000 }; }
async function browserCaller(req: NextRequest, mutation: boolean) {
  try {
    const caller = await assertBrowserSession(req, { mutation });
    if (requireWorkspace().id !== caller.workspaceId) throw new ApiError("Select the workspace before connecting GitHub.", 403);
    return caller;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isBrokerError(error)) throw new ApiError(error.message, error.status);
    return safeFailure(error);
  }
}

export const GET = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, false);
  try {
    const state = parameter(req, "state");
    if (state === undefined) {
      if (req.nextUrl.searchParams.size) throw new GithubSourceError("invalid");
      return new NextResponse(form, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
    }
    const config = githubAppConfig();
    if (!config?.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
    const store = createGithubSourceStore(await platformDb());
    const browserProof = req.cookies.get(COOKIE)?.value ?? "";
    const input = { workspaceId: caller.workspaceId, actorId: caller.principal.id, state, browserProof };
    const code = parameter(req, "code"); const installation = parameter(req, "installation_id");
    if (parameter(req, "error") !== undefined || (code !== undefined && installation !== undefined)) throw new GithubSourceError("refused");
    if (code === undefined) {
      if (!installation || !/^[1-9]\d{0,15}$/.test(installation) || !["install", "update"].includes(parameter(req, "setup_action") ?? "install")) throw new GithubSourceError("invalid");
      await store.authorize(input, numericId(Number(installation)));
      const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: callbackUrl(req), state, code_challenge: Buffer.from(digest(browserProof), "hex").toString("base64url"), code_challenge_method: "S256" });
      return redirect(`https://github.com/login/oauth/authorize?${params}`);
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) throw new GithubSourceError("invalid");
    const intent = await store.consume(input);
    const repositoryId = await createGithubApp(config).verifyUserRepository({ ...intent, code, verifier: browserProof, callbackUrl: callbackUrl(req) }, AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]));
    await store.bind({ ...intent, repositoryId, workspaceId: caller.workspaceId, actorId: caller.principal.id, appId: config.appId });
    const out = new NextResponse(success, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
    out.cookies.set(COOKIE, "", { ...cookieOptions(req), maxAge: 0 });
    return out;
  } catch (error) { return safeFailure(error); }
});

export const POST = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, true);
  try {
    if (req.nextUrl.searchParams.size || req.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded" || Number(req.headers.get("content-length")) > 1024 || !req.body) throw new GithubSourceError("invalid");
    const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 1024) throw new GithubSourceError("invalid"); chunks.push(chunk.value);
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const fields = new URLSearchParams(Buffer.concat(chunks, size).toString("utf8"));
    if ([...fields.keys()].some((key) => key !== "repository") || fields.getAll("repository").length !== 1) throw new GithubSourceError("invalid");
    const parts = (fields.get("repository") ?? "").split("/");
    if (parts.length !== 2) throw new GithubSourceError("invalid");
    const repo = repository(parts[0], parts[1]);
    const config = githubAppConfig();
    if (!config?.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
    callbackUrl(req);
    const intent = await createGithubSourceStore(await platformDb()).begin(caller.workspaceId, caller.principal.id, repo);
    const url = await createGithubApp(config).installUrl(intent.state, req.signal);
    const out = redirect(url); out.cookies.set(COOKIE, intent.browserProof, cookieOptions(req)); return out;
  } catch (error) { return safeFailure(error); }
});
