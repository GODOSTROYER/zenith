/**
 * Test support for the runner plane: a wired "plane" (store, signer, sealer,
 * clock) and a fake agent that speaks the wire protocol the way the Go agents do.
 *
 * The fake agent builds its signing string and verifies job JWS with node:crypto
 * DIRECTLY — it deliberately does not call `signingString()` or
 * `verifyControlJws()` from the code under test, so a mistake there is caught
 * here instead of being mirrored. The Go golden vectors (fixtures/go-*.json)
 * are the independent ground truth for the byte forms.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { NextRequest } from "next/server";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { createMemoryRunnerStore } from "@/lib/runners/memory-store";
import type { RunnerEvent, RunnerStore } from "@/lib/runners/ports";
import { configureRunnerRuntime, resetRunnerRuntime, realSleep, abortError, type RunnerRuntime } from "@/lib/runners/runtime";
import { createAesResultSealer } from "@/lib/runners/seal";
import { createControlSignerFromJwk, generateControlSigningJwk, type ControlSigner } from "@/lib/runners/signing";
import { createRegistrationToken } from "@/lib/runners/service";
import { MACHINE_PROTOCOL, RUNNER_PROTOCOL, type AgentKind } from "@/lib/runners/types";

export const ORIGIN = "https://zenith.test";
export const API = "/api/platform/v1";
export const T0 = Date.parse("2026-09-30T12:00:00Z");

export interface Plane {
  rt: RunnerRuntime;
  store: RunnerStore;
  signer: ControlSigner;
  events: RunnerEvent[];
  /** fake clock (mode "fake"); in "real" mode `now` is wall time */
  clock: { t: number };
  /** control-plane public keys as an agent pins them */
  cpKeys: { kid: string; publicKey: string }[];
}

/**
 * "fake": the clock is ours and `sleep` just advances it (deterministic timeouts; use when no
 * concurrent actor needs real time). "real": wall clock with a few-ms poll step (end-to-end
 * flows where a fake agent serves jobs concurrently).
 */
export function createPlane(mode: "fake" | "real" = "fake", extra: Partial<RunnerRuntime> = {}): Plane {
  const clock = { t: T0 };
  const now = mode === "fake" ? () => clock.t : Date.now;
  const store = createMemoryRunnerStore({ now });
  const signer = createControlSignerFromJwk(generateControlSigningJwk("cp-test"));
  const events: RunnerEvent[] = [];
  const rt: RunnerRuntime = {
    store,
    signer,
    sealer: createAesResultSealer(randomBytes(32)),
    events: { emit: (e) => void events.push(e) },
    now,
    sleep:
      mode === "fake"
        ? async (ms, signal) => {
            if (signal?.aborted) throw abortError();
            clock.t += ms;
            await Promise.resolve();
          }
        : realSleep,
    pollStepMs: mode === "fake" ? 500 : 5,
    ...extra,
  };
  configureRunnerRuntime(rt);
  return { rt, store, signer, events, clock, cpKeys: signer.publicKeys() };
}

export const teardownPlane = (): void => resetRunnerRuntime();

/* ------------------------------ route invocation ------------------------------ */

type RouteFn = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function call(handler: unknown, req: NextRequest, params: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> & { error?: { code: string; message: string } }; headers: Headers }> {
  const res = await (handler as RouteFn)(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
}

/* --------------------------------- fake agent --------------------------------- */

const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");

export function newAgentKey(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(publicKey.export({ format: "jwk" }).x) };
}

export function keyFromSeedHex(seedHex: string): { privateKey: KeyObject; publicKey: string } {
  const seed = Buffer.from(seedHex, "hex");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}

export interface SignOptions {
  timestamp?: number;
  nonce?: string;
  protocol?: string;
  method?: string;
  /** sign this path but send another */
  signPath?: string;
  /** sign these body bytes but send others */
  signBody?: string;
  agentHeader?: string;
  extraHeaders?: Record<string, string>;
  privateKey?: KeyObject;
}

export interface DecodedJob {
  token: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown> & { jti: string; kind?: string; payload?: unknown; grant: string; capability?: string; operation?: string; args?: unknown };
}

export class FakeAgent {
  readonly protocol: string;
  constructor(
    readonly plane: Plane,
    readonly kind: AgentKind,
    readonly id: string,
    readonly workspaceId: string,
    readonly key: { privateKey: KeyObject; publicKey: string },
    readonly cpKeys: { kid: string; publicKey: string }[]
  ) {
    this.protocol = kind === "runner" ? RUNNER_PROTOCOL : MACHINE_PROTOCOL;
  }

  get collection(): string {
    return this.kind === "runner" ? "runners" : "machines";
  }

  path(suffix: string): string {
    return `${API}/${this.collection}/${this.id}${suffix}`;
  }

  /** A request signed exactly as the Go client signs one. */
  request(method: string, pathAndQuery: string, body?: string, o: SignOptions = {}): NextRequest {
    const ts = o.timestamp ?? Math.floor(this.plane.rt.now() / 1000);
    const nonce = o.nonce ?? b64u(randomBytes(16));
    const signedBody = o.signBody ?? body ?? "";
    const sha = createHash("sha256").update(signedBody, "utf8").digest("hex");
    const signing = [o.protocol ?? this.protocol, (o.method ?? method).toUpperCase(), o.signPath ?? pathAndQuery, String(ts), nonce, sha].join("\n");
    const sig = cryptoSign(null, Buffer.from(signing, "utf8"), o.privateKey ?? this.key.privateKey);
    const headers: Record<string, string> = {
      "x-zenith-agent": o.agentHeader ?? this.id,
      "x-zenith-timestamp": String(ts),
      "x-zenith-nonce": nonce,
      "x-zenith-content-sha256": sha,
      "x-zenith-signature": b64u(sig),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...o.extraHeaders,
    };
    return new NextRequest(new URL(pathAndQuery, ORIGIN), { method, headers, ...(body !== undefined ? { body } : {}) });
  }

  /** Verify a compact JWS with the pinned keys using node:crypto only, and decode it. */
  decodeJob(token: string, typ: string): DecodedJob {
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
    const key = this.cpKeys.find((k) => k.kid === header.kid);
    if (!key) throw new Error(`kid ${String(header.kid)} is not pinned`);
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey }, format: "jwk" });
    if (!cryptoVerify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"))) throw new Error("job signature does not verify against the pinned key");
    if (header.typ !== typ) throw new Error(`typ ${String(header.typ)} != ${typ}`);
    return { token, header, claims: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) };
  }

  jobTyp(): string {
    return this.kind === "runner" ? "zenith-job+jwt" : "zenith-machine+jwt";
  }

  async post(handler: unknown, suffix: string, body: unknown, o: SignOptions = {}, params: Record<string, string> = {}) {
    const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    return call(handler, this.request("POST", this.path(suffix), text, o), { id: this.id, ...params });
  }
}

export interface RegisterOptions {
  workspaceId?: string;
  kind?: AgentKind;
  name?: string;
  capabilities?: string[];
  binding?: { environmentId?: string; address?: string };
}

/** Register a fake agent through the real `register` route (token → agent), like `zenith-runner register`. */
export async function registerFakeAgent(plane: Plane, registerRoute: unknown, o: RegisterOptions = {}): Promise<FakeAgent> {
  const kind = o.kind ?? "runner";
  const workspaceId = o.workspaceId ?? "w-a";
  const created = await createRegistrationToken(plane.rt, { workspaceId, kind, createdBy: "user-admin", binding: o.binding });
  const key = newAgentKey();
  const req = new NextRequest(new URL(`${API}/${kind === "runner" ? "runners" : "machines"}/register`, ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.token,
      publicKey: key.publicKey,
      name: o.name ?? `test-${kind}`,
      version: "1.0.0",
      capabilities: o.capabilities ?? (kind === "runner" ? ["tofu.run", "aws.http", "probe.http", "probe.tcp", "probe.dns", "k8s.http"] : ["machine.inspect", "service.status", "process.list"]),
      labels: { region: "ap-south-1" },
      host: { os: "linux", arch: "amd64" },
    }),
  });
  const res = await call(registerRoute, req);
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  return new FakeAgent(plane, kind, String(res.body.id), String(res.body.workspaceId), key, res.body.controlPlaneKeys as { kid: string; publicKey: string }[]);
}

/* ---------------------------------- grants ---------------------------------- */

/**
 * A capability grant the way the broker issues one: EdDSA JWS `zenith-grant+jwt` signed by the
 * control-plane key. Uses the signer under test, which is the same key the broker would use.
 */
export async function issueGrant(plane: Plane, claims: Partial<CapabilityGrantClaims> & Pick<CapabilityGrantClaims, "aud" | "cap" | "op" | "ws">): Promise<string> {
  const iat = Math.floor(plane.rt.now() / 1000);
  const full: CapabilityGrantClaims = { jti: `grt_${randomBytes(6).toString("hex")}`, iss: "zenith-control-plane", sub: "user_test", iat, exp: iat + 600, digest: "sha256:test", ...claims };
  return plane.signer.sign("zenith-grant+jwt", full);
}

export const runnerGrant = (plane: Plane, a: { runnerId: string; workspaceId: string; operationId: string; capability: string; exp?: number }): Promise<string> =>
  issueGrant(plane, { aud: `runner:${a.runnerId}`, cap: a.capability, op: a.operationId, ws: a.workspaceId, ...(a.exp !== undefined ? { exp: a.exp } : {}) });

export const OPERATION = "op_1";
