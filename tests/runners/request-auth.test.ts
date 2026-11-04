/**
 * Verification of agent-signed requests (docs/platform/RUNNER-PROTOCOL.md section 3).
 *
 * The Go agents are the clients, so the ground truth is Go's golden vector
 * (`fixtures/go-signing-vector.json`, copied from go/internal/protocol/testdata at ws-go d133a96):
 * a fixed seed, path, body, timestamp and nonce with the exact signature the Go client produces.
 * Every tamper case below starts from a request that verifies and changes exactly one thing.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateAgentRequest, assertPathAgent, readBodyBytes, signingString } from "@/lib/runners/request-auth";
import { AgentApiError } from "@/lib/runners/types";
import { API, FakeAgent, createPlane, keyFromSeedHex, newAgentKey, teardownPlane, ORIGIN, type Plane } from "./_support";

const vector = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/go-signing-vector.json"), "utf8")) as {
  agentSeedHex: string;
  agentPublicKey: string;
  protocol: string;
  agentId: string;
  method: string;
  pathAndQuery: string;
  body: string;
  timestamp: number;
  nonce: string;
  contentSha256: string;
  signingString: string;
  signature: string;
  headers: Record<string, string>;
};

let plane: Plane;
let agent: FakeAgent;
const PATH = `${API}/runners/run_golden/poll?after=42`;

/** Register an agent with a chosen id/key/protocol straight through the store (the route cannot pick an id). */
async function registerGolden(p: Plane, id = vector.agentId, publicKey = vector.agentPublicKey, protocol = vector.protocol): Promise<void> {
  const tokenHash = randomBytes(32).toString("hex");
  await p.store.tokens.create({ workspaceId: "w-a", kind: "runner", createdBy: "u", tokenHash });
  await p.store.runners.register({ tokenHash, id, name: id, publicKey, protocol, capabilities: ["aws.http"], labels: {}, host: {} });
}

beforeEach(async () => {
  plane = await createPlane("fake");
  plane.clock.t = vector.timestamp * 1000;
  await registerGolden(plane);
  agent = new FakeAgent(plane, "runner", vector.agentId, "w-a", keyFromSeedHex(vector.agentSeedHex), plane.cpKeys);
});
afterEach(teardownPlane);

const deps = () => ({ store: plane.store, now: plane.rt.now });
const code = async (req: NextRequest): Promise<string> => {
  try {
    await authenticateAgentRequest(req, "runner", deps());
    return "ok";
  } catch (e) {
    if (e instanceof AgentApiError) return `${e.status} ${e.code}`;
    throw e;
  }
};
const golden = (over: Parameters<FakeAgent["request"]>[3] = {}, body: string | undefined = vector.body, method = "POST", pathAndQuery = PATH) =>
  agent.request(method, pathAndQuery, body, { timestamp: vector.timestamp, nonce: vector.nonce, ...over });

describe("Go golden vector", () => {
  it("the independent test signer reproduces the Go client's signature byte for byte", () => {
    const req = golden();
    expect(req.headers.get("x-zenith-signature")).toBe(vector.signature);
    expect(req.headers.get("x-zenith-content-sha256")).toBe(vector.contentSha256);
    expect(signingString(vector.protocol, vector.method, vector.pathAndQuery, vector.timestamp, vector.nonce, vector.contentSha256)).toBe(vector.signingString);
  });

  it("the server verifies the exact headers the Go client sent", async () => {
    const req = new NextRequest(new URL(vector.pathAndQuery, ORIGIN), { method: "POST", headers: vector.headers, body: vector.body });
    const v = await authenticateAgentRequest(req, "runner", deps());
    expect(v.agent.id).toBe("run_golden");
    expect(v.agent.workspaceId).toBe("w-a");
    expect(Buffer.from(v.body).toString("utf8")).toBe(vector.body);
    expect(v.pathAndQuery).toBe(vector.pathAndQuery);
  });
});

describe("tamper cases (one change each)", () => {
  it("accepts the untampered request", async () => {
    expect(await code(golden())).toBe("ok");
  });

  it("rejects a changed METHOD", async () => {
    expect(await code(golden({ method: "POST" }, vector.body, "PUT"))).toBe("401 invalid_signature");
  });

  it("rejects a changed PATH (and a changed query)", async () => {
    expect(await code(golden({ signPath: PATH }, vector.body, "POST", `${API}/runners/run_golden/heartbeat?after=42`))).toBe("401 invalid_signature");
    expect(await code(golden({ signPath: PATH }, vector.body, "POST", `${API}/runners/run_golden/poll?after=43`))).toBe("401 invalid_signature");
    expect(await code(golden({ signPath: `${API}/runners/run_golden/poll` }, vector.body, "POST", PATH))).toBe("401 invalid_signature");
  });

  it("rejects a changed BODY: the digest header no longer matches, or the signature no longer covers it", async () => {
    // body swapped, digest header kept -> digest mismatch
    const stale = golden();
    const swapped = new NextRequest(stale.url, { method: "POST", headers: stale.headers, body: '{"max":5,"waitSec":20}' });
    expect(await code(swapped)).toBe("401 body_digest_mismatch");
    // body AND digest replaced by the attacker, signature kept -> bad signature
    const other = agent.request("POST", PATH, '{"max":5,"waitSec":20}', { timestamp: vector.timestamp, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    const forged = new NextRequest(other.url, { method: "POST", headers: { ...Object.fromEntries(other.headers), "x-zenith-signature": vector.signature, "x-zenith-nonce": vector.nonce }, body: '{"max":5,"waitSec":20}' });
    expect(await code(forged)).toBe("401 invalid_signature");
  });

  it("hashes the raw bytes that arrived: a differently serialized body of the same JSON does not verify", async () => {
    const compact = golden(); // signed over {"max":1,"waitSec":20}
    const spaced = new NextRequest(compact.url, { method: "POST", headers: compact.headers, body: '{ "max": 1, "waitSec": 20 }' });
    expect(await code(spaced)).toBe("401 body_digest_mismatch");
    // and a request signed over odd whitespace and unicode verifies as sent
    const odd = '{ "waitSec" :0,\n"note":"café ✓" }';
    expect(await code(agent.request("POST", PATH, odd, { nonce: "BBBBBBBBBBBBBBBBBBBBBB" }))).toBe("ok");
  });

  it("enforces the 60 s clock-skew window in both directions", async () => {
    const now = Math.floor(plane.rt.now() / 1000);
    expect(await code(agent.request("POST", PATH, "{}", { timestamp: now - 60 }))).toBe("ok");
    expect(await code(agent.request("POST", PATH, "{}", { timestamp: now + 60 }))).toBe("ok");
    expect(await code(agent.request("POST", PATH, "{}", { timestamp: now - 61 }))).toBe("401 clock_skew");
    expect(await code(agent.request("POST", PATH, "{}", { timestamp: now + 61 }))).toBe("401 clock_skew");
  });

  it("rejects a replayed nonce, per agent, within the 10 minute window", async () => {
    expect(await code(golden())).toBe("ok");
    expect(await code(golden())).toBe("401 nonce_replayed");
    // the same nonce under another agent is a different key
    const key = newAgentKey();
    await registerGolden(plane, "run_other", key.publicKey);
    const other = new FakeAgent(plane, "runner", "run_other", "w-a", key, plane.cpKeys);
    expect(await code(other.request("POST", `${API}/runners/run_other/poll`, "{}", { nonce: vector.nonce }))).toBe("ok");
  });

  it("forgets a nonce after the window (the timestamp check is what keeps an old one harmless)", async () => {
    expect(await code(golden())).toBe("ok");
    plane.clock.t += 10 * 60 * 1000 + 1000;
    const now = Math.floor(plane.rt.now() / 1000);
    expect(await code(agent.request("POST", PATH, vector.body, { timestamp: now, nonce: vector.nonce }))).toBe("ok");
    // but the ORIGINAL request, carrying its original timestamp, is now far outside the skew window
    expect(await code(golden())).toBe("401 clock_skew");
  });

  it("does not let an unauthenticated caller burn a nonce: a bad signature does not consume it", async () => {
    const impostor = newAgentKey();
    expect(await code(golden({ privateKey: impostor.privateKey }))).toBe("401 invalid_signature");
    expect(await code(golden())).toBe("ok"); // the real agent's request with the same nonce still works
  });

  it("rejects a signature by the wrong key", async () => {
    expect(await code(golden({ privateKey: newAgentKey().privateKey }))).toBe("401 invalid_signature");
  });

  it("rejects a signature over another protocol id", async () => {
    expect(await code(golden({ protocol: "zenith.machine/v1" }))).toBe("401 invalid_signature");
  });

  it("answers 401 agent_revoked for a revoked agent, exactly as for an unknown one (no oracle)", async () => {
    await plane.store.runners.revoke("w-a", "run_golden");
    const revoked = await code(golden());
    const unknown = await code(agent.request("POST", `${API}/runners/run_nobody/poll`, "{}", { agentHeader: "run_nobody" }));
    expect(revoked).toBe("401 agent_revoked");
    expect(unknown).toBe("401 agent_revoked");
  });

  it("answers 426 upgrade_required for a protocol this control plane does not serve", async () => {
    expect(await code(golden({ extraHeaders: { "x-zenith-protocol": "zenith.runner/v9" } }))).toBe("426 upgrade_required");
    const oldKey = newAgentKey();
    await registerGolden(plane, "run_old", oldKey.publicKey, "zenith.runner/v0");
    const old = new FakeAgent(plane, "runner", "run_old", "w-a", oldKey, plane.cpKeys);
    expect(await code(old.request("POST", `${API}/runners/run_old/poll`, "{}"))).toBe("426 upgrade_required");
    // a machine's request to the runner collection is not a runner
    const machine = await (async () => {
      await plane.store.tokens.create({ workspaceId: "w-a", kind: "machine", createdBy: "u", tokenHash: "b".repeat(64) });
      const k = newAgentKey();
      await plane.store.machines.register({ tokenHash: "b".repeat(64), id: "mac_1", name: "m", publicKey: k.publicKey, protocol: "zenith.machine/v1", capabilities: [], labels: {}, host: {} });
      return new FakeAgent(plane, "machine", "mac_1", "w-a", k, plane.cpKeys);
    })();
    expect(await code(machine.request("POST", `${API}/runners/mac_1/poll`, "{}", { agentHeader: "mac_1" }))).toBe("401 agent_revoked");
  });

  it("rejects missing or malformed signature headers before touching the store", async () => {
    const good = golden();
    for (const name of ["x-zenith-agent", "x-zenith-timestamp", "x-zenith-nonce", "x-zenith-content-sha256", "x-zenith-signature"]) {
      const h = new Headers(good.headers);
      h.delete(name);
      expect(await code(new NextRequest(good.url, { method: "POST", headers: h, body: vector.body }))).toBe("401 missing_signature_headers");
    }
    const malformed: [string, string][] = [
      ["x-zenith-timestamp", "17900000.5"],
      ["x-zenith-timestamp", "-1"],
      ["x-zenith-nonce", "short"],
      ["x-zenith-content-sha256", vector.contentSha256.toUpperCase()],
      ["x-zenith-content-sha256", "abc"],
      ["x-zenith-signature", "not-a-signature"],
      ["x-zenith-agent", "run golden"],
    ];
    for (const [name, value] of malformed) {
      const h = new Headers(good.headers);
      h.set(name, value);
      expect(await code(new NextRequest(good.url, { method: "POST", headers: h, body: vector.body })), `${name}=${value}`).toBe("401 missing_signature_headers");
    }
  });

  it("caps the body: a declared and a streamed oversize body are both 413, without hashing", async () => {
    const big = "x".repeat(70 * 1024);
    const signed = agent.request("POST", PATH, big);
    expect(await code(signed)).toBe("413 payload_too_large");
    await expect(readBodyBytes(new Request(`${ORIGIN}/x`, { method: "POST", body: big }), 1000)).rejects.toMatchObject({ status: 413 });
    await expect(readBodyBytes(new Request(`${ORIGIN}/x`, { method: "POST", body: "ok" }), 1000)).resolves.toHaveLength(2);
    await expect(readBodyBytes(new Request(`${ORIGIN}/x`, { method: "POST" }), 1000)).resolves.toHaveLength(0);
  });

  it("a valid signature by one agent is no authority over another agent's URL", async () => {
    const v = await authenticateAgentRequest(golden(), "runner", deps());
    expect(() => assertPathAgent(v.agent, "run_golden")).not.toThrow();
    expect(() => assertPathAgent(v.agent, "run_other")).toThrowError(expect.objectContaining({ status: 403, code: "agent_mismatch" }));
  });
});
