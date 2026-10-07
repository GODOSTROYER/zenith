/**
 * PROD-OPS-03: runner / machine protocol negotiation with an explicit N-1 window.
 * Pure window logic (with synthetic windows, because both kinds are on v1 today) plus
 * the real registration routes: an agent outside the window is refused with 426
 * upgrade_required naming the minimum, BEFORE its single-use token is consumed.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { POST as registerMachine } from "@/app/api/platform/v1/machines/register/route";
import { AGENT_KINDS, AgentApiError, MACHINE_PROTOCOL, RUNNER_PROTOCOL, type ProtocolWindow } from "@/lib/runners/types";
import { BASELINE_PROTOCOL, minimumProtocol, negotiateProtocol, selectRegistrationProtocol, servedProtocols, upgradeRequiredError } from "@/lib/runners/protocol-window";
import { createRegistrationToken } from "@/lib/runners/service";
import { API, ORIGIN, call, createPlane, newAgentKey, teardownPlane, type Plane } from "./_support";

const V1 = "zenith.runner/v1";
const V2 = "zenith.runner/v2";
const V3 = "zenith.runner/v3";
const window2: ProtocolWindow = { current: V2, previous: [V1] };

describe("protocol window logic", () => {
  it("serves exactly N and N-1, newest first, and names the oldest as the minimum", () => {
    expect(servedProtocols(window2)).toEqual([V2, V1]);
    expect(minimumProtocol(window2)).toBe(V1);
    expect(minimumProtocol({ current: V1, previous: [] })).toBe(V1);
  });

  it("negotiates the newest mutually supported protocol and flags N-1 as deprecated", () => {
    expect(negotiateProtocol(window2, [V2, V1])).toEqual({ ok: true, protocol: V2, deprecated: false });
    expect(negotiateProtocol(window2, [V1])).toEqual({ ok: true, protocol: V1, deprecated: true });
    expect(negotiateProtocol(window2, [V3, V2])).toEqual({ ok: true, protocol: V2, deprecated: false });
  });

  it("refuses anything outside the window (N-2 and N+1 only)", () => {
    const window3: ProtocolWindow = { current: V3, previous: [V2] };
    expect(negotiateProtocol(window3, [V1]).ok).toBe(false);
    expect(negotiateProtocol(window2, [V3]).ok).toBe(false);
    expect(negotiateProtocol(window2, []).ok).toBe(false);
  });

  it("treats an agent that offers nothing as the v1 baseline, valid only while v1 is inside the window", () => {
    expect(BASELINE_PROTOCOL).toEqual({ runner: RUNNER_PROTOCOL, machine: MACHINE_PROTOCOL });
    expect(selectRegistrationProtocol("runner", undefined, window2)).toEqual({ protocol: V1, deprecated: true });
    expect(() => selectRegistrationProtocol("runner", undefined, { current: V3, previous: [V2] })).toThrow(AgentApiError);
  });

  it("the 426 carries the minimum, current and supported protocols so an agent can report them", () => {
    const error = upgradeRequiredError("runner", window2);
    expect(error).toMatchObject({ status: 426, code: "upgrade_required", extra: { minimumProtocol: V1, currentProtocol: V2, supportedProtocols: [V2, V1] } });
  });

  it("the kinds' served protocols are derived from their windows (current first)", () => {
    for (const info of Object.values(AGENT_KINDS)) expect(info.protocols).toEqual([info.window.current, ...info.window.previous]);
    expect(Object.values(AGENT_KINDS).every((info) => info.window.previous.length <= 1), "the window is N and at most one N-1").toBe(true);
  });
});

describe("registration routes negotiate and refuse outside the window", () => {
  let plane: Plane;
  beforeEach(async () => { plane = await createPlane("fake"); });
  afterEach(teardownPlane);

  const post = (handler: unknown, body: unknown, path: string) =>
    call(handler, new NextRequest(new URL(path, ORIGIN), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const body = (token: string, over: Record<string, unknown> = {}) => ({ token, publicKey: newAgentKey().publicKey, name: "r", capabilities: [], labels: {}, host: {}, ...over });
  const mint = (kind: "runner" | "machine") => createRegistrationToken(plane.rt, { workspaceId: "w-a", kind, createdBy: "user-admin" });

  it("an agent that sends no protocol list (pre-negotiation) registers on the current protocol", async () => {
    const t = await mint("runner");
    const res = await post(registerRunner, body(t.token), `${API}/runners/register`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ protocol: RUNNER_PROTOCOL, supportedProtocols: [RUNNER_PROTOCOL], protocolDeprecated: false });
  });

  it("an agent offering a newer protocol and the served one registers on the served one", async () => {
    const t = await mint("runner");
    const res = await post(registerRunner, body(t.token, { protocols: ["zenith.runner/v2", RUNNER_PROTOCOL] }), `${API}/runners/register`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ protocol: RUNNER_PROTOCOL });
  });

  it("an agent offering only unserved protocols gets 426 naming the minimum, and its token is NOT consumed", async () => {
    const t = await mint("runner");
    const refused = await post(registerRunner, body(t.token, { protocols: ["zenith.runner/v2"] }), `${API}/runners/register`);
    expect(refused.status).toBe(426);
    expect(refused.body).toMatchObject({ error: { code: "upgrade_required", minimumProtocol: RUNNER_PROTOCOL, supportedProtocols: [RUNNER_PROTOCOL] } });
    const retry = await post(registerRunner, body(t.token, { protocols: [RUNNER_PROTOCOL] }), `${API}/runners/register`);
    expect(retry.status, "the same token still works once the agent speaks a served protocol").toBe(201);
  });

  it("a machine agent is negotiated against its own window, not the runner's", async () => {
    const t = await mint("machine");
    const wrongKind = await post(registerMachine, body(t.token, { protocols: [RUNNER_PROTOCOL] }), `${API}/machines/register`);
    expect(wrongKind.status).toBe(426);
    const ok = await post(registerMachine, body(t.token, { protocols: [MACHINE_PROTOCOL] }), `${API}/machines/register`);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ protocol: MACHINE_PROTOCOL });
  });

  it("rejects a malformed protocol list as an invalid request", async () => {
    const t = await mint("runner");
    for (const protocols of [[], ["not-a-protocol"], ["zenith.runner/v1; drop"]]) {
      const res = await post(registerRunner, body(t.token, { protocols }), `${API}/runners/register`);
      expect(res.status).toBe(400);
    }
  });
});
