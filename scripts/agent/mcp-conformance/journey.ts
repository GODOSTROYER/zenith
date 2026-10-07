/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The client interoperability journey (PROD-UX-02): what a coding-agent MCP
 * client does against Zenith, end to end, with every claim checked on the wire.
 *
 *   discovery -> protocol version negotiation -> scoped tools -> a read call ->
 *   a streamed call -> reconnect with Last-Event-ID -> cancellation ->
 *   audience binding -> token revocation (immediate effect)
 *
 * It takes a base URL and tokens and knows nothing about how the server is
 * run, so the same journey executes against a loopback server inside vitest
 * (tests/agent-v3/client-conformance.test.ts) and against a real deployment
 * from the command line (scripts/agent/mcp-conformance.ts). A step that cannot
 * be exercised with the supplied configuration is `skip` with the reason, never
 * a silent pass.
 */
import { checkAuthorizationServerMetadata, fetchAuthorizationServerMetadata } from "../../../src/lib/agent-access/oauth/as-metadata";
import { TOOL_CATALOG, catalogFor } from "../../../src/lib/agent-access/v3/catalog";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS, LEGACY_PROTOCOL_VERSIONS } from "../../../src/lib/agent-access/v3/protocol";
import { McpClient, collect, toolResult } from "./client";

export type StepStatus = "pass" | "fail" | "skip";
export interface StepResult {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
}

export interface JourneyConfig {
  /** `https://host` or `http://127.0.0.1:port`: the Zenith origin. */
  baseUrl: string;
  /** Bearer for the identity under test (linked credential, plugin token or OAuth access token). */
  token: string;
  /** x-zenith-workspace; required when `token` is an OAuth access token. */
  workspaceId?: string;
  /** A cheap read the token may call. */
  readTool: { name: string; arguments: Record<string, unknown> };
  /** Scopes the token carries, as bare names (`read`, `plan`). Enables the scoped-catalog and insufficient-scope checks. */
  expectedScopes?: string[];
  /** The authorization server Zenith must name in its protected resource metadata. */
  expectedIssuer?: string;
  /** Also fetch the issuer's RFC 8414 / OIDC metadata and check it (network). */
  discoverAuthorizationServer?: boolean;
  /** A tool that is still running when the cancel arrives (the unit harness holds one open; real deployments usually have none). */
  slowTool?: { name: string; arguments: Record<string, unknown> };
  /** A token that is valid but minted for ANOTHER resource; must be refused. */
  foreignAudienceToken?: string;
  /** A different valid principal; must not be able to resume this principal's stream. */
  foreignPrincipalToken?: string;
  /** Revoke `token` at the end and prove it stops working. Destructive: only with a throwaway token. */
  revoke?: { endpoint?: string; params?: Record<string, string> };
  /** Steps to run (default: all). */
  only?: string[];
  fetch?: typeof fetch;
}

const origin = (config: JourneyConfig): string => new URL(config.baseUrl).origin;
const mcpUrl = (config: JourneyConfig): string => `${origin(config)}/api/agent/v3/mcp`;
const stream = /^[0-9a-f]{32}\.[1-9][0-9]*$/;
const fail = (message: string): never => { throw new Error(message); };
const expect = (condition: unknown, message: string): void => { if (!condition) fail(message); };

class Skip extends Error {}
const skip = (reason: string): never => { throw new Skip(reason); };

type Step = { id: string; title: string; run: (config: JourneyConfig, client: () => McpClient) => Promise<string> };

async function discovery(config: JourneyConfig, client: () => McpClient): Promise<string> {
  const fetcher = config.fetch ?? fetch;
  const anonymous = await client().post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, undefined, false);
  expect(anonymous.status === 401, `an unauthenticated request must be 401 (was ${anonymous.status})`);
  const challenge = anonymous.headers.get("www-authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  expect(metadataUrl, "the 401 must carry WWW-Authenticate resource_metadata (RFC 9728)");
  expect(metadataUrl === `${origin(config)}/.well-known/oauth-protected-resource/api/agent/v3/mcp`, `resource_metadata must be the exact path-inserted URL (was ${metadataUrl})`);
  expect(/scope="zenith:read"/.test(challenge), "the challenge must name the minimum scope zenith:read");
  const response = await fetcher(metadataUrl!, { headers: { accept: "application/json" }, redirect: "error" });
  expect(response.status === 200, `protected resource metadata must be anonymous 200 (was ${response.status})`);
  const metadata = (await response.json()) as any;
  expect(metadata.resource === mcpUrl(config), `metadata.resource must be exactly ${mcpUrl(config)} (was ${metadata.resource})`);
  expect(Array.isArray(metadata.authorization_servers) && metadata.authorization_servers.length > 0 && metadata.authorization_servers.every((s: unknown) => typeof s === "string"), "authorization_servers must list at least one issuer");
  expect(metadata.bearer_methods_supported?.includes("header"), "bearer_methods_supported must include header");
  expect(!JSON.stringify(metadata).includes("jwks"), "metadata must not leak the JWKS URL");
  for (const scope of config.expectedScopes ?? ["read"]) expect(metadata.scopes_supported?.includes(`zenith:${scope}`), `scopes_supported must include zenith:${scope}`);
  if (config.expectedIssuer) expect(metadata.authorization_servers.includes(config.expectedIssuer), `authorization_servers must include the exact issuer ${config.expectedIssuer}`);
  let extra = "";
  if (config.discoverAuthorizationServer) {
    const issuer = config.expectedIssuer ?? metadata.authorization_servers[0];
    const found = await fetchAuthorizationServerMetadata(issuer, fetcher);
    expect(found, `no RFC 8414 / OIDC metadata reachable for ${issuer}`);
    const findings = checkAuthorizationServerMetadata(issuer, found!.metadata, { allowLoopbackHttp: /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(issuer) });
    const failures = findings.filter((f) => f.level === "fail");
    expect(failures.length === 0, `authorization server metadata: ${failures.map((f) => f.message).join(" ")}`);
    extra = `; issuer metadata valid (${findings.length} advisory notes)`;
  }
  return `401 challenge points at ${metadataUrl}; resource ${metadata.resource}; issuers ${JSON.stringify(metadata.authorization_servers)}${extra}`;
}

async function versions(config: JourneyConfig, client: () => McpClient): Promise<string> {
  const notes: string[] = [];
  for (const version of LEGACY_PROTOCOL_VERSIONS) {
    const { status, body } = await client().initialize(version);
    expect(status === 200 && body.result?.protocolVersion === version, `initialize ${version} must be answered with ${version} (was ${status} ${body.result?.protocolVersion ?? body.error?.message})`);
  }
  notes.push(`legacy ${LEGACY_PROTOCOL_VERSIONS.join(", ")} negotiated`);
  const refusedHeader = await client().rpc("tools/list", undefined, { "mcp-protocol-version": "2024-11-05" });
  expect(refusedHeader.status === 400 && refusedHeader.body.error?.code === -32602, `an unsupported MCP-Protocol-Version header must be 400/-32602 (was ${refusedHeader.status})`);
  expect(SUPPORTED_MCP_PROTOCOL_VERSIONS.every((v) => (refusedHeader.body.error?.data?.supported ?? []).includes(v)), "the refusal must list every supported version");
  for (const bad of ["2024-11-05", "2024-10-07", "not-a-version"]) {
    const refused = await client().initialize(bad);
    expect(refused.status === 400 && refused.body.error?.code === -32602, `initialize ${bad} must be refused 400/-32602 (was ${refused.status})`);
  }
  const future = await client().initialize("2099-01-01");
  expect(future.status === 200 && SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(future.body.result?.protocolVersion), `a newer unknown version must be counter-offered a supported one (was ${future.status} ${future.body.result?.protocolVersion})`);
  notes.push("2024-11-05, 2024-10-07 and malformed versions refused; 2099-01-01 counter-offered " + future.body.result.protocolVersion);
  const modernMeta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const modernHeaders = { "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" };
  const modern = await client().rpc("tools/list", { _meta: modernMeta }, modernHeaders);
  expect(modern.status === 200 && Array.isArray(modern.body.result?.tools), `a 2026-07-28 tools/list must succeed (was ${modern.status})`);
  const modernBad = await client().rpc("tools/list", { _meta: { ...modernMeta, "io.modelcontextprotocol/protocolVersion": "2026-01-01" } }, modernHeaders);
  expect(modernBad.status === 400 && modernBad.body.error?.code === -32602, `an unsupported 2026-era revision must be refused 400/-32602 (was ${modernBad.status})`);
  notes.push("2026-07-28 envelope served, unsupported 2026 revision refused");
  return notes.join("; ");
}

async function scoped(config: JourneyConfig, client: () => McpClient): Promise<string> {
  if (!config.expectedScopes) skip("expectedScopes not supplied");
  const { status, body } = await client().rpc("tools/list");
  expect(status === 200, `tools/list must succeed (was ${status})`);
  const names = (body.result.tools as { name: string }[]).map((t) => t.name).sort();
  const wanted = catalogFor(config.expectedScopes!).map((t) => t.name).sort();
  expect(JSON.stringify(names) === JSON.stringify(wanted), `tools/list must be exactly the tools the scopes allow.\n  got    ${names.join(",")}\n  wanted ${wanted.join(",")}`);
  const withheld = TOOL_CATALOG.find((t) => !config.expectedScopes!.includes(t.requiredScope));
  let detail = `${names.length} tools for scopes ${config.expectedScopes!.join(",")}`;
  if (withheld) {
    const call = await client().callTool(withheld.name, {});
    const error = toolResult(call.body)?.error?.code;
    expect(error === "insufficient_scope", `calling ${withheld.name} without ${withheld.requiredScope} must be insufficient_scope (was ${error})`);
    detail += `; ${withheld.name} refused with insufficient_scope`;
  }
  return detail;
}

async function readCall(config: JourneyConfig, client: () => McpClient): Promise<string> {
  const { status, body } = await client().callTool(config.readTool.name, config.readTool.arguments);
  const envelope = toolResult(body);
  expect(status === 200 && envelope?.ok === true, `${config.readTool.name} must succeed (was ${status} ${envelope?.error?.code ?? body.error?.message})`);
  expect(envelope.contractVersion === 3 && typeof envelope.note === "string", "the result must be the v3 envelope");
  return `${config.readTool.name} ok, contractVersion ${envelope.contractVersion}`;
}

async function streaming(config: JourneyConfig, client: () => McpClient): Promise<string> {
  const handle = await client().stream(config.readTool.name, config.readTool.arguments, "journey-progress");
  expect(handle.response.status === 200 && (handle.response.headers.get("content-type") ?? "").includes("text/event-stream"), `a call with a progressToken must stream (was ${handle.response.status} ${handle.response.headers.get("content-type")})`);
  const { progress, final, ids } = await collect(handle);
  expect(final?.result && toolResult(final)?.ok === true, "the stream must end with the tool result");
  expect(progress.length >= 1 && progress.every((p) => p.progressToken === "journey-progress"), "progress notifications must echo the progressToken");
  expect(progress.every((p, i) => i === 0 || p.progress > progress[i - 1].progress), "progress must increase");
  expect(ids.length >= 2 && ids.every((id) => stream.test(id)), `every event must carry a resumable id (saw ${JSON.stringify(ids)})`);
  return `${progress.length} progress events, ${ids.length} resumable event ids, final result delivered`;
}

async function resume(config: JourneyConfig, client: () => McpClient): Promise<string> {
  const tool = config.readTool;
  const first = await client().stream(tool.name, tool.arguments, "journey-resume");
  expect(first.response.status === 200, `stream start must be 200 (was ${first.response.status})`);
  const priming = await first.events.next();
  const primingId = priming.value?.id;
  expect(primingId && stream.test(primingId), "the first event must be a priming event carrying a resumable id");
  first.abort(); // the connection drops; MCP says that is NOT a cancellation
  const resumed = await client().resume(primingId!);
  expect(resumed.response.status === 200 && (resumed.response.headers.get("content-type") ?? "").includes("text/event-stream"), `resume must be an event stream (was ${resumed.response.status})`);
  const { final, ids } = await collect(resumed);
  expect(final?.result && toolResult(final)?.ok === true, `the resumed stream must deliver the result (got ${JSON.stringify(final)?.slice(0, 160)})`);
  expect(ids.every((id, i) => stream.test(id) && (i === 0 || Number(id.split(".")[1]) > Number(ids[i - 1].split(".")[1]))), "resumed ids must increase");
  const lastId = ids.at(-1)!;
  const again = await client().resume(lastId);
  const rest = await collect(again);
  expect(rest.final === undefined, "resuming from the final id must replay nothing");

  const garbage = await client().resume("00000000000000000000000000000000.1");
  expect(garbage.response.status === 404, `an unknown stream must be 404 (was ${garbage.response.status})`);
  await garbage.response.body?.cancel();
  const noAuth = await client().resume(primingId!, "");
  expect(noAuth.response.status === 401, `resume without a bearer must be 401 (was ${noAuth.response.status})`);
  await noAuth.response.body?.cancel();
  let isolation = "foreign-principal isolation not exercised (no foreignPrincipalToken)";
  if (config.foreignPrincipalToken) {
    const foreign = await client().resume(primingId!, config.foreignPrincipalToken);
    expect(foreign.response.status === 404, `another principal must get the same 404 for this stream (was ${foreign.response.status})`);
    await foreign.response.body?.cancel();
    isolation = "another principal gets the same 404";
  }
  return `dropped after the priming event, resumed from ${primingId} and received the result; replay from the final id is empty; unknown id 404; no bearer 401; ${isolation}`;
}

async function cancellation(config: JourneyConfig, client: () => McpClient): Promise<string> {
  const unknown = await client().cancel(987654321);
  expect(unknown.status === 202, `cancelling an unknown request must still be 202, not an oracle (was ${unknown.status})`);
  if (!config.slowTool) return "unknown-request cancel answered 202; in-flight cancel not exercised (no slowTool; the unit harness supplies one)";
  const call = await client().stream(config.slowTool.name, config.slowTool.arguments, "journey-cancel");
  await call.events.next(); // priming event: the request is now in flight
  const accepted = await client().cancel(call.requestId, "journey cancel");
  expect(accepted.status === 202, `notifications/cancelled must be 202 (was ${accepted.status})`);
  const { final } = await collect(call);
  const error = toolResult(final)?.error?.code;
  expect(error === "request_cancelled", `the in-flight call must end request_cancelled (was ${error ?? JSON.stringify(final)?.slice(0, 120)})`);
  return `cancel accepted 202; the in-flight call ended request_cancelled`;
}

async function audience(config: JourneyConfig, client: () => McpClient): Promise<string> {
  if (!config.foreignAudienceToken) skip("foreignAudienceToken not supplied");
  const other = new McpClient({ ...client().options, token: config.foreignAudienceToken });
  const { status, body } = await other.rpc("tools/list");
  expect(status === 401, `a token minted for another resource must be 401 (was ${status})`);
  expect(["invalid_token", "plugin_grant_invalid"].includes((body as any).error?.code), `refusal code must be invalid_token (was ${(body as any).error?.code})`);
  return "a token for another audience is refused with 401";
}

async function revocation(config: JourneyConfig, client: () => McpClient): Promise<string> {
  if (!config.revoke) skip("revoke not requested (destructive: needs a throwaway token)");
  const fetcher = config.fetch ?? fetch;
  const endpoint = config.revoke!.endpoint ?? `${origin(config)}/api/agent/oauth/revoke`;
  const empty = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "", redirect: "error" });
  expect(empty.status === 400, `a revocation request without a token must be 400 (was ${empty.status})`);
  const before = await client().rpc("tools/list");
  expect(before.status === 200, `the token must work before revocation (was ${before.status})`);
  const form = new URLSearchParams({ token: config.token, ...(config.workspaceId ? { workspace: config.workspaceId } : {}), ...config.revoke!.params });
  const revoked = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "error" });
  expect(revoked.status === 200, `revocation must be 200 (was ${revoked.status})`);
  const after = await client().rpc("tools/list");
  expect(after.status === 401 || after.status === 403, `the revoked token must be refused on its very next request: 401 for a credential, 403 integration_grant_required for an OAuth grant (was ${after.status})`);
  const resumed = await client().resume("00000000000000000000000000000000.1");
  expect(resumed.response.status === 401 || resumed.response.status === 403, `a revoked token must not resume streams (was ${resumed.response.status})`);
  await resumed.response.body?.cancel();
  const again = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "error" });
  expect(again.status === 200, `revoking an already revoked token must stay 200 (was ${again.status})`);
  return `revocation 200; next request ${after.status}; resume ${resumed.response.status}; second revocation 200 (no oracle)`;
}

export const STEPS: Step[] = [
  { id: "discovery", title: "RFC 9728 discovery: 401 challenge, exact resource and issuer", run: discovery },
  { id: "versions", title: "Protocol version negotiation and explicit refusal", run: versions },
  { id: "scopes", title: "Scoped tool catalog and insufficient_scope refusal", run: scoped },
  { id: "read", title: "Authenticated read call", run: readCall },
  { id: "streaming", title: "Streamed call with progress and resumable event ids", run: streaming },
  { id: "resume", title: "Reconnect with Last-Event-ID", run: resume },
  { id: "cancel", title: "Client-initiated cancellation", run: cancellation },
  { id: "audience", title: "Audience binding", run: audience },
  { id: "revocation", title: "Token revocation takes immediate effect", run: revocation },
];

export async function runJourney(config: JourneyConfig): Promise<StepResult[]> {
  // A client that has initialized sends the negotiated version; 2025-11-25 is also what makes the server send the priming event.
  const make = () => new McpClient({ url: mcpUrl(config), token: config.token, workspaceId: config.workspaceId, protocolVersion: "2025-11-25", fetch: config.fetch });
  const results: StepResult[] = [];
  for (const step of STEPS) {
    if (config.only && !config.only.includes(step.id)) continue;
    try {
      results.push({ id: step.id, title: step.title, status: "pass", detail: await step.run(config, make) });
    } catch (error) {
      if (error instanceof Skip) results.push({ id: step.id, title: step.title, status: "skip", detail: error.message });
      else results.push({ id: step.id, title: step.title, status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
