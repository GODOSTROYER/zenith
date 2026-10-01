/** Real observability adapter and fabric, a fake credential broker/source.
 * Session acquisition and every source query occur inside the same callback. */
import { afterEach, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import type { AwsSession, CredentialBroker, CredentialRequest } from "@/lib/credentials/types";
import { CredentialDeniedError } from "@/lib/credentials/types";
import { argsFor, ids, makeHarness } from "./support";
import { runTool } from "@/lib/agent-access/v3/tools";

tempDataDir("zenith-mcp-v3-adapters-", { fast: true });
const { observabilityPort, registerCredentialBroker, registerInvestigator, defaultPorts, unavailableInvestigator } = await import("@/lib/agent-access/v3/adapters");
afterEach(() => { registerCredentialBroker(undefined); registerInvestigator(undefined); });

it.each(["zenith_query_logs", "zenith_query_metrics"] as const)("%s runs cloud reads inside the production session adapter", async (name) => {
  const h = await makeHarness(); let inside = false;
  const requests: CredentialRequest[] = [];
  const session: AwsSession = { provider: "aws", accountId: "123456789012", region: "us-east-1", transport: "direct", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    client: () => { throw new Error("Fixture does not create cloud clients"); }, childProcessEnv: () => { throw new Error("Raw credentials forbidden"); } };
  const broker: CredentialBroker = { async withSession(request, fn) { requests.push(request); inside = true; try { return await fn(session); } finally { inside = false; } }, verifyConnection: async () => ({ ok: false, detail: "Fake broker" }) };
  const sourceQuery = vi.fn(async () => { expect(inside).toBe(true); return { items: [], sources: ["fixture-source"], unavailable: [], truncated: false, simulated: false }; });
  registerCredentialBroker(broker);
  h.ports.observability = observabilityPort({ sources: ({ sessions }) => {
    expect(inside).toBe(true); expect(sessions.aws).toBe(session);
    return [{ id: "fixture-source", provider: "aws", supports: ["log", "metric"], searchLogs: sourceQuery, queryMetrics: sourceQuery }];
  } });
  const result = await h.invoke(name, argsFor(name));
  expect(result.ok).toBe(true); expect(sourceQuery).toHaveBeenCalledTimes(1); expect(inside).toBe(false);
  const read = await h.authorizeRead.mock.results[0].value;
  expect(requests).toEqual([{ connectionId: "conn-a", grant: read.claims, purpose: "observe" }]);
  expect(requests[0].grant).toMatchObject({ ws: ids.ws, env: ids.env, cap: name === "zenith_query_logs" ? "logs.read" : "metrics.read" });
});
it("cloud reads without a registered credential broker are explicitly unavailable", async () => {
  const h = await makeHarness(); h.ports.observability = observabilityPort({ credentialBroker: () => undefined });
  const result = await h.invoke("zenith_query_logs", argsFor("zenith_query_logs"));
  expect(result.ok).toBe(true); expect(result.unavailable.length).toBeGreaterThan(0); expect(result.simulated).toBe(false);
  expect(result.data.count).toBe(0); expect(JSON.stringify(result.unavailable)).toContain("session");
});
it("a session refusal becomes an unavailable source without a cloud query", async () => {
  const h = await makeHarness(); const sources = vi.fn();
  const broker: CredentialBroker = { withSession: async () => { throw new CredentialDeniedError("Fixture refusal", { reason: "grant_invalid" }); }, verifyConnection: async () => ({ ok: false, detail: "Fixture" }) };
  h.ports.observability = observabilityPort({ credentialBroker: () => broker, sources });
  const result = await h.invoke("zenith_query_metrics", argsFor("zenith_query_metrics"));
  expect(result.ok).toBe(true); expect(result.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ source: "credential-broker" })]));
  expect(sources).not.toHaveBeenCalled();
});
it("the default incident wiring stays unavailable until registered", async () => {
  const ports = defaultPorts(); expect(ports.investigator).toBe(unavailableInvestigator);
  const investigator = { available: true, investigate: vi.fn() }; registerInvestigator(investigator);
  expect(ports.investigator).toBe(investigator);
});
it("operation reads honor a narrower connection grant than the broker directory", async () => {
  const h = await makeHarness(); const proposed = await h.invoke("zenith_prepare_deploy", argsFor("zenith_prepare_deploy"));
  const principal = { ...h.principal, environmentIds: ["narrower-env"] };
  for (const name of ["zenith_get_operation", "zenith_get_operation_events", "zenith_execute_approved_operation"] as const) {
    const result = await runTool(name, argsFor(name, proposed.data.operationId as string, proposed.data.proposalDigest as string), { principal, ports: h.ports });
    expect(result.error?.code).toBe("not_found");
  }
  expect(h.beginExecution).not.toHaveBeenCalled();
});
