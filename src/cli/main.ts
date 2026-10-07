/** Operator CLI: SDK for REST, stateless MCP for tools, no stores or clouds.
 * Browser approval is never submitted by this process. whoami reports unknown
 * user identity because the current contracts expose no identity endpoint. */
import { createPlatformClient, PlatformInvalidResponseError } from "@/lib/sdk";
import { CapabilityRequestSchema } from "@/lib/capabilities/catalog";
import { findSecret } from "@/lib/capabilities/secret-guard";
import { BROKER_HTTP_STATUS } from "@/lib/capabilities/errors";
import type { BrokerErrorCode } from "@/lib/capabilities/errors";
import { TERMINAL_OPERATION_STATUSES } from "@/lib/controlplane/types";
import type { OperationStatus } from "@/lib/controlplane/types";
import { configPaths, loadConfig, removeConfig, saveConfig, validateToken, validateUrl } from "./config";
import { CliError, diagnostic, interrupted, statusExit } from "./errors";
import { identifier, integer, jsonInput, parse, required, scopeInput, readStdin } from "./input";
import type { Arguments } from "./input";
import { CreateAzureInput, CreateGcpInput, CreateOciInput } from "@/lib/connections/schemas";
import { createOutput } from "./output";
import { containsCredential, object, sanitize, serialize } from "./security";
import { boundedFetch, McpClient, pause } from "./transport";

export interface CliRuntime {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export const HELP = `Zenith — operations through the platform SDK and MCP v3

Global: --url URL (or ZENITH_URL), --workspace ID (or ZENITH_WORKSPACE),
        --json, --debug, --timeout MS (default 15000), --help
Auth:   ZENITH_TOKEN, or login --token-stdin with --url followed by logout

zenith login --token-stdin
zenith logout
zenith whoami
zenith ops list [--status STATUS[,STATUS]] [--env ID] [--limit N] [--cursor ID]
zenith ops show ID
zenith ops events ID [--follow] [--limit N] [--poll-interval MS]
zenith ops cancel ID [--reason TEXT]
zenith propose CAPABILITY --scope '{"workspaceId":"ws",...}' --input @file.json|-
       --idempotency-key KEY [--reason TEXT]
zenith check CAPABILITY --scope '{"workspaceId":"ws",...}' --input @file.json|-
zenith approve ID  (refuses; returns the human browser review URL)
zenith tools list
zenith tools call NAME --args @file.json|-
zenith execute ID --workspace ID --digest REVIEWED_PROPOSAL_DIGEST
zenith connections list [--include-revoked]
zenith connections show ID
zenith connections verify ID
zenith connections revoke ID --confirm ID [--reason TEXT] [--revoke-runner]
zenith connections create PROVIDER --input @file.json|-       (browser handoff)
zenith connections rotate ID --input @file.json|- [--promote]  (browser handoff)
zenith connections promote ID --rotation ROTATION_ID           (browser handoff)
zenith connections abort ID --rotation ROTATION_ID             (browser handoff)

connections: PROVIDER is aws, gcp, azure, oci or kubernetes. list, show, verify and revoke run
with a linked credential. create, rotate, promote and abort change what Zenith can reach, so
they validate your input locally and hand off to the signed-in browser (exit 3), like approve.
revoke is terminal and immediate; --confirm must repeat the connection id.

whoami verifies authentication; the user identity remains unknown in MCP v3.
--follow emits JSON Lines with --json; Ctrl+C exits 130. See docs/platform/CLI.md.
`;

function command(args: Arguments): string {
  const { words, flags } = args;
  const name = words[0] === "ops" || words[0] === "tools" || words[0] === "connections" ? words.slice(0, 2).join(" ") : words[0];
  const shapes: Record<string, { count: number; options: string[] }> = {
    login: { count: 1, options: ["token-stdin"] }, logout: { count: 1, options: [] }, whoami: { count: 1, options: [] },
    "ops list": { count: 2, options: ["status", "env", "limit", "cursor"] },
    "ops show": { count: 3, options: [] }, "ops events": { count: 3, options: ["follow", "limit", "poll-interval"] },
    "ops cancel": { count: 3, options: ["reason"] },
    propose: { count: 2, options: ["scope", "input", "idempotency-key", "reason"] },
    check: { count: 2, options: ["scope", "input", "idempotency-key", "reason"] }, approve: { count: 2, options: [] },
    "tools list": { count: 2, options: [] }, "tools call": { count: 3, options: ["args"] },
    execute: { count: 2, options: ["digest"] },
    "connections list": { count: 2, options: ["include-revoked"] }, "connections show": { count: 3, options: [] },
    "connections verify": { count: 3, options: [] }, "connections revoke": { count: 3, options: ["confirm", "reason", "revoke-runner"] },
    "connections create": { count: 3, options: ["input"] }, "connections rotate": { count: 3, options: ["input", "promote"] },
    "connections promote": { count: 3, options: ["rotation"] }, "connections abort": { count: 3, options: ["rotation"] },
  };
  const shape = shapes[name];
  const global = ["url", "workspace", "timeout", "json", "debug", "help"];
  if (!shape || words.length !== shape.count || Object.keys(flags).some((key) => !global.includes(key) && !shape.options.includes(key))) {
    throw new CliError(2, "invalid_arguments", "Invalid command, arguments or options. See --help.");
  }
  if (flags["poll-interval"] && !flags.follow) throw new CliError(2, "invalid_arguments", "--poll-interval requires --follow.");
  return name;
}

function toolExit(envelope: Record<string, unknown>): number {
  if (envelope.ok) return 0;
  const error = object(envelope.error) ? envelope.error : {};
  const code = error.code;
  if (typeof code === "string" && Object.hasOwn(BROKER_HTTP_STATUS, code)) return statusExit(BROKER_HTTP_STATUS[code as BrokerErrorCode]);
  if (code === "not_found") return 4;
  if (["unauthorized", "invalid_token", "insufficient_scope", "role_insufficient", "policy_denied", "approval_required", "browser_session_required"].includes(String(code))) return 3;
  if (["invalid_input", "invalid_request", "response_too_large", "unsupported_capability"].includes(String(code))) return 2;
  if (["rate_limited", "throttled", "digest_mismatch", "invalid_state", "operation_expired", "already_claimed", "idempotency_conflict"].includes(String(code))) return 5;
  return 6;
}

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const env = runtime.env ?? process.env;
  const stdout = runtime.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = runtime.stderr ?? ((text: string) => { process.stderr.write(text); });
  const stdin = runtime.stdin ?? process.stdin;
  const secrets = [env.ZENITH_TOKEN ?? ""];
  let json = argv.includes("--json"); let debug = argv.includes("--debug");
  try {
    const args = parse(argv); const { flags, words } = args;
    json = flags.json === true; debug = flags.debug === true;
    if (flags.help || !words.length) { stdout(HELP); return 0; }
    const name = command(args);
    const output = createOutput(stdout, secrets, json);
    const timeoutMs = integer(flags.timeout, 15_000, 1, 300_000);
    if (runtime.signal?.aborted) throw interrupted();
    if (name === "logout") {
      await removeConfig(runtime.home);
      output({ loggedOut: true, note: "Saved credential removed. Unset ZENITH_TOKEN separately; logout does not revoke a server grant." });
      return 0;
    }
    const explicitUrl = typeof flags.url === "string" ? flags.url : env.ZENITH_URL;
    // Explicit environment auth bypasses saved credentials when its URL is supplied.
    const saved = name === "login" || (env.ZENITH_TOKEN && explicitUrl) ? undefined : await loadConfig(runtime.home);
    if (saved) secrets.push(saved.token);
    const url = explicitUrl ?? saved?.baseUrl;
    if (!url) throw new CliError(2, "missing_url", "Set --url or ZENITH_URL, or log in with a server URL first.");
    const baseUrl = validateUrl(url);
    const workspaceRaw = typeof flags.workspace === "string" ? flags.workspace : env.ZENITH_WORKSPACE;
    const workspaceId = workspaceRaw === undefined ? undefined : identifier(workspaceRaw, 100);
    if (name === "approve") {
      const id = identifier(words[1]);
      output({ approved: false, code: "browser_session_required", browserUrl: `${baseUrl}/integrations/operations/${id}`,
        message: "Only a human signed in to the browser can review and approve the exact proposal digest. A CLI credential cannot approve." });
      return 3;
    }
    if (name === "connections create" || name === "connections rotate" || name === "connections promote" || name === "connections abort") {
      // These change what Zenith can reach: validate locally, never send, hand off to the browser.
      const target = words[2];
      let checked: Record<string, unknown> = {};
      if (name === "connections create") {
        const provider = target;
        const schemas = { gcp: CreateGcpInput, azure: CreateAzureInput, oci: CreateOciInput } as const;
        if (!["aws", "gcp", "azure", "oci", "kubernetes"].includes(provider)) throw new CliError(2, "invalid_arguments", "PROVIDER must be aws, gcp, azure, oci or kubernetes.");
        if (provider in schemas) {
          const input = await jsonInput(required(flags, "input"), stdin, runtime.signal);
          if (findSecret(input) || containsCredential(input, secrets)) throw new CliError(2, "secret_input", "Input contains credential material. Connections hold identifiers only; values are never echoed.");
          const parsed = schemas[provider as keyof typeof schemas].safeParse(input);
          if (!parsed.success) throw new CliError(2, "invalid_input", `Invalid ${provider} connection input: ${parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
          checked = { provider, inputValid: true };
        } else checked = { provider, inputValid: null, note: provider === "kubernetes" ? "Kubernetes connections default to scoped guest: the vault credential is a namespaced minter and serves guest sessions only. To deploy to or observe the cluster add a SEPARATE deployer credential (deployerCredentialRef, deployerScope namespaced or cluster) in the browser page or with connections rotate; without it deploy and observe are refused. Legacy kubeconfig mode needs an explicit admin choice, with a warning, in the browser page." : "This provider's creation flow returns trust values you must act on; use its browser page." };
      } else {
        identifier(target);
        if (name === "connections rotate") {
          const patch = await jsonInput(required(flags, "input"), stdin, runtime.signal);
          if (findSecret(patch) || containsCredential(patch, secrets)) throw new CliError(2, "secret_input", "Input contains credential material. Rotation changes identifiers only; values are never echoed.");
          checked = { connectionId: target, fields: Object.keys(patch), promote: flags.promote === true };
        } else {
          identifier(required(flags, "rotation"));
          checked = { connectionId: target, rotationId: flags.rotation };
        }
      }
      output({ approved: false, code: "browser_session_required", ...checked, browserUrl: `${baseUrl}/platform/connections`,
        message: "Creating, rotating, promoting or aborting connection access changes what Zenith can reach, so only a person signed in to the browser can do it. Nothing was sent." });
      return 3;
    }
    if (name === "login") {
      if (flags["token-stdin"] !== true) throw new CliError(2, "invalid_arguments", "login requires --token-stdin; never pass a credential in an argument.");
      // Boolean flag is checked separately; credentials never accept a command-line value.
      const raw = await readStdin(stdin, runtime.signal, 8194);
      secrets.push(raw, raw.trim());
      const token = validateToken(raw.replace(/\r?\n$/, ""));
      secrets.push(token);
      await saveConfig({ version: 1, baseUrl, token }, runtime.home);
      output({ saved: true, baseUrl, configFile: configPaths(runtime.home).file, note: "Stored locally; authentication is checked by whoami or the next request." });
      return 0;
    }
    const token = validateToken(env.ZENITH_TOKEN ?? saved?.token ?? "");
    secrets.push(token);
    if (!env.ZENITH_TOKEN && saved && saved.baseUrl !== baseUrl) throw new CliError(2, "credential_url_mismatch", "Saved credentials belong to another server URL. Log in for this URL or supply ZENITH_TOKEN explicitly.");
    const fetcher = boundedFetch(runtime.fetch ?? globalThis.fetch, runtime.signal);
    const client = createPlatformClient({ baseUrl, auth: { kind: "bearer", token }, workspaceId, timeoutMs, fetch: fetcher });
    const mcp = new McpClient({ baseUrl, token, workspaceId, timeoutMs, fetch: fetcher, signal: runtime.signal });
    if (name === "whoami") {
      const result = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zenith-cli", version: "0.1.0" } });
      if (!object(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string" || result.protocolVersion !== "2025-06-18") throw new PlatformInvalidResponseError(200);
      output({ authenticated: true, identity: null, identityStatus: "unknown", note: "MCP v3 verifies the credential but exposes no authenticated user identity.",
        baseUrl, selectedWorkspace: workspaceId ?? null, server: result.serverInfo });
    } else if (name === "ops list") {
      const statuses = typeof flags.status === "string" ? flags.status.split(",") : undefined;
      const valid: readonly OperationStatus[] = ["proposed", "awaiting_approval", "approved", "queued", "running", ...TERMINAL_OPERATION_STATUSES];
      if (statuses && (statuses.length > valid.length || statuses.some((status) => !valid.includes(status as OperationStatus)))) throw new CliError(2, "invalid_arguments", "Use valid comma-separated operation statuses.");
      output(await client.listOperations({ status: statuses as OperationStatus[] | undefined,
        environmentId: typeof flags.env === "string" ? identifier(flags.env) : undefined,
        limit: integer(flags.limit, 50, 1, 200), cursor: typeof flags.cursor === "string" ? identifier(flags.cursor) : undefined }), "operations");
    } else if (name === "ops show") output(await client.getOperation(identifier(words[2])));
    else if (name === "ops cancel") {
      const input = typeof flags.reason === "string" ? { reason: flags.reason } : {};
      if (findSecret(input) || containsCredential(input, secrets)) throw new CliError(2, "secret_input", "Cancellation reason contains credential material; values are never echoed.");
      output(await client.cancelOperation(identifier(words[2]), input));
    }
    else if (name === "ops events") {
      const id = identifier(words[2]); const limit = integer(flags.limit, 100, 1, 200);
      const poll = integer(flags["poll-interval"], 1000, 10, 60_000);
      let afterSeq = 0; let terminal = false;
      do {
        if (runtime.signal?.aborted) throw interrupted();
        const page = await client.listOperationEvents(id, { afterSeq, limit });
        if (page.events.length > limit || page.events.some((event) => !object(event) || !Number.isSafeInteger(event.seq) || event.seq <= afterSeq)) throw new PlatformInvalidResponseError(200);
        if (new Set(page.events.map((event) => event.seq)).size !== page.events.length) throw new PlatformInvalidResponseError(200);
        if (!flags.follow || page.events.length) output(page, "events");
        if (!flags.follow) break;
        const ordered = [...page.events].sort((a, b) => a.seq - b.seq);
        if (ordered.length) afterSeq = ordered[ordered.length - 1].seq;
        if (page.events.length === limit) continue;
        if (terminal) break;
        const detail = await client.getOperation(id);
        terminal = TERMINAL_OPERATION_STATUSES.includes(detail.operation.status);
        // One final drain after observing a terminal state covers its last event.
        if (!terminal) await pause(poll, runtime.signal);
      } while (true);
    } else if (name === "propose" || name === "check") {
      const scope = scopeInput(required(flags, "scope"));
      if (workspaceId && workspaceId !== scope.workspaceId) throw new CliError(2, "workspace_mismatch", "--workspace must match the request scope.");
      const input = await jsonInput(required(flags, "input"), stdin, runtime.signal);
      if (findSecret(input) || containsCredential(input, secrets)) throw new CliError(2, "secret_input", "Input contains credential material. Use secret references; values are never echoed.");
      const key = typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : undefined;
      if (name === "propose" && !key) throw new CliError(2, "invalid_arguments", "propose requires --idempotency-key (8-200 characters); reuse it only for the same intent.");
      const parsed = CapabilityRequestSchema.safeParse({ capability: words[1], scope, input,
        ...(key ? { idempotencyKey: key } : {}), ...(typeof flags.reason === "string" ? { reason: flags.reason } : {}) });
      if (!parsed.success) throw new CliError(2, "invalid_request", "Invalid capability request. Check the capability, scope, reason and idempotency key; input is never echoed.");
      if (findSecret(parsed.data) || containsCredential(parsed.data, secrets)) throw new CliError(2, "secret_input", "Request contains credential material. Use secret references; values are never echoed.");
      const result = await (name === "propose" ? client.proposeCapability(parsed.data) : client.checkCapability(parsed.data));
      output(result);
      if (result.decision.outcome === "deny") return 3;
    } else if (name === "connections list") {
      output(await client.listConnections(flags["include-revoked"] === true ? { includeRevoked: true } : { includeRevoked: false }), "connections");
    } else if (name === "connections show") output((await client.getConnection(identifier(words[2]))).connection, "connection");
    else if (name === "connections verify") {
      const result = await client.verifyConnection(identifier(words[2]));
      output(result, "connection-answer"); return result.ok ? 0 : 6;
    } else if (name === "connections revoke") {
      const id = identifier(words[2]);
      if (flags.confirm !== id) throw new CliError(2, "confirmation_required", "Revocation is terminal and immediate. Repeat the connection id with --confirm to proceed.");
      const reason = typeof flags.reason === "string" ? flags.reason : undefined;
      if (reason && (findSecret({ reason }) || containsCredential({ reason }, secrets))) throw new CliError(2, "secret_input", "Reason contains credential material; values are never echoed.");
      const result = await client.revokeConnection(id, { confirm: id, ...(reason ? { reason } : {}), ...(flags["revoke-runner"] === true ? { revokeRunner: true } : {}) });
      output(result, "connection-answer"); return result.ok ? 0 : 6;
    } else if (name === "tools list") {
      const result = await mcp.request("tools/list", {});
      if (!Array.isArray(result.tools) || result.tools.some((tool: unknown) => !object(tool) || typeof tool.name !== "string" || !object(tool.inputSchema)) ||
          (result.nextCursor !== undefined && typeof result.nextCursor !== "string")) throw new PlatformInvalidResponseError(200);
      output(result, "tools");
    } else if (name === "tools call") {
      const tool = words[2];
      if (!/^zenith_[a-z0-9_]{1,100}$/.test(tool)) throw new CliError(2, "invalid_arguments", "Use a Zenith tool name from tools list.");
      const input = await jsonInput(required(flags, "args"), stdin, runtime.signal);
      if (findSecret(input) || containsCredential(input, secrets)) throw new CliError(2, "secret_input", "Tool arguments contain credential material. Use secret references; values are never echoed.");
      const result = await mcp.call(tool, input);
      output(result, "mcp"); return toolExit(result);
    } else if (name === "execute") {
      if (!workspaceId) throw new CliError(2, "invalid_arguments", "execute requires --workspace or ZENITH_WORKSPACE.");
      const expectedDigest = required(flags, "digest");
      if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new CliError(2, "invalid_arguments", "--digest must be the reviewed 64-character lowercase hex proposal digest.");
      const result = await mcp.call("zenith_execute_approved_operation", { workspaceId, operationId: identifier(words[1]), expectedDigest });
      output(result, "mcp"); return toolExit(result);
    }
    if (runtime.signal?.aborted) throw interrupted();
    return 0;
  } catch (error) {
    const mapped = runtime.signal?.aborted ? interrupted() : diagnostic(error);
    const data = sanitize({ error: { code: mapped.code, message: mapped.message },
      ...(debug && error instanceof Error ? { debug: { stack: error.stack } } : {}) }, secrets);
    if (json) stderr(serialize(data) + "\n");
    else if (object(data) && object(data.error)) {
      stderr(`zenith: ${String(data.error.message)} [${String(data.error.code)}]\n`);
      if (debug && data.debug) stderr(serialize(data.debug, true) + "\n");
    }
    return mapped.exitCode;
  }
}
