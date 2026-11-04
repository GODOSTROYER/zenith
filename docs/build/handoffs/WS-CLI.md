# WS-CLI — the `zenith` command-line interface

Workstream: WS-CLI (new; orchestrator brief) — Branch ws/cli — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-cli
Base: platform/integration @ e92a3df (tsc clean)

## Situation
- Typed REST SDK: `src/lib/sdk/{client,errors,types,index}.ts` (over /api/platform/v1).
- MCP v3 endpoint: `POST /api/agent/v3/mcp` (bearer `za_…` credential; 14 semantic tools;
  docs/platform/MCP.md). Approvals are browser-only and human-only by design.
- No CLI exists.

## Objective
A small, dependable `zenith` CLI for operators and scripts, built only on the SDK and the MCP
endpoint — no direct store, cloud or credential access.

## Owned paths
src/cli/** (new) ; tests/cli/** (new) ; docs/platform/CLI.md (new).
The orchestrator adds the package.json `bin` entry and an npm script afterwards — describe the
exact entry you want in your report (e.g. `"bin": { "zenith": "src/cli/bin.ts" }` run via tsx, or
a bundled file) and make the entry file executable with a shebang.

## Build
1. Config/auth: base URL from `--url` / `ZENITH_URL`; credential from `ZENITH_TOKEN` or
   `zenith login --token-stdin` stored in a per-user config file with 0600 permissions (Windows:
   user profile dir; never world-readable), `zenith logout` removes it. Never print the token;
   errors never echo it.
2. Commands (human tables by default, `--json` for scripts, stable exit codes documented):
   - `zenith whoami`
   - `zenith ops list [--status] [--env]`, `zenith ops show <id>`, `zenith ops events <id> [--follow]`,
     `zenith ops cancel <id>`
   - `zenith propose <capability> --scope … --input @file.json|-` and `zenith check …` (dry run)
   - `zenith approve <id>` → refuses and prints the browser URL to review/approve (explain why)
   - `zenith tools list` and `zenith tools call <name> --args @file.json|-` over MCP v3
     (JSON-RPC over HTTP; handle the untrusted_data envelope: print data clearly marked as data)
   - `zenith execute <operationId>` → MCP `zenith_execute_approved_operation`
3. Robustness: timeouts, retries only for idempotent GETs, clear messages for 401/403/404/409/429/5xx
   using the SDK error types, no stack traces unless `--debug`, output bounded.
4. Tests against a local fake HTTP server (node:http): every command's request shape, auth header,
   JSON output, exit codes, token never in output/errors, config file permissions (POSIX mode
   check skipped on Windows with a note), `--follow` termination.
5. docs/platform/CLI.md: install/run, auth, every command with an example, exit codes, security notes.

## Verification
- npx tsc --noEmit ; npx eslint src/cli tests/cli
- npx vitest run --maxWorkers=2 tests/cli tests/agent-v3/sdk.test.ts
