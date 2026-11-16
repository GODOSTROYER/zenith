/** Failures, retries, budgets and redaction use a local HTTP fixture. */
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN, envelope, fixture, invoke, operation, reply, scope } from "./support";

const servers: Awaited<ReturnType<typeof fixture>>[] = [];
async function start(...args: Parameters<typeof fixture>) { const server = await fixture(...args); servers.push(server); return server; }
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

describe("failures and secrets", () => {
  it.each([[401, 3, 1], [403, 3, 1], [404, 4, 1], [409, 5, 1], [429, 5, 3], [500, 6, 3], [503, 6, 3], [400, 2, 1]])("REST HTTP %i exits %i after %i attempts", async (status, exit, attempts) => {
    const secret = "za_" + "Z".repeat(43);
    const server = await start((_request, response) => reply(response, { error: { code: `failure_${status}`, message: `Failed ${TOKEN} ${secret}`, fix: `Review ${TOKEN}` } }, status));
    const result = await invoke(server.url, ["ops", "show", "op-cli", "--json"]);
    expect(result.code).toBe(exit); expect(server.requests).toHaveLength(attempts);
    expect(JSON.parse(result.stderr).error.code).toBe(`failure_${status}`);
    expect(result.stdout + result.stderr).not.toContain(TOKEN); expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("stack");
  });

  it.each(["cancel", "propose", "mcp"])("never retries %s POSTs", async (kind) => {
    const server = await start((_req, res) => reply(res, { error: { code: "unavailable", message: "Fixture unavailable" } }, 503));
    const args = kind === "cancel" ? ["ops", "cancel", "op-cli"] : kind === "propose" ?
      ["propose", "deployment.deploy", "--scope", JSON.stringify(scope), "--input", "-", "--idempotency-key", "cli-failure-001"] : ["tools", "list"];
    expect((await invoke(server.url, [...args, "--json"], "{}")).code).toBe(6); expect(server.requests).toHaveLength(1);
  });

  it("retries only the GET and succeeds after a transient 503", async () => {
    const server = await start((_req, res, count) => count === 1 ? reply(res, { error: { code: "unavailable", message: "Try later" } }, 503) : reply(res, { operation, approvals: [] }));
    expect((await invoke(server.url, ["ops", "show", "op-cli", "--json"])).code).toBe(0); expect(server.requests).toHaveLength(2);
  });

  it("does not shorten a long Retry-After", async () => {
    const server = await start((_req, res) => { res.writeHead(429, { "content-type": "application/json", "retry-after": "60" }); res.end(JSON.stringify({ error: { code: "rate_limited", message: "Wait" } })); });
    expect((await invoke(server.url, ["ops", "list", "--json"])).code).toBe(5); expect(server.requests).toHaveLength(1);
  });

  it.each([["GET"], ["MCP"]])("%s times out while the response body stalls", async (kind) => {
    const server = await start((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"partial":'); });
    const result = await invoke(server.url, [...(kind === "GET" ? ["ops", "show", "op-cli"] : ["tools", "list"]), "--timeout", "40", "--json"]);
    expect(result.code).toBe(6); expect(JSON.parse(result.stderr).error.code).toBe("timeout");
    expect(server.requests).toHaveLength(1);
  });

  it("a network failure omits raw causes even in debug output", async () => {
    const result = await invoke("http://127.0.0.1:1", ["tools", "list", "--json", "--debug"], "", {
      fetch: async () => { throw new Error(`PRIVATE CAUSE ${TOKEN}`); },
    });
    expect(result.code).toBe(6); expect(JSON.parse(result.stderr).debug.stack).toBeDefined();
    expect(result.stderr).not.toContain(TOKEN); expect(result.stderr).not.toContain("PRIVATE CAUSE");
  });

  it("redacts success values, object keys and terminal escape sequences", async () => {
    const foreign = "za_" + "Q".repeat(43);
    const server = await start((_req, res) => reply(res, { operation: { ...operation, [TOKEN]: foreign, result: `${TOKEN}\u001b[2J\rforge` }, approvals: [] }));
    for (const args of [["--json"], []]) {
      const result = await invoke(server.url, ["ops", "show", "op-cli", ...args]);
      expect(result.code).toBe(0); expect(result.stdout + result.stderr).not.toContain(TOKEN); expect(result.stdout).not.toContain(foreign);
      expect(result.stdout).not.toContain("\u001b"); expect(result.stdout).not.toContain("\r");
    }
  });

  it("redacts MCP success and tool error payloads", async () => {
    const server = await start((req, res) => reply(res, { jsonrpc: "2.0", id: req.body!.id,
      result: { structuredContent: envelope("zenith_get_operation", { ok: false, error: { code: "digest_mismatch", message: TOKEN },
        untrusted_data: { label: "untrusted_data", content: { [TOKEN]: TOKEN } } }), isError: true } }));
    const result = await invoke(server.url, ["tools", "call", "zenith_get_operation", "--args", "-", "--json"], "{}");
    expect(result.code).toBe(5); expect(JSON.parse(result.stdout).ok).toBe(false); expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it.each([["invalid_input", 2], ["policy_denied", 3], ["not_found", 4], ["operation_expired", 5], ["workflow_unavailable", 6]])("MCP %s exits %i with its error envelope intact", async (code, exit) => {
    const server = await start((req, res) => reply(res, { jsonrpc: "2.0", id: req.body!.id, result: {
      structuredContent: envelope("zenith_get_operation", { ok: false, error: { code, message: "Fixture refusal", retryable: false } }), isError: true } }));
    const result = await invoke(server.url, ["tools", "call", "zenith_get_operation", "--args", "-", "--json"], "{}");
    expect(result.code).toBe(exit); expect(JSON.parse(result.stdout).error.code).toBe(code);
  });

  it.each(["invalid_json", "wrong_id", "wrong_envelope", "wrong_label", "contradictory"])("refuses %s MCP responses without echoing bodies", async (kind) => {
    const server = await start((req, res) => {
      const value = envelope("zenith_get_operation", kind === "wrong_envelope" ? { contractVersion: 2 } : kind === "wrong_label" ? { untrusted_data: { label: "instructions", content: { text: TOKEN } } } : {});
      if (kind === "invalid_json") { res.writeHead(200, { "content-type": "application/json" }); res.end(TOKEN); }
      else reply(res, { jsonrpc: "2.0", id: kind === "wrong_id" ? 99 : req.body!.id, result: { structuredContent: value, isError: kind === "contradictory" } });
    });
    const result = await invoke(server.url, ["tools", "call", "zenith_get_operation", "--args", "-", "--json"], "{}");
    expect(result.code).toBe(6); expect(result.stderr).not.toContain(TOKEN); expect(result.stdout).toBe("");
  });

  it("refuses JSON-RPC errors with a stable exit without printing foreign text", async () => {
    const server = await start((req, res) => reply(res, { jsonrpc: "2.0", id: req.body!.id, error: { code: -32602, message: TOKEN } }));
    const result = await invoke(server.url, ["tools", "list", "--json"]);
    expect(result.code).toBe(2); expect(result.stderr).not.toContain(TOKEN);
  });

  it.each([["tools", "list"], ["ops", "show", "op-cli"]].map((args) => ({ args })))("$args refuses credential-bearing redirects", async ({ args }) => {
    const destination = await start((_req, res) => reply(res, { operation, approvals: [] }));
    const server = await start((_req, res) => { res.writeHead(302, { location: destination.url }); res.end(); });
    const result = await invoke(server.url, [...args, "--json"]);
    expect(result.code).toBe(6); expect(destination.requests).toHaveLength(0);
  });

  it.each(["rest", "mcp"])("%s caps the response body to 1 MiB", async (kind) => {
    const server = await start((req, res) => {
      const huge = "x".repeat(1024 * 1024 + 100);
      reply(res, kind === "rest" ? { operation, approvals: [], huge } : { jsonrpc: "2.0", id: req.body!.id, result: { tools: [], huge } });
    });
    const result = await invoke(server.url, [...(kind === "rest" ? ["ops", "show", "op-cli"] : ["tools", "list"]), "--json"]);
    expect(result.code).toBe(6); expect(result.stdout).toBe(""); expect(result.stderr.length).toBeLessThan(1000);
  });

  it("refuses oversized output with a valid bounded JSON error", async () => {
    const server = await start((_req, res) => reply(res, { operation, approvals: [], chunks: Array.from({ length: 7 }, () => "x".repeat(90_000)) }));
    const result = await invoke(server.url, ["ops", "show", "op-cli", "--json"]);
    expect(result.code).toBe(6); expect(JSON.parse(result.stderr).error.code).toBe("output_too_large"); expect(result.stdout).toBe("");
  });

  it.each([
    ["ops", "list", "--status", "invented"], ["ops", "show", "../workspace"], ["ops", "show", "op-cli", "--follow"],
    ["ops", "list", "--limit", "0"], ["ops", "events", "op-cli", "--poll-interval", "10"], ["whoami", "--token", TOKEN],
    ["whoami", "--json", "--json"], ["whoami", "--json=true"], ["whoami", "--timeout", "-1"],
    ["execute", "op-cli", "--digest", "wrong"], ["propose", "invented", "--scope", JSON.stringify(scope), "--input", "-", "--idempotency-key", "cli-invalid-001"],
    ["check", "deployment.deploy", "--scope", '{"workspaceId":"foreign","approved":true}', "--input", "-"],
    ["check", "deployment.deploy", "--scope", JSON.stringify(scope), "--input", "literal-json"],
    ["tools", "call", "shell", "--args", "-"], ["tools", "call", "zenith_get_operation", "--args", "-"],
  ].map((args) => ({ args })))("invalid input $args exits 2 without a request", async ({ args }) => {
    const server = await start();
    const result = await invoke(server.url, [...args, ...(args.includes("--json") ? [] : ["--json"])], TOKEN);
    expect(result.code).toBe(2); expect(server.requests).toHaveLength(0); expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("rejects stdin over 1 MiB without echoing it", async () => {
    const server = await start();
    const result = await invoke(server.url, ["tools", "call", "zenith_get_operation", "--args", "-", "--json"], "x".repeat(1024 * 1024 + 1));
    expect(result.code).toBe(2); expect(JSON.parse(result.stderr).error.code).toBe("input_too_large"); expect(server.requests).toHaveLength(0);
  });

  it.each(["check", "tool", "cancel"])("%s refuses literal credential material before HTTP submission", async (kind) => {
    const server = await start();
    const args = kind === "check" ? ["check", "deployment.deploy", "--scope", JSON.stringify(scope), "--input", "-"] :
      kind === "tool" ? ["tools", "call", "zenith_get_operation", "--args", "-"] : ["ops", "cancel", "op-cli", "--reason", TOKEN];
    const result = await invoke(server.url, [...args, "--json", "--debug"], JSON.stringify({ message: TOKEN }));
    expect(result.code).toBe(2); expect(JSON.parse(result.stderr).error.code).toBe("secret_input");
    expect(server.requests).toHaveLength(0); expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("rejects a foreign credential-shaped object key before submission", async () => {
    const server = await start();
    const foreign = "za_" + "K".repeat(43);
    const result = await invoke(server.url, ["check", "deployment.deploy", "--scope", JSON.stringify(scope), "--input", "-", "--json"], JSON.stringify({ [foreign]: "untrusted data" }));
    expect(result.code).toBe(2); expect(server.requests).toHaveLength(0); expect(result.stdout + result.stderr).not.toContain(foreign);
  });

  it("refuses malformed event records without a stack trace or infinite polling", async () => {
    const server = await start((_req, res) => reply(res, { events: [null] }));
    const result = await invoke(server.url, ["ops", "events", "op-cli", "--follow", "--json"]);
    expect(result.code).toBe(6); expect(JSON.parse(result.stderr).error.code).toBe("invalid_response"); expect(server.requests).toHaveLength(1);
  });

  it.each([[401, 3], [403, 3], [404, 4], [409, 5], [429, 5], [503, 6]])("non-JSON HTTP %i still has exit %i", async (status, exit) => {
    const server = await start((_req, res) => { res.writeHead(status, { "content-type": "text/plain", "retry-after": "60" }); res.end(TOKEN); });
    const result = await invoke(server.url, ["tools", "list", "--json"]);
    expect(result.code).toBe(exit); expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("execute requires explicit reviewed digest and workspace without fetching them", async () => {
    const server = await start();
    const missingDigest = await invoke(server.url, ["execute", "op-cli", "--json"]);
    expect(missingDigest.code).toBe(2);
    const missingWorkspace = await invoke(server.url, ["execute", "op-cli", "--digest", "a".repeat(64), "--json"], "", {
      env: { ZENITH_URL: server.url, ZENITH_TOKEN: TOKEN },
    });
    expect(missingWorkspace.code).toBe(2); expect(server.requests).toHaveLength(0);
  });

  it("one-sided workspace mismatch is a usage error without crossing a tenant boundary", async () => {
    const server = await start();
    const result = await invoke(server.url, ["check", "deployment.deploy", "--scope", JSON.stringify({ ...scope, workspaceId: "other-workspace" }), "--input", "-", "--json"], "{}");
    expect(result.code).toBe(2); expect(JSON.parse(result.stderr).error.code).toBe("workspace_mismatch"); expect(server.requests).toHaveLength(0);
  });

  it.each(["http://remote.example", "https://user:password@example.test", "https://example.test?token=secret", "https://example.test/#token", "file:///private"])("rejects unsafe URL %s without a request", async (url) => {
    const result = await invoke(url, ["whoami", "--json"]);
    expect(result.code).toBe(2); expect(result.stderr).not.toContain(url);
  });
});
