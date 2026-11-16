/**
 * Registration (docs/platform/RUNNER-PROTOCOL.md section 2), through the real route handlers.
 * The admin half (creating a token) is in admin-routes.test.ts; here the token is made with the same
 * service function the admin route calls.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as registerMachine } from "@/app/api/platform/v1/machines/register/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { createRegistrationToken, generateRegistrationToken } from "@/lib/runners/service";
import { API, ORIGIN, call, createPlane, newAgentKey, teardownPlane, type Plane } from "./_support";

let plane: Plane;
beforeEach(async () => {
  plane = await createPlane("fake");
});
afterEach(teardownPlane);

const post = (handler: unknown, body: unknown, path = `${API}/runners/register`) =>
  call(handler, new NextRequest(new URL(path, ORIGIN), { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));

const goodBody = (token: string, over: Record<string, unknown> = {}) => ({
  token,
  publicKey: newAgentKey().publicKey,
  name: "prod-vpc-runner",
  version: "1.0.0",
  capabilities: ["tofu.run", "aws.http", "probe.http"],
  labels: { region: "ap-south-1" },
  host: { os: "linux", arch: "amd64" },
  ...over,
});

const mint = (kind: "runner" | "machine" = "runner", workspaceId = "w-a", ttlSec?: number, binding?: { environmentId?: string; address?: string }) =>
  createRegistrationToken(plane.rt, { workspaceId, kind, createdBy: "user-admin", ttlSec, binding });

describe("registration tokens", () => {
  it("have the zrt_/zmt_ shape, are shown once, and only their SHA-256 reaches the store", async () => {
    const t = await mint("runner");
    const m = await mint("machine");
    expect(t.token).toMatch(/^zrt_[A-Za-z0-9_-]{32}$/);
    expect(m.token).toMatch(/^zmt_[A-Za-z0-9_-]{32}$/);
    const { token, tokenHash } = generateRegistrationToken("runner");
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    // the store was handed the hash, never the raw token: registering with the raw token as the "hash" fails
    await expect(plane.store.tokens.create({ workspaceId: "w-a", kind: "runner", createdBy: "u", tokenHash: t.token })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("expire within an hour at most, and the expiry is reported", async () => {
    const t = await mint("runner", "w-a", 99_999);
    expect(Date.parse(t.expiresAt) - plane.rt.now()).toBe(60 * 60 * 1000);
    const short = await mint("runner", "w-a", 30);
    expect(Date.parse(short.expiresAt) - plane.rt.now()).toBe(30_000);
  });
});

describe("POST /runners/register", () => {
  it("registers an agent and answers with its id, workspace, the pinned control-plane keys and the protocol", async () => {
    const t = await mint("runner", "w-acme");
    const res = await post(registerRunner, goodBody(t.token));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({ workspaceId: "w-acme", protocol: "zenith.runner/v1", pollIntervalSec: 5 });
    expect(String(res.body.id)).toMatch(/^run_[0-9a-f-]{36}$/);
    const keys = res.body.controlPlaneKeys as { kid: string; publicKey: string }[];
    expect(keys).toEqual(plane.cpKeys);
    expect(keys[0].publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await plane.store.runners.get("w-acme", String(res.body.id));
    expect(stored).toMatchObject({ name: "prod-vpc-runner", status: "active", version: "1.0.0", capabilities: ["tofu.run", "aws.http", "probe.http"], labels: { region: "ap-south-1" }, host: { os: "linux", arch: "amd64" } });
    expect(plane.events.map((e) => e.type)).toEqual(["runner.registered"]);
    expect(JSON.stringify(plane.events)).not.toContain(t.token);
  });

  it("takes the workspace from the token, never from the body", async () => {
    const t = await mint("runner", "w-real");
    const res = await post(registerRunner, goodBody(t.token, { workspaceId: "w-victim" }));
    expect(res.status).toBe(201);
    expect(res.body.workspaceId).toBe("w-real");
    expect(await plane.store.runners.get("w-victim", String(res.body.id))).toBeNull();
  });

  it("consumes the token: a second registration with it is 401 invalid_registration_token", async () => {
    const t = await mint("runner");
    expect((await post(registerRunner, goodBody(t.token))).status).toBe(201);
    const again = await post(registerRunner, goodBody(t.token));
    expect(again.status).toBe(401);
    expect(again.body.error?.code).toBe("invalid_registration_token");
  });

  it("only one of two racing registrations with the same token wins", async () => {
    const t = await mint("runner");
    const results = await Promise.all(Array.from({ length: 6 }, () => post(registerRunner, goodBody(t.token))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    expect(await plane.store.runners.list("w-a")).toHaveLength(1);
  });

  it("refuses an expired token, an unknown token, and a token of the wrong kind with the same answer", async () => {
    const short = await mint("runner", "w-a", 1);
    plane.clock.t += 2000;
    const machineToken = await mint("machine");
    const answers = [
      await post(registerRunner, goodBody(short.token)),
      await post(registerRunner, goodBody("zrt_" + "A".repeat(32))),
      await post(registerRunner, goodBody(machineToken.token)),
    ];
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.body.error).toEqual({ code: "invalid_registration_token", message: answers[0].body.error?.message });
    }
    // and the machine token still works on its own endpoint
    expect((await post(registerMachine, goodBody(machineToken.token, { capabilities: ["machine.inspect"] }), `${API}/machines/register`)).status).toBe(201);
  });

  it("rejects a public key that is not a base64url raw 32-byte Ed25519 key", async () => {
    const t = await mint("runner");
    for (const publicKey of ["", "tooshort", `${"A".repeat(43)}=`, "A".repeat(44), "+".repeat(43), newAgentKey().publicKey.slice(0, 42)]) {
      const res = await post(registerRunner, goodBody(t.token, { publicKey }));
      expect(res.status, publicKey).toBe(400);
      expect(res.body.error?.code).toBe("invalid_request");
    }
    // none of those burned the token
    expect((await post(registerRunner, goodBody(t.token))).status).toBe(201);
  });

  it("bounds name, version, capabilities, labels and host", async () => {
    const t = await mint("runner");
    const bad: Record<string, unknown>[] = [
      { name: "" },
      { name: "x".repeat(129) },
      { name: "line\nbreak" },
      { version: "1".repeat(65) },
      { capabilities: Array.from({ length: 33 }, (_, i) => `k${i}`) },
      { capabilities: ["has space"] },
      { capabilities: [42] },
      { labels: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`l${i}`, "v"])) },
      { labels: { k: "v".repeat(254) } },
      { labels: { ["k".repeat(64)]: "v" } },
      { host: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7", h: "8", i: "9" } },
      { host: { os: "x".repeat(65) } },
    ];
    for (const over of bad) {
      const res = await post(registerRunner, goodBody(t.token, over));
      expect(res.status, JSON.stringify(over).slice(0, 60)).toBe(400);
    }
    expect((await post(registerRunner, goodBody(t.token, { name: "x".repeat(128) }))).status).toBe(201);
  });

  it("rejects non-JSON, non-object and oversize bodies", async () => {
    expect((await post(registerRunner, "{not json")).status).toBe(400);
    expect((await post(registerRunner, "[]")).status).toBe(400);
    expect((await post(registerRunner, "null")).status).toBe(400);
    const huge = await post(registerRunner, JSON.stringify({ token: "zrt_x", pad: "x".repeat(70 * 1024) }));
    expect(huge.status).toBe(413);
    expect(huge.body.error?.code).toBe("payload_too_large");
  });

  it("does not echo the token in any error", async () => {
    const res = await post(registerRunner, goodBody("zrt_" + "S3cretTokenValue".repeat(3), { publicKey: "bad" }));
    expect(JSON.stringify(res.body)).not.toContain("S3cretTokenValue");
  });
});

describe("POST /machines/register", () => {
  it("registers a zenithd machine and carries the token's environment/address binding onto it", async () => {
    const t = await mint("machine", "w-acme", undefined, { environmentId: "env_1", address: "compute_instance/worker-1" });
    const res = await post(registerMachine, goodBody(t.token, { capabilities: ["machine.inspect", "service.status"] }), `${API}/machines/register`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ workspaceId: "w-acme", protocol: "zenith.machine/v1" });
    expect(String(res.body.id)).toMatch(/^mac_/);
    const m = await plane.store.machines.get("w-acme", String(res.body.id));
    expect(m).toMatchObject({ kind: "machine", environmentId: "env_1", address: "compute_instance/worker-1", capabilities: ["machine.inspect", "service.status"] });
    expect(plane.events.map((e) => e.type)).toEqual(["machine.registered"]);
  });

  it("a runner token cannot register a machine", async () => {
    const t = await mint("runner");
    const res = await post(registerMachine, goodBody(t.token), `${API}/machines/register`);
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("invalid_registration_token");
  });

  it("does not attach a binding to a runner token (bindings are for machines only)", async () => {
    const t = await mint("runner", "w-a", undefined, { environmentId: "env_1" });
    const res = await post(registerRunner, goodBody(t.token));
    expect(res.status).toBe(201);
    expect((await plane.store.runners.get("w-a", String(res.body.id)))?.environmentId).toBeUndefined();
  });
});
