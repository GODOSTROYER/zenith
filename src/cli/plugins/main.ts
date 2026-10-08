import { open } from "node:fs/promises";
import { parseManifest, trustedPublishersFromEnv, verifyProvenance } from "@/lib/plugins/manifest";
import { PluginError } from "@/lib/plugins/errors";
import { LAUNCH_TOKEN_PATTERN } from "@/lib/plugins/launch-contract";
import { loadConfig, validateToken, validateUrl } from "../config";
import { CliError, diagnostic, interrupted, statusExit } from "../errors";
import { identifier, integer, parse, readStdin, required } from "../input";
import { createOutput } from "../output";
import { object, sanitize, serialize } from "../security";
import { boundedFetch } from "../transport";
import { apiUrl, httpAuthority, LauncherError, LaunchLease, tokenDigest } from "./authority";
import { launchPlugin } from "./launcher";
import { DockerRuntime, type ContainerRuntime } from "./runtime";

export const PLUGIN_HELP = `Zenith plugin launcher
zenith plugin install --manifest FILE --digest SHA256 --url HTTPS_ORIGIN
  Validate the signed manifest; return the browser registration/review URL (exit 3).
zenith plugin list --workspace ID [--url URL] [--json]
  List approved registrations using ZENITH_TOKEN or saved login.
zenith plugin run --manifest FILE --digest REVIEWED_SHA256 --registration ID
  --workspace ID --url HTTPS_ORIGIN --image NAME@sha256:DIGEST --server NAME
  [--ca-file FILE] [--token-stdin] [--json]
zenith plugin revoke --registration ID --digest REVIEWED_SHA256 --workspace ID
  --url HTTPS_ORIGIN --token-stdin [--json]
run and revoke read only a dedicated scoped za_ token from stdin. They never use
saved login or ZENITH_TOKEN. Revoke withdraws that child token, not its parent.
Trust and token issuance require browser MFA at /platform/plugins. Launcher
issuance: POST /api/integrations/plugins/launch/tokens from the signed-in browser.
Trusted publishers: ZENITH_PLUGIN_TRUSTED_PUBLISHERS. --timeout MS bounds API
requests (default 15000); Ctrl+C stops the sandbox. --help, --json and --debug
follow the main CLI conventions.
`;
export interface PluginCliRuntime {
  env?: Readonly<Record<string, string | undefined>>; home?: string;
  stdin?: AsyncIterable<string | Uint8Array>; stdout?: (text: string) => void;
  stderr?: (text: string) => void; fetch?: typeof fetch; signal?: AbortSignal;
  pluginRuntime?: ContainerRuntime;
}
async function readManifest(filePath: string): Promise<unknown> {
  try {
    const file = await open(filePath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error();
      const buffer = Buffer.alloc(65_537); let size = 0;
      while (size < buffer.length) {
        const part = await file.read(buffer, size, buffer.length - size, null);
        if (!part.bytesRead) break; size += part.bytesRead;
      }
      if (size > 65_536) throw new Error();
      return JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown;
    } finally { await file.close(); }
  } catch { throw new CliError(2, "invalid_input", "Supply a regular signed manifest JSON file of at most 64 KiB."); }
}
function launcherDiagnostic(error: unknown): CliError {
  if (error instanceof PluginError) return new CliError(statusExit(error.status), error.code, "The signed plugin was refused. Review its publisher and permissions in the browser.");
  if (error instanceof LauncherError) {
    const code = error.code;
    const exit = /digest_mismatch/.test(code) ? 5 : /authority_unavailable|artifact_fetch_refused|runtime|sandbox_(?:cleanup|gateway)/.test(code) ? 6 :
      /authority_refused|authority_changed|scoped_token/.test(code) ? 3 : /cancelled/.test(code) ? 130 : 2;
    return new CliError(exit, code, "The plugin launcher refused this request. Check the signed manifest, scoped token and sandbox runtime.");
  }
  return diagnostic(error);
}
export async function runPluginCli(argv: string[], runtime: PluginCliRuntime = {}): Promise<number> {
  const stdout = runtime.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = runtime.stderr ?? ((s: string) => process.stderr.write(s));
  const env = runtime.env ?? process.env; const secrets = [env.ZENITH_TOKEN ?? ""];
  let json = argv.includes("--json"); let debug = argv.includes("--debug");
  try {
    const { words, flags } = parse(argv, ["manifest", "registration", "image", "server", "ca-file"]);
    json = flags.json === true; debug = flags.debug === true;
    if (flags.help) { stdout(PLUGIN_HELP); return 0; }
    const actions: Record<string, string[]> = { install: ["manifest", "digest"], list: [],
      run: ["manifest", "digest", "registration", "image", "server", "ca-file", "token-stdin"], revoke: ["registration", "digest", "token-stdin"] };
    const action = words[1];
    if (words[0] !== "plugin" || words.length !== 2 || !Object.hasOwn(actions, action) ||
        Object.keys(flags).some((k) => !["url", "workspace", "json", "debug", "timeout", ...actions[action]].includes(k))) {
      throw new CliError(2, "invalid_arguments", "Invalid plugin command or options. See zenith plugin --help.");
    }
    if (runtime.signal?.aborted) throw interrupted();
    const output = createOutput(stdout, secrets, json);
    const timeoutMs = integer(flags.timeout, 15_000, 1, 300_000);
    const explicitUrl = typeof flags.url === "string" ? flags.url : env.ZENITH_URL;
    // Only discovery uses a general credential. Running/revoking never load it.
    const saved = action === "list" && !(env.ZENITH_TOKEN && explicitUrl) ? await loadConfig(runtime.home) : undefined;
    if (saved) secrets.push(saved.token);
    const url = explicitUrl ?? saved?.baseUrl;
    if (!url) throw new CliError(2, "missing_url", "Set --url or ZENITH_URL.");
    const baseUrl = action === "list" ? validateUrl(url) : apiUrl(url).origin;
    const workspaceRaw = typeof flags.workspace === "string" ? flags.workspace : env.ZENITH_WORKSPACE;
    const workspaceId = workspaceRaw === undefined ? undefined : identifier(workspaceRaw, 100);
    const fetcher = boundedFetch(runtime.fetch ?? fetch, runtime.signal);
    const requestJson = async (path: string, init: RequestInit): Promise<unknown> => {
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(runtime.signal ? [runtime.signal] : [])]);
      let response: Response;
      try { response = await fetcher(`${baseUrl}${path}`, { ...init, signal }); }
      catch { throw new CliError(6, "network_error", "The platform request could not complete."); }
      if (!response.ok) throw new CliError(statusExit(response.status), "plugin_request_refused", "The platform refused the plugin request.");
      if (response.status === 200 && path === "/api/agent/oauth/revoke") return undefined;
      try { return await response.json() as unknown; }
      catch { throw new CliError(6, "invalid_response", "The platform returned an invalid plugin response."); }
    };
    if (action === "install") {
      const parsed = parseManifest(await readManifest(required(flags, "manifest")));
      verifyProvenance(parsed, trustedPublishersFromEnv(env));
      if (required(flags, "digest") !== parsed.manifestDigest) throw new LauncherError("manifest_digest_mismatch");
      output({ installed: false, code: "browser_session_required", pluginId: parsed.manifest.id, manifestDigest: parsed.manifestDigest,
        browserUrl: `${baseUrl}/platform/plugins`, message: "Paste this signed manifest in the browser, confirm MFA, and approve its exact digest and permissions. Issue a finite launcher token there before running." });
      return 3;
    }
    if (!workspaceId) throw new CliError(2, "invalid_arguments", "This plugin command requires --workspace or ZENITH_WORKSPACE.");
    if (action === "list") {
      const token = validateToken(env.ZENITH_TOKEN ?? saved?.token ?? ""); secrets.push(token);
      const result = await requestJson("/api/integrations/plugins/catalog", { method: "GET",
        headers: { authorization: `Bearer ${token}`, "x-zenith-workspace": workspaceId } });
      if (!object(result) || result.workspaceId !== workspaceId || !Array.isArray(result.plugins)) throw new CliError(6, "invalid_response", "The plugin catalog response was invalid.");
      output(result); return 0;
    }
    const registrationId = identifier(required(flags, "registration"), 100); const digest = required(flags, "digest");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new CliError(2, "invalid_arguments", "--digest must be a reviewed SHA256 digest.");
    if (action === "revoke" && !flags["token-stdin"]) throw new CliError(2, "invalid_arguments", "plugin revoke requires --token-stdin.");
    const manifest = action === "run" ? await readManifest(required(flags, "manifest")) : undefined;
    const image = action === "run" ? required(flags, "image") : undefined;
    const server = action === "run" ? required(flags, "server") : undefined;
    const token = (await readStdin(runtime.stdin ?? process.stdin, runtime.signal, 256)).trim(); secrets.push(token);
    if (!LAUNCH_TOKEN_PATTERN.test(token)) throw new CliError(3, "scoped_token_required", "Supply only a dedicated launcher token on stdin.");
    if (action === "revoke") {
      const binding = { registrationId, workspaceId, manifestDigest: digest, credentialDigest: tokenDigest(token), audience: `${baseUrl}/api/agent/v3/mcp` };
      const raw = await httpAuthority(new URL(baseUrl), fetcher).check(binding, token, runtime.signal);
      const lease = LaunchLease.safeParse(raw);
      if (!lease.success || Object.entries(binding).some(([k, v]) => lease.data[k as keyof typeof binding] !== v) || Date.parse(lease.data.expiresAt) <= Date.now()) throw new LauncherError("launch_authority_refused");
      await requestJson("/api/agent/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString() });
      output({ revoked: true, registrationId, message: "The child token was withdrawn. Its supervisor will stop the running sandbox on its next authority check." }); return 0;
    }
    const result = await launchPlugin({ manifest, reviewedDigest: digest, registrationId, workspaceId, apiOrigin: baseUrl,
      token, image: image!, server: server!, caFile: typeof flags["ca-file"] === "string" ? flags["ca-file"] : undefined },
    // The launcher separately bounds artifacts at 16 MiB and authority bodies
    // at 16 KiB. The general CLI's 1 MiB JSON transport is only for API reads.
    { publishers: trustedPublishersFromEnv(env), runtime: runtime.pluginRuntime ?? new DockerRuntime(), fetch: runtime.fetch ?? fetch, signal: runtime.signal });
    output({ exitCode: result.exitCode }); return result.exitCode === 0 ? 0 : 1;
  } catch (error) {
    const mapped = runtime.signal?.aborted ? interrupted() : launcherDiagnostic(error);
    // Debug includes only our stable code, never an upstream stack/body or token.
    const data = sanitize({ error: { code: mapped.code, message: mapped.message }, ...(debug ? { debug: { code: mapped.code } } : {}) }, secrets);
    if (json) stderr(serialize(data) + "\n");
    else if (object(data) && object(data.error)) stderr(`zenith: ${String(data.error.message)} [${String(data.error.code)}]\n`);
    return mapped.exitCode;
  }
}
