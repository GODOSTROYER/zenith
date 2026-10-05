/**
 * PROD-MACH-05 control-plane half: runner credential modes, dispatch refusal for revoked or
 * mismatched bindings (never a fallback to other credentials), and inbound custody checks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import type { ProviderConnection } from "@/lib/credentials/types";
import {
  CREDENTIAL_MODE_LABEL,
  checkRunnerBinding,
  hasUnknownCredentialMode,
  requiredRunnerCustody,
  runnerCredentialMode,
  sanitizeInboundResult,
} from "@/lib/runners/custody";
import { DispatchError, awaitRunnerJob, enqueueRunnerJob, type EnqueueRunnerJobInput } from "@/lib/runners/dispatch";
import type { AgentRecord } from "@/lib/runners/ports";
import { OPERATION, createPlane, registerFakeAgent, runnerGrant, teardownPlane, type FakeAgent, type Plane } from "./_support";

const keyId = (): string => "AK" + "IA" + "Q".repeat(16);

type Lookup = (workspaceId: string, connectionId: string) => Promise<ProviderConnection | null>;
let plane: Plane;
let current: Lookup;

interface ConnectionOverrides {
  workspaceId?: string;
  status?: ProviderConnection["status"];
  revokedAt?: string;
  config?: Record<string, unknown>;
}

const connection = (over: ConnectionOverrides = {}, runnerId = "run_x"): ProviderConnection => ({
  id: "pc_1",
  workspaceId: over.workspaceId ?? "w-a",
  status: over.status ?? "verified",
  createdBy: "user_test",
  createdAt: "2026-10-05T00:00:00Z",
  ...(over.revokedAt !== undefined ? { revokedAt: over.revokedAt } : {}),
  config: { provider: "oci", mode: "runner", tenancyOcid: "ocid1.tenancy.oc1..x", compartmentOcid: "ocid1.compartment.oc1..x", region: "us-ashburn-1", runnerId, ...(over.config ?? {}) } as unknown as ProviderConnection["config"],
});

beforeEach(async () => {
  plane = await createPlane("fake", { connections: (ws, id) => current(ws, id) });
});
afterEach(teardownPlane);

async function register(labels?: Record<string, string>): Promise<FakeAgent> {
  return registerFakeAgent(plane, registerRunner, { labels });
}

async function job(agent: FakeAgent, over: Partial<EnqueueRunnerJobInput> = {}): Promise<EnqueueRunnerJobInput> {
  return {
    workspaceId: "w-a",
    runnerId: agent.id,
    operationId: OPERATION,
    capability: "infrastructure.observe",
    kind: "probe.tcp",
    payload: { host: "10.0.0.1", port: 22, timeoutMs: 2000 },
    grant: await runnerGrant(plane, { runnerId: agent.id, workspaceId: "w-a", operationId: OPERATION, capability: "infrastructure.observe" }),
    ...over,
  };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return e instanceof DispatchError ? e.code : `unexpected ${String(e)}`;
  }
}

describe("credential mode declaration", () => {
  const rec = (labels: Record<string, string>): Pick<AgentRecord, "labels"> => ({ labels });

  it("an absent label is a pre-mode runner and is local_only; an unknown value is never treated as federated", () => {
    expect(runnerCredentialMode(rec({}))).toBe("local_only");
    expect(runnerCredentialMode(rec({ [CREDENTIAL_MODE_LABEL]: "federated" }))).toBe("federated");
    expect(runnerCredentialMode(rec({ [CREDENTIAL_MODE_LABEL]: "hybrid" }))).toBe("local_only");
    expect(hasUnknownCredentialMode(rec({ [CREDENTIAL_MODE_LABEL]: "hybrid" }))).toBe(true);
    expect(hasUnknownCredentialMode(rec({}))).toBe(false);
  });

  it("a connection requires local_only unless it explicitly asks for federated", () => {
    expect(requiredRunnerCustody(connection())).toBe("local_only");
    expect(requiredRunnerCustody(connection({ config: { runnerCustody: "federated" } }))).toBe("federated");
    expect(requiredRunnerCustody(connection({ config: { runnerCustody: "anything" } }))).toBe("local_only");
  });

  it("the registered runner record carries the declared label", async () => {
    const fed = await register({ [CREDENTIAL_MODE_LABEL]: "federated" });
    const stored = await plane.store.runners.get("w-a", fed.id);
    expect(runnerCredentialMode(stored!)).toBe("federated");
  });
});

describe("dispatch against a binding", () => {
  it("dispatches to a local_only runner for a verified runner-mode connection", async () => {
    const r = await register({ [CREDENTIAL_MODE_LABEL]: "local_only" });
    current = async () => connection({}, r.id);
    expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1" })))).toBe("accepted");
  });

  it("refuses a revoked binding before anything is signed or queued, and never falls back", async () => {
    const r = await register();
    current = async () => connection({ status: "revoked", revokedAt: "2026-10-05T01:00:00Z" }, r.id);
    expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1" })))).toBe("binding_revoked");
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toEqual([]);
    expect(plane.events.filter((e) => e.type === "runner.job.dispatched")).toEqual([]);
  });

  it("re-reads the binding on every enqueue: a revocation between two jobs stops the second", async () => {
    const r = await register();
    let status: ProviderConnection["status"] = "verified";
    current = async () => connection({ status }, r.id);
    expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1" })))).toBe("accepted");
    status = "revoked";
    expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1", operationId: "op_2", grant: await runnerGrant(plane, { runnerId: r.id, workspaceId: "w-a", operationId: "op_2", capability: "infrastructure.observe" }) })))).toBe("binding_revoked");
  });

  it("refuses when the binding cannot be proved: missing, other workspace, unverified, lookup failure", async () => {
    const r = await register();
    const cases: [Lookup, string][] = [
      [async () => null, "binding_unavailable"],
      [async () => connection({ workspaceId: "w-b" }, r.id), "binding_unavailable"],
      [async () => connection({ status: "pending_verification" }, r.id), "binding_unavailable"],
      [async () => connection({ status: "failed" }, r.id), "binding_unavailable"],
      [async () => { throw new Error("db down"); }, "binding_unavailable"],
    ];
    for (const [lookup, code] of cases) {
      current = lookup;
      expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1" })))).toBe(code);
    }
  });

  it("refuses a connection that is not in runner mode or is bound to a different runner", async () => {
    const r = await register();
    current = async () => connection({ config: { mode: "oidc_web_identity" } }, r.id);
    expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1" })))).toBe("binding_unavailable");
    current = async () => connection({}, "run_someone_else");
    expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1" })))).toBe("binding_unavailable");
  });

  it("refuses a custody mismatch in both directions", async () => {
    const local = await register();
    const fed = await register({ [CREDENTIAL_MODE_LABEL]: "federated" });
    current = async () => connection({ config: { runnerCustody: "federated" } }, local.id);
    expect(await refusal(enqueueRunnerJob(await job(local, { bindingConnectionId: "pc_1" })))).toBe("custody_mismatch");
    current = async () => connection({}, fed.id);
    expect(await refusal(enqueueRunnerJob(await job(fed, { bindingConnectionId: "pc_1" })))).toBe("custody_mismatch");
    current = async () => connection({ config: { runnerCustody: "federated" } }, fed.id);
    expect(await refusal(enqueueRunnerJob(await job(fed, { bindingConnectionId: "pc_1" })))).toBe("accepted");
  });

  it("a revoked runner is refused before the binding is even read", async () => {
    const r = await register();
    await plane.store.runners.revoke("w-a", r.id);
    let read = false;
    current = async () => { read = true; return connection({}, r.id); };
    expect(await refusal(enqueueRunnerJob(await job(r, { bindingConnectionId: "pc_1" })))).toBe("agent_revoked");
    expect(read).toBe(false);
  });

  it("pure check agrees with the dispatch path", () => {
    const agent = { kind: "runner", id: "run_x", workspaceId: "w-a", labels: {} } as unknown as AgentRecord;
    expect(() => checkRunnerBinding(connection({}, "run_x"), agent, "w-a")).not.toThrow();
    expect(() => checkRunnerBinding(connection({ status: "revoked" }, "run_x"), agent, "w-a")).toThrow(/revoked/);
  });
});

describe("job payloads never carry credentials", () => {
  it("refuses a payload with a credential shape before signing", async () => {
    const r = await register();
    const bad = await job(r, { payload: { host: `${keyId()}.example.test`, port: 22, timeoutMs: 2000 } });
    const code = await refusal(enqueueRunnerJob(bad));
    expect(["invalid_payload"]).toContain(code);
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toEqual([]);
  });
});

describe("inbound results from a local_only runner", () => {
  const report = (r: FakeAgent, id: string, body: unknown) => r.post(resultRunner, `/jobs/${id}/result`, body, {}, { jti: id });
  const poll = (r: FakeAgent) => r.post(pollRunner, "/poll", { max: 5, waitSec: 0 });

  it("sanitizes credential shapes before sealing and records only the kinds", async () => {
    const r = await register({ [CREDENTIAL_MODE_LABEL]: "local_only" });
    const id = await enqueueRunnerJob(await job(r));
    await poll(r);
    expect((await report(r, id, { status: "succeeded", result: { reachable: true, banner: `key ${keyId()}` } })).status).toBe(200);
    const awaited = await awaitRunnerJob<{ reachable: boolean; banner: string }>(id, { workspaceId: "w-a" });
    expect(awaited.status).toBe("succeeded");
    expect(JSON.stringify(awaited.result)).not.toContain(keyId());
    expect(awaited.result?.banner).toContain("[REDACTED:aws-access-key-id]");
    const done = plane.events.find((e) => e.type === "runner.job.completed");
    expect(done?.data).toMatchObject({ custody: { credentialMaterialSanitized: true, kinds: ["aws-access-key-id"] } });
    expect(JSON.stringify(done)).not.toContain(keyId());
  });

  it("leaves a clean result byte-identical and adds no custody marker", async () => {
    const r = await register();
    const id = await enqueueRunnerJob(await job(r));
    await poll(r);
    await report(r, id, { status: "succeeded", result: { reachable: true } });
    expect(await awaitRunnerJob(id, { workspaceId: "w-a" })).toMatchObject({ status: "succeeded", result: { reachable: true } });
    expect(plane.events.find((e) => e.type === "runner.job.completed")?.data).not.toHaveProperty("custody");
  });

  it("does not rewrite a federated runner's result (the model-visible layer sanitizes it)", () => {
    expect(sanitizeInboundResult({ labels: { [CREDENTIAL_MODE_LABEL]: "federated" } }, { b: keyId() })).toEqual({ value: { b: keyId() }, kinds: [] });
    expect(sanitizeInboundResult({ labels: {} }, { b: keyId() }).kinds).toEqual(["aws-access-key-id"]);
  });
});
