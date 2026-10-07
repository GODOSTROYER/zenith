/* eslint-disable @typescript-eslint/no-explicit-any */
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
 *   --official              also run the official MCP SDK client leg (needs @modelcontextprotocol/client)
 *   --print-commands        print the commands for real coding-agent clients and exit
 *
 * Every flag has an environment equivalent: ZENITH_CONFORMANCE_URL, _TOKEN, _WORKSPACE,
 * _TOOL, _ARGS, _SCOPES, _ISSUER. Preferring the environment keeps tokens out of shell history.
 */
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
  npm install --no-save @modelcontextprotocol/client@2.0.0 && npm run agent:conformance -- --official ...

Revocation from a terminal (RFC 7009; works for za_, zp_ and OAuth access tokens)
  curl -sS -X POST ${url.replace(/\/+$/, "")}/api/agent/oauth/revoke \\
    -d token="$ZENITH_TOKEN" -d workspace="$ZENITH_WORKSPACE"
`;
}

/** The same calls through the official SDK client, when the verifier has installed it. */
async function officialLeg(config: JourneyConfig): Promise<StepResult> {
  const id = "official-sdk";
  const title = "Official MCP SDK client: connect, list tools, call with progress";
  const specifier = "@modelcontextprotocol/client";
  let sdk: any;
  try { sdk = await import(/* @vite-ignore */ specifier); } catch {
    return { id, title, status: "skip", detail: "@modelcontextprotocol/client is not installed (npm install --no-save @modelcontextprotocol/client@2.0.0). Its 2.0.0 API surface was NOT verified by the builder." };
  }
  try {
    const url = new URL("/api/agent/v3/mcp", config.baseUrl);
    const transport = new sdk.StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${config.token}`, ...(config.workspaceId ? { "x-zenith-workspace": config.workspaceId } : {}) } } });
    const client = new sdk.Client({ name: "zenith-conformance-official", version: "1" });
    await client.connect(transport);
    const tools = await client.listTools();
    let progress = 0;
    const result = await client.callTool({ name: config.readTool.name, arguments: config.readTool.arguments }, undefined, { onprogress: () => { progress += 1; } });
    await client.close();
    const ok = result?.structuredContent?.ok === true;
    return { id, title, status: ok ? "pass" : "fail", detail: `${tools.tools?.length ?? 0} tools listed, ${config.readTool.name} ok=${ok}, ${progress} progress callbacks` };
  } catch (error) {
    return { id, title, status: "fail", detail: error instanceof Error ? error.message.replaceAll(config.token, "[REDACTED]").slice(0, 300) : "failed" };
  }
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
  try { args = JSON.parse(flags.get("args") ?? env.ZENITH_CONFORMANCE_ARGS ?? "{}"); } catch { console.error("--args must be a JSON object."); process.exit(2); }
  const scopes = (flags.get("scopes") ?? env.ZENITH_CONFORMANCE_SCOPES)?.split(",").map((s) => s.trim()).filter(Boolean);
  const only = flags.get("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (only?.some((id) => !STEPS.some((s) => s.id === id))) { console.error(`Unknown step. Steps: ${STEPS.map((s) => s.id).join(", ")}`); process.exit(2); }
  const config: JourneyConfig = {
    baseUrl: url, token, workspaceId: flags.get("workspace") ?? env.ZENITH_CONFORMANCE_WORKSPACE,
    readTool: { name: flags.get("tool") ?? env.ZENITH_CONFORMANCE_TOOL ?? "zenith_get_topology", arguments: args },
    ...(scopes ? { expectedScopes: scopes } : {}),
    expectedIssuer: flags.get("issuer") ?? env.ZENITH_CONFORMANCE_ISSUER,
    discoverAuthorizationServer: bool.has("discover-issuer"),
    foreignAudienceToken: flags.get("foreign-audience-token"), foreignPrincipalToken: flags.get("foreign-principal-token"),
    ...(bool.has("revoke") ? { revoke: {} } : {}), ...(only ? { only } : {}),
  };
  const results = await runJourney(config);
  if (bool.has("official")) results.push(await officialLeg(config));
  const redact = (text: string) => text.replaceAll(token, "[REDACTED]");
  if (bool.has("json")) console.log(JSON.stringify(results.map((r) => ({ ...r, detail: redact(r.detail) })), null, 2));
  else for (const r of results) console.log(`${{ pass: "PASS", fail: "FAIL", skip: "SKIP" }[r.status]}  ${r.id.padEnd(10)} ${r.title}\n      ${redact(r.detail).split("\n").join("\n      ")}`);
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped (a skip is not a pass: it names what the supplied configuration could not exercise).`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error("conformance run failed:", error instanceof Error ? error.message : error); process.exit(1); });
