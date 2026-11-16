/**
 * What an agent actually receives over MCP v1, end to end (WS-SEC).
 *
 * `redaction-coverage.test.ts` measures the redactor in isolation. This drives
 * the REAL reader transport (`createReaderHandler`, the JSON-RPC handler behind
 * `/api/agent/v1/mcp`) with the REAL tool implementations (`callReader`) over a
 * populated store, with a canary planted in every place a tenant's own data
 * could hold a secret, and scans the wire responses.
 *
 * Planted (see tests/_support/security/fixtures.ts):
 *   envValue             literal env var value in the working manifest (key `value`)
 *   outputPassword       a `connection` deployment output (key `value`)
 *   stepErrorPassword    a provider error echoing `postgres://app:<pw>@…` (step.error)
 *   stepDetailAwsSecret  raw provider detail `aws_secret_access_key=<…>` (step.detail)
 *   findingJwt           a token quoted in a security finding's detail text
 *   logToken             a bearer token in a deployment LOG line
 *
 * The expectation is split the way the architecture splits it. Values that
 * travel under a key NAMED `value` / `password` / … are removed by key-name
 * redaction, and logs are excluded from the events tool by design. Secrets that
 * travel as free text inside another field are NOT removed — that is what
 * "conservative redaction is not a secret detector" means — and they are
 * pinned in `KNOWN_LEAKS` so the exposure is a checked claim: the ratchet fails
 * if a leak is added and if one is fixed without updating the threat model.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Credential } from "@/lib/agent-access/security";
import { tempDataDir } from "../_support/data-dir";
import { deepScanForCanaries, twoTenantFixture, type TenantCanaries } from "../_support/security";

tempDataDir("zenith-sec-mcp-leak-", { fast: true });
process.env.ZENITH_AGENT_ORIGIN = "http://127.0.0.1:3400";

const fx = twoTenantFixture();
const { resetDb, appendEvent } = await import("@/lib/db/store");
const { createReaderHandler } = await import("@/lib/agent-access/http");
const { callReader, readerTools, registerReaderProviders } = await import("@/lib/agent-access/zenith-reader");
const { registerAllActions } = await import("@/lib/actions/defs");

const { alpha } = fx;
const token = `za_${"C".repeat(43)}`;
const credential: Credential = {
  id: "cred-alice-mcp",
  tokenHash: "0".repeat(64),
  subject: alpha.memberId,
  workspaceId: alpha.workspaceId,
  projectIds: [alpha.projectId],
  scopes: ["read", "plan", "export", "logs"],
  issuedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const handler = createReaderHandler({
  enabled: async () => true,
  authority: () => ({ kind: "file", ready: async () => undefined, verify: async () => credential }),
  origin: "http://127.0.0.1:3400",
  credentialsPath: "/unused",
  tools: readerTools,
  inScope: async (_grant, _selected, fn) => fn(),
  call: callReader,
});

let rpcId = 0;
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handler(
    new Request("http://127.0.0.1:3400/api/agent/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "x-zenith-workspace": alpha.workspaceId,
        host: "127.0.0.1:3400",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    })
  );
  expect(res.status, `${name} HTTP status`).toBe(200);
  return res.text();
}

beforeAll(() => {
  resetDb(fx.data);
  fx.events.forEach(appendEvent);
  registerReaderProviders();
  registerAllActions();
});

const c: TenantCanaries = alpha.canaries;
const FIELDS: [keyof TenantCanaries, string][] = [
  ["envValue", c.envValue],
  ["outputPassword", c.outputPassword],
  ["stepErrorPassword", c.stepErrorPassword],
  ["stepDetailAwsSecret", c.stepDetailAwsSecret],
  ["findingJwt", c.findingJwt],
  ["logToken", c.logToken],
];

/** Every tool the reader publishes, with arguments that reach alpha's data. */
const CALLS: Record<string, Record<string, unknown>> = {
  zenith_get_context: {},
  zenith_get_capabilities: {},
  zenith_list_projects: {},
  zenith_get_project: { projectId: alpha.projectId },
  zenith_get_manifest: { projectId: alpha.projectId, view: "working" },
  zenith_list_environments: { projectId: alpha.projectId },
  zenith_plan_deploy: { projectId: alpha.projectId, environmentId: alpha.prodEnvId },
  zenith_list_deployments: { projectId: alpha.projectId, environmentId: alpha.prodEnvId },
  zenith_get_deployment: { deploymentId: alpha.deploymentId },
  zenith_get_events: { deploymentId: alpha.deploymentId },
  zenith_get_findings: { projectId: alpha.projectId },
  zenith_get_drift: { projectId: alpha.projectId, environmentId: alpha.prodEnvId },
  zenith_export_project: { projectId: alpha.projectId, environmentId: alpha.prodEnvId },
};

/**
 * tool -> planted fields that survive redaction today. Every entry is free text
 * inside an otherwise ordinary field. `zenith_get_manifest`, the export and the
 * plan preview are NOT here: the value travels under the key `value`.
 */
const KNOWN_LEAKS: Record<string, (keyof TenantCanaries)[]> = {
  zenith_get_deployment: ["stepDetailAwsSecret", "stepErrorPassword"],
  zenith_get_findings: ["findingJwt"],
};

describe("MCP v1 wire responses: planted secrets, removed and not", () => {
  it("covers every tool the reader publishes", () => {
    expect(Object.keys(CALLS).sort()).toEqual(readerTools.map((t) => t.name).sort());
  });

  it("the survivors are exactly the documented ones (ratchet in both directions)", async () => {
    const leaked: Record<string, string[]> = {};
    for (const [name, args] of Object.entries(CALLS)) {
      const body = await tool(name, args);
      for (const [field, secret] of FIELDS) {
        if (deepScanForCanaries(body, [secret]).length > 0) (leaked[name] ??= []).push(field);
      }
    }
    const known = Object.fromEntries(Object.entries(KNOWN_LEAKS).map(([k, v]) => [k, [...v].sort()]));
    const actual = Object.fromEntries(Object.entries(leaked).map(([k, v]) => [k, [...v].sort()]));
    expect(actual, "MCP v1 secret exposure changed: a new entry is a regression; a missing one is a fix — update KNOWN_LEAKS and docs/platform/THREAT-MODEL.md").toEqual(known);
  });

  it("key-name redaction removes the manifest env value and the connection output, in the tools that return them", async () => {
    const manifest = await tool("zenith_get_manifest", CALLS.zenith_get_manifest);
    expect(deepScanForCanaries(manifest, [c.envValue])).toEqual([]);
    const deployment = await tool("zenith_get_deployment", CALLS.zenith_get_deployment);
    expect(deepScanForCanaries(deployment, [c.outputPassword])).toEqual([]);
    const exported = await tool("zenith_export_project", CALLS.zenith_export_project);
    expect(deepScanForCanaries(exported, [c.envValue])).toEqual([]);
  });

  it("free-form logs are excluded from the events tool (the design choice that keeps log secrets out)", async () => {
    const events = await tool("zenith_get_events", CALLS.zenith_get_events);
    expect(deepScanForCanaries(events, [c.logToken])).toEqual([]);
    expect(events).toContain("logsExcluded");
  });
});
