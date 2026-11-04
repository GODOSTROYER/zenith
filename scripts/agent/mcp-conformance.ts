/**
 * Client interoperability conformance for Zenith's MCP v3 endpoint (PROD-UX-02).
 *
 *   npm run agent:conformance -- --url https://zenith.example --token za_... \
 *     --workspace WS --tool zenith_get_topology \
 *     --args '{"target":{"workspaceId":"WS","projectId":"P","environmentId":"E"}}' \
 *     --scopes read,plan,logs --issuer https://issuer.example
 *
 * Runs the journey in scripts/agent/mcp-conformance/journey.ts against a real
 * deployment (or `npm run dev` on loopback) and prints one line per step. Exit
 * code 1 if any step fails. Tokens are never printed.
 *
 *   --revoke                destructive: revokes --token at the end. Use a throwaway token.
 *   --discover-issuer       also fetch and check the issuer's RFC 8414 / OIDC metadata
 *   --foreign-audience-token  a valid token minted for ANOTHER resource (must be refused)
 *   --foreign-principal-token a different valid principal (must not resume your streams)
 *   --only a,b              run only these step ids
 *   --json                  machine-readable output
 *   --official              also run the pinned official MCP SDK 2.2.0 client leg
 *   --foreign-issuer-token  a valid signed token minted by ANOTHER issuer (must be refused)
 *   --slow-tool / --slow-args a disposable held read for in-flight cancellation
 *   --print-commands        print the commands for real coding-agent clients and exit
 *
 * Every flag has an environment equivalent: ZENITH_CONFORMANCE_URL, _TOKEN, _WORKSPACE,
 * _TOOL, _ARGS, _SCOPES, _ISSUER. Preferring the environment keeps tokens out of shell history.
 */
import { pathToFileURL } from "node:url";
import { Client, ProtocolError, SdkHttpError, StreamableHTTPClientTransport, type CallToolResult, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { catalogFor, TOOL_CATALOG } from "../../src/lib/agent-access/v3/catalog";
import { runJourney, STEPS, type JourneyConfig, type StepResult } from "./mcp-conformance/journey";

function parse(argv: string[]): { flags: Map<string, string>; bool: Set<string> } {
  const flags = new Map<string, string>();
  const bool = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (["revoke", "json", "official", "print-commands", "discover-issuer", "help"].includes(name)) bool.add(name);
    else flags.set(name, argv[(i += 1)] ?? "");
  }
  return { flags, bool };
}

const USAGE = `Usage: npm run agent:conformance -- --url <origin> --token <bearer> [--workspace id] [--tool name] [--args json]
  [--scopes read,plan] [--issuer url] [--discover-issuer] [--foreign-audience-token t] [--foreign-principal-token t]
  [--only steps] [--revoke] [--json] [--official] [--print-commands]
  [--foreign-issuer-token t] [--slow-tool name] [--slow-args json]
Steps: ${STEPS.map((step) => step.id).join(", ")}
Environment: ZENITH_CONFORMANCE_URL, _TOKEN, _WORKSPACE, _TOOL, _ARGS, _SCOPES, _ISSUER`;

export function printCommands(url: string): string {
  const mcp = `${url.replace(/\/+$/, "")}/api/agent/v3/mcp`;
  return `
Real coding-agent clients against ${mcp}

Claude Code (linked credential: run \`zenith login\` first, or paste a za_ token)
  claude mcp add --transport http zenith ${mcp} \\
    --header "Authorization: Bearer $ZENITH_TOKEN" --header "x-zenith-workspace: $ZENITH_WORKSPACE"
  claude mcp list                 # zenith should be Connected
  # then ask the agent to call zenith_get_topology; /mcp shows the server and its tools

Claude Code (OAuth, when ZENITH_AGENT_OAUTH_ISSUER is configured and the issuer supports client registration)
  claude mcp add --transport http zenith ${mcp} --header "x-zenith-workspace: $ZENITH_WORKSPACE"
  # inside Claude Code run /mcp, choose zenith, Authenticate: the browser consent is the ISSUER's;
  # then authorize that client id in Zenith > Integrations > Connect an OAuth client.

Codex CLI (~/.codex/config.toml)
  [mcp_servers.zenith]
  url = "${mcp}"
  bearer_token_env_var = "ZENITH_TOKEN"
  http_headers = { "x-zenith-workspace" = "<workspace id>" }

MCP Inspector (any transport-level check, including Last-Event-ID and cancellation in its UI)
  npx @modelcontextprotocol/inspector      # Transport: Streamable HTTP, URL ${mcp},
                                           # Authentication header: Authorization: Bearer <token>

Official MCP SDK client
  npm run agent:conformance -- --official ... # pinned @modelcontextprotocol/client@2.2.0 is installed
  # Local Keycloak/TLS/DCR setup and operated-client checklist:
  # docs/build/production/verify/PROD-UX-02.md

Revocation from a terminal (RFC 7009; works for za_, zp_ and OAuth access tokens)
  curl -sS -X POST ${url.replace(/\/+$/, "")}/api/agent/oauth/revoke \\
    -d token="$ZENITH_TOKEN" -d workspace="$ZENITH_WORKSPACE"
`;
}

export interface OfficialConfig extends JourneyConfig { foreignIssuerToken?: string }
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const envelope = (result: CallToolResult) => object(result.structuredContent);
const eventId = /^[0-9a-f]{32}\.[1-9][0-9]*$/;
const TIMEOUT = 15_000;
class UnavailableCheck extends Error {}

/** Redact every supplied bearer, including negative-test credentials. */
export function redactDetail(detail: string, config: OfficialConfig): string {
  for (const token of [config.token, config.foreignAudienceToken, config.foreignPrincipalToken, config.foreignIssuerToken]) {
    if (token) detail = detail.replaceAll(token, "[REDACTED]");
  }
  return detail;
}

function transportFor(config: OfficialConfig, token = config.token, version = "2025-11-25") {
  return new StreamableHTTPClientTransport(new URL("/api/agent/v3/mcp", config.baseUrl), {
    requestInit: { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(config.workspaceId ? { "x-zenith-workspace": config.workspaceId } : {}) } },
    protocolVersion: version, fetch: config.fetch, onInsufficientScope: "throw",
    reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 100, maxReconnectionDelay: 2000, reconnectionDelayGrowFactor: 1.5 },
  });
}

async function withClient<T>(config: OfficialConfig, version: string, run: (client: Client) => Promise<T>, token = config.token): Promise<T> {
  const client = new Client({ name: "zenith-conformance-official", version: "2.0.0" }, {
    supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  const transport = transportFor(config, token, version);
  try {
    await client.connect(transport, { timeout: TIMEOUT });
    assert(transport.protocolVersion === version, `Expected protocol ${version}, got ${transport.protocolVersion}`);
    return await run(client);
  } finally { await client.close(); }
}

async function refused(run: () => Promise<unknown>, statuses: number[]): Promise<void> {
  try { await run(); } catch (error) {
    if (error instanceof SdkHttpError && statuses.includes(error.data.status)) return;
    throw error;
  }
  throw new Error(`Expected HTTP refusal ${statuses.join("/")}, request succeeded`);
}

/** SDK parses the replay, rather than a second custom SSE implementation. */
export async function replay(config: OfficialConfig, id: string, token = config.token): Promise<JSONRPCMessage> {
  const transport = transportFor(config, token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const final = new Promise<JSONRPCMessage>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("SDK resume timed out waiting for final result")), TIMEOUT);
    transport.onerror = reject;
    transport.onmessage = (message) => { if (!("method" in message)) resolve(message); };
  });
  // Attach immediately: a refused GET must not leave an unhandled rejection.
  void final.catch(() => undefined);
  try {
    await transport.start();
    // Bound the GET's header wait too, then abort it through SDK cleanup.
    await Promise.race([transport.resumeStream(id), final]);
    return await final;
  }
  finally { clearTimeout(timer); await transport.close(); }
}

/** All checks use the installed official SDK's public 2.0 API, with bounded cleanup. */
export async function officialLeg(config: OfficialConfig): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const step = async (id: string, title: string, run: () => Promise<string>) => {
    try { results.push({ id, title, status: "pass", detail: await run() }); }
    catch (error) { results.push({ id, title, status: error instanceof UnavailableCheck ? "skip" : "fail",
      detail: redactDetail(error instanceof Error ? error.message : "failed", config).slice(0, 500) }); }
  };
  for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2026-07-28"]) {
    await step(`official-${version}`, `Official SDK: ${version} tools/list and tools/call`, () => withClient(config, version, async (client) => {
      const listed = await client.listTools(undefined, { timeout: TIMEOUT });
      assert(listed.tools.some((t) => t.name === config.readTool.name), "Read tool missing from tools/list");
      const result = await client.callTool(config.readTool, { timeout: TIMEOUT });
      assert(!result.isError && envelope(result).ok === true && envelope(result).contractVersion === 3, "Read did not return a successful v3 envelope");
      return `${listed.tools.length} tools; ${config.readTool.name} returned v3 success`;
    }));
  }
  await step("official-scopes", "Official SDK: scoped catalog and withheld tool refusal", async () => {
    if (!config.expectedScopes) throw new UnavailableCheck("Supply --scopes to check the exact consent intersection");
    return withClient(config, "2025-11-25", async (client) => {
      const listed = await client.listTools(undefined, { timeout: TIMEOUT });
      assert(JSON.stringify(listed.tools.map((t) => t.name).sort()) === JSON.stringify(catalogFor(config.expectedScopes!).map((t) => t.name).sort()), "Catalog differs from expected effective scopes");
      const withheld = TOOL_CATALOG.find((t) => !config.expectedScopes!.includes(t.requiredScope));
      if (withheld) {
        try { await client.callTool({ name: withheld.name, arguments: {} }, { timeout: TIMEOUT }); }
        catch (error) { if (error instanceof ProtocolError && error.code === -32602) return `Scoped catalog exact; ${withheld.name} refused -32602`; throw error; }
        throw new Error("Withheld tool was callable");
      }
      return "All scopes supplied; exact full catalog checked";
    });
  });
  await step("official-auth", "Official SDK: unauthenticated connect refused", async () => {
    await refused(() => withClient(config, "2025-11-25", async () => undefined, ""), [401]);
    return "No bearer: HTTP 401";
  });
  for (const [kind, token] of [["audience", config.foreignAudienceToken], ["issuer", config.foreignIssuerToken]] as const) {
    await step(`official-${kind}`, `Official SDK: foreign OAuth ${kind} refused`, async () => {
      if (!token) throw new UnavailableCheck(`Supply a valid signed foreign-${kind}-token to exercise this refusal`);
      await refused(() => withClient(config, "2025-11-25", async () => undefined, token), [401]);
      return `Foreign ${kind}: HTTP 401`;
    });
  }
  await step("official-old-version", "Official SDK: unsupported legacy version refused", async () => {
    await refused(() => withClient(config, "2024-11-05", async () => undefined), [400]);
    return "2024-11-05: HTTP 400";
  });
  let firstId: string | undefined;
  await step("official-stream-resume", "Official SDK: progress, event ids, durable result replay", async () => {
    const ids: string[] = [];
    const progress: number[] = [];
    await withClient(config, "2025-11-25", async (client) => {
      const result = await client.callTool(config.readTool, { timeout: TIMEOUT,
        onprogress: (p) => { progress.push(p.progress); }, onresumptiontoken: (id) => { ids.push(id); } });
      assert(!result.isError && envelope(result).ok === true, "Streamed call failed");
    });
    assert(progress.length > 0 && progress.every((n, i) => i === 0 || n > progress[i - 1]), "No increasing SDK progress callbacks");
    assert(ids.length >= 2 && ids.every((id, i) => eventId.test(id) && (i === 0 || id.split(".")[0] === ids[0].split(".")[0] && Number(id.split(".")[1]) > Number(ids[i - 1].split(".")[1]))), "Missing or nonmonotonic durable event ids");
    firstId = ids[0];
    const message = await replay(config, firstId);
    assert("result" in message && object(object(message.result).structuredContent).ok === true, "SDK replay did not deliver the saved result");
    return `${progress.length} SDK progress callbacks; ${ids.length} ids; result replayed via SDK GET Last-Event-ID`;
  });
  await step("official-resume-isolation", "Official SDK: another principal cannot resume", async () => {
    if (!config.foreignPrincipalToken) throw new UnavailableCheck("Supply --foreign-principal-token for resume isolation");
    assert(firstId, "No resumable stream was produced");
    await refused(() => replay(config, firstId!, config.foreignPrincipalToken), [404]);
    return "Foreign principal: HTTP 404";
  });
  await step("official-cancel", "Official SDK: in-flight cancellation reaches server", async () => {
    if (!config.slowTool) throw new UnavailableCheck("No slowTool supplied; operated in-flight cancellation needs a held read");
    assert(TOOL_CATALOG.some((tool) => tool.name === config.slowTool!.name && tool.access === "read"), "Cancellation probe must use a read tool");
    let id: string | undefined;
    const controller = new AbortController();
    await withClient(config, "2025-11-25", async (client) => {
      let cancelled = false;
      try { await client.callTool(config.slowTool!, { timeout: TIMEOUT, signal: controller.signal,
        onresumptiontoken: (value) => { id ??= value; }, onprogress: () => controller.abort() }); }
      catch (error) { if (!controller.signal.aborted) throw error; cancelled = true; }
      assert(cancelled && id, "Call completed before cancellation could be exercised");
      const message = await replay(config, id!);
      const result = "result" in message ? object(message.result) : {};
      assert(result.isError === true && object(object(result.structuredContent).error).code === "request_cancelled", "Server did not record request_cancelled");
    });
    return "SDK AbortSignal sent cancellation; durable final envelope is request_cancelled";
  });
  await step("official-revocation", "Official SDK: revoked credential refused immediately", async () => {
    if (!config.revoke) throw new UnavailableCheck("--revoke not requested; use a disposable credential");
    const response = await (config.fetch ?? fetch)(config.revoke.endpoint ?? new URL("/api/agent/oauth/revoke", config.baseUrl), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT),
      body: new URLSearchParams({ token: config.token, ...(config.workspaceId ? { workspace: config.workspaceId } : {}), ...config.revoke.params }),
    });
    assert(response.status === 200 && await response.text() === "", "RFC 7009 revocation must be empty HTTP 200");
    await refused(() => withClient(config, "2025-11-25", async () => undefined), [401, 403]);
    return "Revoked via resource endpoint; next SDK connect refused 401/403";
  });
  return results;
}

async function main(): Promise<void> {
  const { flags, bool } = parse(process.argv.slice(2));
  const env = process.env;
  const url = flags.get("url") ?? env.ZENITH_CONFORMANCE_URL ?? "";
  if (bool.has("help")) { console.log(USAGE); return; }
  if (bool.has("print-commands") && !url) { console.log(printCommands("https://YOUR-ZENITH-HOST")); return; }
  if (bool.has("print-commands")) { console.log(printCommands(url)); return; }
  const token = flags.get("token") ?? env.ZENITH_CONFORMANCE_TOKEN ?? "";
  if (!url || !token) { console.error("Set --url and --token (or ZENITH_CONFORMANCE_URL and ZENITH_CONFORMANCE_TOKEN). Run with --help."); process.exit(2); }
  let args: Record<string, unknown>;
  let slowArgs: Record<string, unknown>;
  try {
    args = JSON.parse(flags.get("args") ?? env.ZENITH_CONFORMANCE_ARGS ?? "{}");
    slowArgs = JSON.parse(flags.get("slow-args") ?? env.ZENITH_CONFORMANCE_SLOW_ARGS ?? "{}");
    if (!args || Array.isArray(args) || typeof args !== "object" || !slowArgs || Array.isArray(slowArgs) || typeof slowArgs !== "object") throw new Error("object required");
  } catch { console.error("--args and --slow-args must be JSON objects."); process.exit(2); }
  const scopes = (flags.get("scopes") ?? env.ZENITH_CONFORMANCE_SCOPES)?.split(",").map((s) => s.trim()).filter(Boolean);
  const only = flags.get("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (only?.some((id) => !STEPS.some((s) => s.id === id))) { console.error(`Unknown step. Steps: ${STEPS.map((s) => s.id).join(", ")}`); process.exit(2); }
  const config: OfficialConfig = {
    baseUrl: url, token, workspaceId: flags.get("workspace") ?? env.ZENITH_CONFORMANCE_WORKSPACE,
    readTool: { name: flags.get("tool") ?? env.ZENITH_CONFORMANCE_TOOL ?? "zenith_get_topology", arguments: args },
    ...(scopes ? { expectedScopes: scopes } : {}),
    expectedIssuer: flags.get("issuer") ?? env.ZENITH_CONFORMANCE_ISSUER,
    discoverAuthorizationServer: bool.has("discover-issuer"),
    foreignAudienceToken: flags.get("foreign-audience-token") ?? env.ZENITH_CONFORMANCE_FOREIGN_AUDIENCE_TOKEN,
    foreignIssuerToken: flags.get("foreign-issuer-token") ?? env.ZENITH_CONFORMANCE_FOREIGN_ISSUER_TOKEN,
    foreignPrincipalToken: flags.get("foreign-principal-token") ?? env.ZENITH_CONFORMANCE_FOREIGN_PRINCIPAL_TOKEN,
    ...((flags.get("slow-tool") ?? env.ZENITH_CONFORMANCE_SLOW_TOOL) ? { slowTool: { name: (flags.get("slow-tool") ?? env.ZENITH_CONFORMANCE_SLOW_TOOL)!, arguments: slowArgs } } : {}),
    ...(bool.has("revoke") ? { revoke: {} } : {}), ...(only ? { only } : {}),
  };
  for (const probe of [config.readTool, config.slowTool]) {
    if (probe && !TOOL_CATALOG.some((tool) => tool.name === probe.name && tool.access === "read")) {
      console.error("Conformance probes must name catalog read tools."); process.exit(2);
    }
  }
  // Revocation is last and performed once: otherwise --official sees an already revoked token.
  const results = await runJourney(bool.has("official") ? { ...config, only: (only ?? STEPS.map((s) => s.id)).filter((id) => id !== "revocation") } : config);
  if (bool.has("official")) results.push(...await officialLeg(config));
  const redact = (text: string) => redactDetail(text, config);
  if (bool.has("json")) console.log(JSON.stringify(results.map((r) => ({ ...r, detail: redact(r.detail) })), null, 2));
  else for (const r of results) console.log(`${{ pass: "PASS", fail: "FAIL", skip: "SKIP" }[r.status]}  ${r.id.padEnd(10)} ${r.title}\n      ${redact(r.detail).split("\n").join("\n      ")}`);
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const summary = `\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped (a skip is not a pass: it names what the supplied configuration could not exercise).`;
  if (bool.has("json")) console.error(summary); else console.log(summary);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("conformance run failed (details omitted to protect credentials)"); process.exit(1); });
}
