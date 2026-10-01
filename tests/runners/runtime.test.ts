/**
 * Wiring and fail-closed defaults: with nothing injected the runner plane uses the credential module's
 * control-plane key and the platform store from the environment; with a piece missing it answers 503
 * `runner_plane_unconfigured` instead of guessing.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-runners-runtime-");

const { POST: registerRunner } = await import("@/app/api/platform/v1/runners/register/route");
const { POST: pollRunner } = await import("@/app/api/platform/v1/runners/[id]/poll/route");
const { generateSigningJwk, resetSignerCache } = await import("@/lib/credentials/signing");
const { resetPlatformDbForTests } = await import("@/lib/controlplane/db");
const { getRunnerRuntime, resetRunnerRuntime, configureRunnerRuntime } = await import("@/lib/runners/runtime");
const { createRegistrationToken } = await import("@/lib/runners/service");
const { RunnerConfigError } = await import("@/lib/runners/types");
const { API, FakeAgent, ORIGIN, call, newAgentKey } = await import("./_support");

const ENV_KEYS = ["ZENITH_CONTROL_SIGNING_JWK", "ZENITH_CONTROL_KMS_KEY_ID", "ZENITH_RUNNER_RESULT_KEY", "ZENITH_PLATFORM_DB", "ZENITH_PLATFORM_DB_URL", "SUPABASE_DB_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetRunnerRuntime();
  resetSignerCache();
  await resetPlatformDbForTests();
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRunnerRuntime();
  resetSignerCache();
  await resetPlatformDbForTests();
});

describe("fail closed", () => {
  it("without a control-plane signing key the runtime refuses to exist, and the routes answer 503 with the code", async () => {
    await expect(getRunnerRuntime()).rejects.toBeInstanceOf(RunnerConfigError);
    const res = await call(registerRunner, new NextRequest(new URL(`${API}/runners/register`, ORIGIN), { method: "POST", body: JSON.stringify({ token: "zrt_x" }) }));
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("runner_plane_unconfigured");
    expect(res.body.error?.message).toMatch(/ZENITH_CONTROL_SIGNING_JWK/);
  });

  it("a signer with no local key material and no ZENITH_RUNNER_RESULT_KEY cannot seal results: the runtime refuses", async () => {
    // a KMS-backed signer exposes no private scalar to derive a sealing key from; stand in for it with an injected signer
    const { newSigner } = await import("./_support");
    configureRunnerRuntime({ signer: await newSigner("cp-kms-like") });
    process.env.ZENITH_PLATFORM_DB = "pglite";
    const err = await getRunnerRuntime().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerConfigError);
    expect(String((err as Error).message)).toMatch(/ZENITH_RUNNER_RESULT_KEY/);
  });

  it("never reveals key material in a configuration error", async () => {
    process.env.ZENITH_CONTROL_SIGNING_JWK = '{"kty":"OKP","crv":"Ed25519","d":"SECRET-SCALAR-VALUE","x":"nope"}';
    const err = await getRunnerRuntime().catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain("SECRET-SCALAR-VALUE");
  });
});

describe("defaults from the environment (credential module signer + platform store on PGlite)", () => {
  it("registers and polls with nothing injected", async () => {
    const key = await generateSigningJwk("EdDSA", { kid: "cp-env" });
    process.env.ZENITH_CONTROL_SIGNING_JWK = JSON.stringify(key.privateJwk);
    process.env.ZENITH_PLATFORM_DB = "pglite";

    const rt = await getRunnerRuntime();
    expect(rt.signer.kid).toBe("cp-env");
    const created = await createRegistrationToken(rt, { workspaceId: "w-env", kind: "runner", createdBy: "admin" });
    const agentKey = newAgentKey();
    const reg = await call(registerRunner, new NextRequest(new URL(`${API}/runners/register`, ORIGIN), { method: "POST", body: JSON.stringify({ token: created.token, publicKey: agentKey.publicKey, name: "env-runner", capabilities: ["aws.http"] }) }));
    expect(reg.status).toBe(201);
    expect(reg.body.controlPlaneKeys).toEqual([{ kid: "cp-env", publicKey: key.publicJwk.x }]);

    const agent = new FakeAgent({ rt } as never, "runner", String(reg.body.id), "w-env", agentKey, reg.body.controlPlaneKeys as never);
    const poll = await agent.post(pollRunner, "/poll", { max: 1, waitSec: 0 });
    expect(poll.status).toBe(200);
    expect(poll.body.jobs).toEqual([]);
  });

  it("uses ZENITH_RUNNER_RESULT_KEY when set, and derives the sealing key from the signing JWK when not", async () => {
    const key = await generateSigningJwk("EdDSA", { kid: "cp-env" });
    process.env.ZENITH_CONTROL_SIGNING_JWK = JSON.stringify(key.privateJwk);
    process.env.ZENITH_PLATFORM_DB = "pglite";
    const derived = (await getRunnerRuntime()).sealer;
    const box = derived.seal("a|b", { v: 1 });
    expect((await getRunnerRuntime()).sealer.open("a|b", box)).toEqual({ v: 1 });
    process.env.ZENITH_RUNNER_RESULT_KEY = Buffer.alloc(32, 5).toString("base64url");
    const explicit = (await getRunnerRuntime()).sealer;
    expect(() => explicit.open("a|b", box)).toThrow(); // a different key
    expect(explicit.open("a|b", explicit.seal("a|b", { v: 2 }))).toEqual({ v: 2 });
  });
});
