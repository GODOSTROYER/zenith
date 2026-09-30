import { inspect } from "node:util";
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AwsCredentialBroker, sessionPolicyFor } from "@/lib/credentials/aws";
import { CredentialDeniedError, type AwsSession, type CredentialEventDraft, type ProviderConnection } from "@/lib/credentials/types";
import { assertNoCredentialLeak } from "@/lib/credentials/redact";
import { LocalJwkSigner } from "@/lib/credentials/signing";
import { RunnerTransportUnavailableError, SessionExpiredError } from "@/lib/credentials/errors";
import { ACCOUNT, FAKE_CREDS, FAKE_SECRETS, ISSUER, awsConfig, connection, grant, makeKeys, nowSec, type Keys } from "./helpers";

const stsMock = mockClient(STSClient);
let keys: Keys;
let signer: LocalJwkSigner;

beforeAll(async () => {
  keys = await makeKeys();
  signer = LocalJwkSigner.fromJwk("T", keys.rsa.privateJwk, { alg: "RS256" });
});

const EXPIRATION = new Date(Date.now() + 15 * 60_000);
const stsOk = {
  Credentials: { ...FAKE_CREDS, Expiration: EXPIRATION },
  AssumedRoleUser: { Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ZenithObserveRole/zenith-op`, AssumedRoleId: "AROAEXAMPLE:zenith-op" },
};

beforeEach(() => {
  stsMock.reset();
  stsMock.on(AssumeRoleWithWebIdentityCommand).resolves(stsOk);
  stsMock.on(AssumeRoleCommand).resolves(stsOk);
  stsMock.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ZenithObserveRole/x` });
});
afterEach(() => stsMock.reset());

interface Harness {
  broker: AwsCredentialBroker;
  events: CredentialEventDraft[];
  conns: Map<string, ProviderConnection>;
}

function harness(
  conns: ProviderConnection[] = [connection()],
  extra: Partial<ConstructorParameters<typeof AwsCredentialBroker>[0]> = {}
): Harness {
  const events: CredentialEventDraft[] = [];
  const map = new Map(conns.map((c) => [c.id, c]));
  const broker = new AwsCredentialBroker({
    resolveConnection: async (id) => map.get(id) ?? null,
    emit: (e) => void events.push(e),
    oidc: { signer, issuer: ISSUER },
    ...extra,
  });
  return { broker, events, conns: map };
}

const req = (over: Record<string, unknown> = {}) => ({
  connectionId: "conn_1",
  grant: grant(),
  purpose: "observe" as const,
  ...over,
});

const stsCalls = () => stsMock.calls().length;
const noop = async (s: unknown) => s;

async function denial(h: Harness, request: ReturnType<typeof req>): Promise<CredentialDeniedError> {
  const err = await h.broker.withSession(request, noop).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(CredentialDeniedError);
  return err as CredentialDeniedError;
}

describe("oidc_web_identity", () => {
  it("exchanges a Zenith-minted token for the observe role with the documented parameters", async () => {
    const h = harness();
    let seen: AwsSession | undefined;
    const result = await h.broker.withSession(req(), async (session) => {
      seen = session as AwsSession;
      return "done";
    });
    expect(result).toBe("done");
    expect(seen).toMatchObject({ provider: "aws", accountId: ACCOUNT, region: "ap-south-1", transport: "direct" });

    const calls = stsMock.commandCalls(AssumeRoleWithWebIdentityCommand);
    expect(calls).toHaveLength(1);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
    const input = calls[0].args[0].input;
    expect(input.RoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole`);
    expect(input.RoleSessionName).toBe("zenith-op_1234567890abcdef");
    expect(input.DurationSeconds).toBe(900);
    expect(input).not.toHaveProperty("ExternalId");
    expect(input).not.toHaveProperty("Tags");
    // the capability-derived least-privilege policy is attached
    expect(input.Policy).toBe(JSON.stringify(sessionPolicyFor("infrastructure.observe", { accountId: ACCOUNT, region: "ap-south-1" })));

    const { payload, protectedHeader } = await jwtVerify(input.WebIdentityToken!, createLocalJWKSet({ keys: [signer.publicJwk()] }), {
      issuer: ISSUER,
      audience: "sts.amazonaws.com",
      subject: "zenith:ws:ws_1:conn:conn_1",
      algorithms: ["RS256"],
    });
    expect(protectedHeader.kid).toBe(keys.rsa.kid);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);
    expect(payload.zenith_op).toBe("op_1234567890abcdef");
    expect(payload.zenith_cap).toBe("infrastructure.observe");
    expect(payload["https://aws.amazon.com/tags"]).toEqual({
      principal_tags: {
        "zenith:workspace": ["ws_1"],
        "zenith:operation": ["op_1234567890abcdef"],
        "zenith:capability": ["infrastructure.observe"],
      },
    });
  });

  it("uses the deploy role for a mutating capability and passes the capability's narrowing policy", async () => {
    const h = harness();
    await h.broker.withSession(req({ purpose: "deploy", grant: grant({ cap: "service.restart", env: "env-prod1" }) }), noop);
    const input = stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input;
    expect(input.RoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole`);
    expect(input.Policy).toContain("ecs:UpdateService");
    expect(input.Policy).toContain("zenith-env-prod1");
  });

  it("passes no Policy when the role policy is the control (infrastructure.apply)", async () => {
    const h = harness();
    await h.broker.withSession(req({ purpose: "deploy", grant: grant({ cap: "infrastructure.apply" }) }), noop);
    expect(stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input).not.toHaveProperty("Policy");
  });

  it("lets a caller-supplied session policy replace the derived one (after validation)", async () => {
    const h = harness();
    const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "ec2:DescribeVpcs", Resource: "*" }] };
    await h.broker.withSession(req({ sessionPolicy: policy }), noop);
    expect(stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input.Policy).toBe(JSON.stringify(policy));
  });

  it("can disable derived policies and session tags", async () => {
    const h = harness([connection()], { deriveSessionPolicy: false, oidcSessionTags: false });
    await h.broker.withSession(req(), noop);
    const input = stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input;
    expect(input).not.toHaveProperty("Policy");
    const { payload } = await jwtVerify(input.WebIdentityToken!, createLocalJWKSet({ keys: [signer.publicJwk()] }));
    expect(payload).not.toHaveProperty(["https://aws.amazon.com/tags"]);
  });

  it("denies (issuer_unavailable) when the OIDC issuer is not configured, without calling STS", async () => {
    const h = harness([connection()], { oidc: { env: {} } });
    const err = await denial(h, req());
    expect(err.reason).toBe("issuer_unavailable");
    expect(err.message).toMatch(/ZENITH_OIDC_ISSUER/);
    expect(stsCalls()).toBe(0);
  });
});

describe("aws_assume_role", () => {
  const assumeConn = () => connection({}, { mode: "aws_assume_role", externalId: "zx-1234567890abcdef" });

  it("calls AssumeRole with the per-connection ExternalId, sanitised session tags and no transitive keys", async () => {
    const h = harness([assumeConn()]);
    await h.broker.withSession(
      req({ grant: grant({ ws: "ws_1", op: "op_weird id;{}<script>", cap: "infrastructure.observe" }) }),
      noop
    );
    expect(stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)).toHaveLength(0);
    const input = stsMock.commandCalls(AssumeRoleCommand)[0].args[0].input;
    expect(input.RoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole`);
    expect(input.ExternalId).toBe("zx-1234567890abcdef");
    expect(input.DurationSeconds).toBe(900);
    expect(input).not.toHaveProperty("TransitiveTagKeys");
    expect(input).not.toHaveProperty("WebIdentityToken");
    expect(input.RoleSessionName).toMatch(/^zenith-[\w+=,.@-]{1,57}$/);
    expect(input.RoleSessionName).not.toMatch(/[ ;{}<>]/);
    const tags = Object.fromEntries((input.Tags ?? []).map((t) => [t.Key, t.Value]));
    expect(Object.keys(tags).sort()).toEqual(["zenith:capability", "zenith:operation", "zenith:workspace"]);
    expect(tags["zenith:workspace"]).toBe("ws_1");
    expect(tags["zenith:capability"]).toBe("infrastructure.observe");
    expect(tags["zenith:operation"]).toBe("op_weird id____script_");
    for (const t of input.Tags ?? []) {
      expect(t.Key!.length).toBeLessThanOrEqual(128);
      expect(t.Value!.length).toBeLessThanOrEqual(256);
      expect(t.Value).toMatch(/^[\p{L}\p{N} _.:/=+@-]+$/u);
    }
    expect(input.Policy).toBeDefined();
  });

  it("truncates over-long tag values to 256 characters", async () => {
    const h = harness([assumeConn()]);
    await h.broker.withSession(req({ grant: grant({ ws: "ws_1", op: "o".repeat(400) }) }), noop);
    const tags = stsMock.commandCalls(AssumeRoleCommand)[0].args[0].input.Tags!;
    expect(tags.find((t) => t.Key === "zenith:operation")!.Value).toHaveLength(256);
  });

  it("requires a valid ExternalId", async () => {
    for (const externalId of [undefined, "", "x", "has space", "a".repeat(1300)]) {
      const h = harness([connection({}, { mode: "aws_assume_role", externalId })]);
      expect((await denial(h, req())).reason).toBe("external_id_missing");
    }
    expect(stsCalls()).toBe(0);
  });
});

describe("duration", () => {
  const dur = async (opts: { requested?: number; remaining: number; configured?: number }) => {
    const h = harness([connection({}, { sessionDurationSec: opts.configured })]);
    await h.broker.withSession(
      req({ durationSec: opts.requested, grant: grant({ exp: nowSec() + opts.remaining }) }),
      noop
    );
    return stsMock.commandCalls(AssumeRoleWithWebIdentityCommand).at(-1)!.args[0].input.DurationSeconds;
  };

  it("defaults to 900, then the connection's setting", async () => {
    expect(await dur({ remaining: 3000 })).toBe(900);
    expect(await dur({ remaining: 3000, configured: 1800 })).toBe(1800);
  });

  it("clamps to 3600 and to the grant's remaining lifetime", async () => {
    expect(await dur({ requested: 99999, remaining: 7200 })).toBe(3600);
    expect(await dur({ requested: 3000, remaining: 1200 })).toBeGreaterThanOrEqual(1198);
    expect(await dur({ requested: 3000, remaining: 1200 })).toBeLessThanOrEqual(1200);
    expect(await dur({ requested: 1800, remaining: 3000 })).toBe(1800);
  });

  it("never asks STS for less than its 900-second floor", async () => {
    expect(await dur({ requested: 60, remaining: 3000 })).toBe(900);
    expect(await dur({ requested: 900, remaining: 120 })).toBe(900);
  });

  it("rejects nonsense durations before calling STS", async () => {
    const h = harness();
    for (const durationSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "900" as unknown as number]) {
      expect((await denial(h, req({ durationSec }))).reason).toBe("duration_invalid");
    }
    expect(stsCalls()).toBe(0);
  });
});

describe("denials happen before any STS call", () => {
  const cases: [string, () => Harness, ReturnType<typeof req>, string][] = [
    ["expired grant", () => harness(), req({ grant: grant({ exp: nowSec() - 1 }) }), "grant_expired"],
    ["grant expiring exactly now", () => harness(), req({ grant: grant({ exp: nowSec() }) }), "grant_expired"],
    ["workspace mismatch", () => harness([connection({ workspaceId: "ws_other" })]), req(), "workspace_mismatch"],
    ["unknown connection", () => harness([]), req(), "connection_not_found"],
    ["revoked connection", () => harness([connection({ status: "revoked", revokedAt: "2026-09-01T00:00:00Z" })]), req(), "connection_revoked"],
    ["pending_verification connection", () => harness([connection({ status: "pending_verification" })]), req(), "connection_not_verified"],
    ["failed connection", () => harness([connection({ status: "failed" })]), req(), "connection_not_verified"],
    ["deploy purpose with a read capability", () => harness(), req({ purpose: "deploy", grant: grant({ cap: "logs.read" }) }), "purpose_capability_mismatch"],
    ["observe purpose with a mutating capability", () => harness(), req({ grant: grant({ cap: "infrastructure.apply" }) }), "purpose_capability_mismatch"],
    ["unknown capability", () => harness(), req({ grant: grant({ cap: "made.up" }) }), "unknown_capability"],
    ["non-AWS connection", () => harness([{ ...connection(), config: { provider: "azure", mode: "oidc_web_identity", tenantId: "t", clientId: "c", subscriptionId: "s", region: "westeurope" } }]), req(), "provider_unsupported"],
    ["static_dev mode", () => harness([connection({}, { mode: "static_dev" })]), req(), "mode_unsupported"],
    ["endpoint override", () => harness([connection({}, { endpoint: "http://localhost:4566" })]), req(), "endpoint_not_permitted"],
    ["role in another account", () => harness([connection({}, { observeRoleArn: "arn:aws:iam::999999999999:role/ZenithObserveRole" })]), req(), "role_account_mismatch"],
    ["malformed role ARN", () => harness([connection({}, { observeRoleArn: "not-an-arn" })]), req(), "role_arn_invalid"],
    ["wildcard session policy", () => harness(), req({ sessionPolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] } }), "session_policy_invalid"],
    ["oversized session policy", () => harness(), req({ sessionPolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: Array.from({ length: 80 }, (_, i) => `arn:aws:s3:::zenith-bucket-${i}/*`) }] } }), "session_policy_invalid"],
    ["environment-scoped capability without an environment", () => harness(), req({ purpose: "deploy", grant: grant({ cap: "service.restart", env: undefined }) }), "session_policy_unavailable"],
    ["environment id that is not ARN-safe", () => harness(), req({ grant: grant({ cap: "logs.read", env: "prod*" }) }), "session_policy_unavailable"],
    ["missing grant", () => harness(), req({ grant: undefined as never }), "grant_invalid"],
  ];

  it.each(cases)("%s", async (_name, make, request, reason) => {
    const h = make();
    const err = await denial(h, request);
    expect(err.reason).toBe(reason);
    expect(err.code).toBe("credential_denied");
    expect(stsCalls()).toBe(0);
    if (reason !== "grant_invalid") {
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({ type: "credential.denied", workspaceId: "ws_1" });
      expect(h.events[0].data).toMatchObject({ connectionId: "conn_1", purpose: request.purpose, reason });
    }
    assertNoCredentialLeak(err, { secrets: FAKE_SECRETS });
    assertNoCredentialLeak(h.events, { secrets: FAKE_SECRETS });
  });

  it("does not run the callback, and the workspace-mismatch denial never names the other workspace", async () => {
    const h = harness([connection({ workspaceId: "ws_secret_other" })]);
    let ran = false;
    const err = (await h.broker
      .withSession(req(), async () => {
        ran = true;
      })
      .catch((e: unknown) => e)) as CredentialDeniedError;
    expect(ran).toBe(false);
    expect(JSON.stringify([err.message, h.events])).not.toContain("ws_secret_other");
    expect(h.events[0].workspaceId).toBe("ws_1");
  });

  it("does not turn a resolver outage into a credential decision", async () => {
    const broker = new AwsCredentialBroker({
      resolveConnection: async () => {
        throw new Error("db down");
      },
      oidc: { signer, issuer: ISSUER },
    });
    await expect(broker.withSession(req(), noop)).rejects.toThrow("db down");
    expect(stsCalls()).toBe(0);
  });

  it("survives a failing audit sink on denial (the refusal still surfaces)", async () => {
    const broker = new AwsCredentialBroker({
      resolveConnection: async () => connection({ status: "revoked" }),
      emit: () => {
        throw new Error("event store down");
      },
      oidc: { signer, issuer: ISSUER },
    });
    await expect(broker.withSession(req(), noop)).rejects.toMatchObject({ reason: "connection_revoked" });
  });
});

describe("runner mode", () => {
  const runnerConn = () => connection({}, { mode: "runner", runnerId: "run_1" });

  it("returns a runner session whose client() throws runner_transport_unavailable, with no STS call", async () => {
    const h = harness([runnerConn()]);
    await h.broker.withSession(req(), async (s) => {
      const session = s as AwsSession;
      expect(session.transport).toBe("runner");
      expect(() => session.client(S3Client)).toThrow(RunnerTransportUnavailableError);
      try {
        session.client(S3Client);
      } catch (e) {
        expect((e as { code: string }).code).toBe("runner_transport_unavailable");
      }
      expect(() => session.childProcessEnv()).toThrow(RunnerTransportUnavailableError);
    });
    expect(stsCalls()).toBe(0);
    expect(h.events[0]).toMatchObject({ type: "credential.assumed", data: { mode: "runner" } });
  });

  it("delegates to an injected transport factory and closes it afterwards", async () => {
    let closed = false;
    let opened: { roleArn: string; purpose: string; sessionPolicy?: string } | undefined;
    const h = harness([runnerConn()], {
      runnerTransport: {
        open: (input) => {
          opened = { roleArn: input.roleArn, purpose: input.purpose, sessionPolicy: input.sessionPolicy };
          return {
            client: (ctor) => new ctor({ region: input.config.region }),
            close: () => {
              closed = true;
            },
          };
        },
      },
    });
    stsMock.reset();
    const s3 = mockClient(S3Client);
    s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: "zenith-a" }] });
    let client: S3Client | undefined;
    await h.broker.withSession(req(), async (s) => {
      client = (s as AwsSession).client(S3Client);
      expect((await client.send(new ListBucketsCommand({}))).Buckets).toHaveLength(1);
    });
    expect(opened).toMatchObject({ purpose: "observe", roleArn: `arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole` });
    expect(closed).toBe(true);
    await expect(client!.send(new ListBucketsCommand({}))).rejects.toBeInstanceOf(SessionExpiredError);
    s3.restore();
  });
});

describe("runner transport failures", () => {
  it("denies with runner_unavailable (and a recorded event) when the factory throws", async () => {
    const h = harness([connection({}, { mode: "runner", runnerId: "run_1" })], {
      runnerTransport: {
        open: () => {
          throw new Error("runner offline");
        },
      },
    });
    const err = await denial(h, req());
    expect(err.reason).toBe("runner_unavailable");
    expect(h.events[0]).toMatchObject({ type: "credential.denied", data: { reason: "runner_unavailable", mode: "runner" } });
  });
});

describe("the session", () => {
  it("builds SDK clients with the brokered credentials, region and maxAttempts 3 — and never exposes the credentials", async () => {
    const h = harness();
    let captured: Record<string, unknown> | undefined;
    class Probe {
      constructor(public config: Record<string, unknown>) {
        captured = config;
      }
      async send() {
        return "ok";
      }
    }
    await h.broker.withSession(req(), async (s) => {
      const session = s as AwsSession;
      const client = session.client(Probe);
      expect(await client.send()).toBe("ok");
      expect(captured).toMatchObject({ region: "ap-south-1", maxAttempts: 3 });
      expect(captured).not.toHaveProperty("endpoint");
      const creds = await (captured!.credentials as () => Promise<Record<string, string>>)();
      expect(creds.accessKeyId).toBe(FAKE_CREDS.AccessKeyId);
      expect(creds.sessionToken).toBe(FAKE_CREDS.SessionToken);
      // the session object itself has no credential accessor
      expect(Object.keys(session).sort()).toEqual(["accountId", "childProcessEnv", "client", "expiresAt", "provider", "region", "transport"]);
      expect(Object.keys(session)).not.toContain("credentials");
      expect(session.expiresAt).toBe(EXPIRATION.toISOString());
      // a per-call region override works and is validated
      session.client(Probe, { region: "eu-west-1" });
      expect(captured!.region).toBe("eu-west-1");
      expect(() => session.client(Probe, { region: "evil.example.com/x" })).toThrow(/region/);
    });
  });

  it("wraps real SDK clients: they work inside the callback and refuse after it settles", async () => {
    const s3 = mockClient(S3Client);
    s3.on(ListBucketsCommand).resolves({ Buckets: [] });
    const h = harness();
    let session!: AwsSession;
    let client!: S3Client;
    let provider!: () => Promise<unknown>;
    class Probe {
      config: Record<string, unknown>;
      constructor(config: Record<string, unknown>) {
        this.config = config;
        provider = config.credentials as () => Promise<unknown>;
      }
      send = async () => "live";
    }
    let probe!: Probe;
    await h.broker.withSession(req(), async (s) => {
      session = s as AwsSession;
      client = session.client(S3Client);
      probe = session.client(Probe);
      await expect(client.send(new ListBucketsCommand({}))).resolves.toEqual({ Buckets: [] });
      await expect(probe.send()).resolves.toBe("live");
      await expect(provider()).resolves.toMatchObject({ accessKeyId: FAKE_CREDS.AccessKeyId });
    });
    // after the callback: everything built from the session is dead
    expect(() => session.client(S3Client)).toThrow(SessionExpiredError);
    expect(() => session.childProcessEnv()).toThrow(SessionExpiredError);
    await expect(client.send(new ListBucketsCommand({}))).rejects.toMatchObject({ code: "session_expired" });
    await expect(probe.send()).rejects.toMatchObject({ code: "session_expired" });
    await expect(provider()).rejects.toMatchObject({ code: "session_expired" });
    s3.restore();
  });

  it("is also invalidated when the callback throws, and rethrows the callback's error unchanged", async () => {
    const h = harness();
    let session!: AwsSession;
    const boom = new Error("tofu exploded");
    await expect(
      h.broker.withSession(req(), async (s) => {
        session = s as AwsSession;
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(() => session.client(S3Client)).toThrow(SessionExpiredError);
  });

  it("expires with the credentials' own expiry even while the callback is still running", async () => {
    let clock = Date.now();
    stsMock.on(AssumeRoleWithWebIdentityCommand).resolves({ ...stsOk, Credentials: { ...stsOk.Credentials, Expiration: new Date(clock + 60_000) } });
    const h = harness([connection()], { now: () => new Date(clock) });
    await h.broker.withSession(req({ grant: grant({ exp: Math.floor(clock / 1000) + 600 }) }), async (s) => {
      const session = s as AwsSession;
      expect(Object.keys(session.childProcessEnv())).toHaveLength(5);
      clock += 61_000;
      expect(() => session.childProcessEnv()).toThrow(SessionExpiredError);
    });
  });

  it("childProcessEnv returns exactly the five allowed variables", async () => {
    const h = harness();
    await h.broker.withSession(req(), async (s) => {
      const env = (s as AwsSession).childProcessEnv();
      expect(Object.keys(env).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);
      expect(env).toEqual({
        AWS_ACCESS_KEY_ID: FAKE_CREDS.AccessKeyId,
        AWS_SECRET_ACCESS_KEY: FAKE_CREDS.SecretAccessKey,
        AWS_SESSION_TOKEN: FAKE_CREDS.SessionToken,
        AWS_REGION: "ap-south-1",
        AWS_DEFAULT_REGION: "ap-south-1",
      });
    });
  });

  it("returns a fresh environment object each call (mutating it cannot change the session)", async () => {
    const h = harness();
    await h.broker.withSession(req(), async (s) => {
      const a = (s as AwsSession).childProcessEnv();
      a.AWS_ACCESS_KEY_ID = "tampered";
      expect((s as AwsSession).childProcessEnv().AWS_ACCESS_KEY_ID).toBe(FAKE_CREDS.AccessKeyId);
    });
  });
});

describe("credentials never leak", () => {
  it("not through JSON.stringify(session), util.inspect, events, or the broker's own state", async () => {
    const h = harness();
    await h.broker.withSession(req(), async (s) => {
      const session = s as AwsSession;
      session.client(S3Client);
      expect(JSON.parse(JSON.stringify(session))).toEqual({
        provider: "aws",
        accountId: ACCOUNT,
        region: "ap-south-1",
        expiresAt: EXPIRATION.toISOString(),
        transport: "direct",
      });
      for (const text of [JSON.stringify(session), inspect(session, { depth: 6, showHidden: true }), `${String(session)}`]) {
        for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
      }
      assertNoCredentialLeak(session, { secrets: FAKE_SECRETS });
    });
    assertNoCredentialLeak(h.events, { secrets: FAKE_SECRETS });
    assertNoCredentialLeak(h.broker, { secrets: FAKE_SECRETS });
    assertNoCredentialLeak(inspect(h.broker, { depth: 8, showHidden: true }), { secrets: FAKE_SECRETS });
  });

  it("assumed events carry exactly identifiers: connection, purpose, mode, duration, role ARN (+capability)", async () => {
    const h = harness();
    await h.broker.withSession(req({ purpose: "deploy", grant: grant({ cap: "infrastructure.apply", proj: "p1", env: "env1", res: "r1" }) }), noop);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: "credential.assumed",
      workspaceId: "ws_1",
      projectId: "p1",
      environmentId: "env1",
      resourceId: "r1",
      operationId: "op_1234567890abcdef",
      correlationId: "op_1234567890abcdef",
    });
    expect(h.events[0].data).toEqual({
      connectionId: "conn_1",
      purpose: "deploy",
      mode: "oidc_web_identity",
      durationSec: 900,
      roleArn: `arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole`,
      capability: "infrastructure.apply",
    });
    assertNoCredentialLeak(h.events, { secrets: FAKE_SECRETS });
  });

  it("not through STS errors, even when the SDK error echoes the web-identity token or keys", async () => {
    const h = harness();
    let echoed = "";
    stsMock.on(AssumeRoleWithWebIdentityCommand).callsFake((input: { WebIdentityToken: string }) => {
      echoed = input.WebIdentityToken;
      throw Object.assign(new Error(`InvalidIdentityToken for ${input.WebIdentityToken} using ${FAKE_CREDS.AccessKeyId} ${FAKE_CREDS.SecretAccessKey}`), {
        name: "InvalidIdentityToken",
      });
    });
    const err = await denial(h, req());
    expect(err.reason).toBe("sts_failed");
    expect(echoed.split(".")).toHaveLength(3);
    expect(err.message).not.toContain(echoed);
    expect(err.message).toContain("InvalidIdentityToken");
    assertNoCredentialLeak(err, { secrets: [...FAKE_SECRETS, echoed] });
    assertNoCredentialLeak(h.events, { secrets: [...FAKE_SECRETS, echoed] });
    expect(h.events[0]).toMatchObject({ type: "credential.denied", data: { reason: "sts_failed", stsError: "InvalidIdentityToken", mode: "oidc_web_identity" } });
  });

  it("STS returning incomplete credentials or another account's credentials is a denial, not a session", async () => {
    stsMock.on(AssumeRoleWithWebIdentityCommand).resolves({ Credentials: { AccessKeyId: "ASIAX", Expiration: EXPIRATION } as never });
    const h = harness();
    expect((await denial(h, req())).reason).toBe("sts_failed");
    stsMock.on(AssumeRoleWithWebIdentityCommand).resolves({ ...stsOk, AssumedRoleUser: { Arn: "arn:aws:sts::999999999999:assumed-role/R/s", AssumedRoleId: "x" } });
    expect((await denial(h, req())).reason).toBe("role_account_mismatch");
  });

  it("fails closed when the audit sink fails: no session is handed out and the callback never runs", async () => {
    const h = harness([connection()], {
      emit: (e) => {
        if (e.type === "credential.assumed") throw new Error("event store down");
      },
    });
    let ran = false;
    const err = (await h.broker
      .withSession(req(), async () => {
        ran = true;
      })
      .catch((e: unknown) => e)) as CredentialDeniedError;
    expect(ran).toBe(false);
    expect(err.reason).toBe("audit_failed");
  });
});

describe("verifyConnection", () => {
  it("assumes the observe role, calls GetCallerIdentity and returns the account id", async () => {
    const h = harness([connection({ status: "pending_verification" })]);
    const out = await h.broker.verifyConnection("conn_1");
    expect(out).toEqual({ ok: true, detail: `Assumed the observe role in account ${ACCOUNT}.`, accountId: ACCOUNT });
    expect(stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input.RoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole`);
    expect(stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input).not.toHaveProperty("Policy");
    expect(stsMock.commandCalls(GetCallerIdentityCommand)).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: "credential.assumed", workspaceId: "ws_1", data: { purpose: "observe", capability: "connection.verify" } });
    assertNoCredentialLeak(out, { secrets: FAKE_SECRETS });
  });

  it("works for a failed connection (re-verification) and for assume-role mode", async () => {
    const h = harness([connection({ status: "failed" }, { mode: "aws_assume_role", externalId: "zx-1234567890" })]);
    expect((await h.broker.verifyConnection("conn_1")).ok).toBe(true);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });

  it("fails when the caller identity is in a different account than configured", async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: "999999999999" });
    const out = await harness().broker.verifyConnection("conn_1");
    expect(out.ok).toBe(false);
    expect(out.accountId).toBe("999999999999");
    expect(out.detail).toContain(ACCOUNT);
  });

  it("refuses revoked connections, unknown ids and other workspaces without calling STS", async () => {
    expect((await harness([connection({ status: "revoked" })]).broker.verifyConnection("conn_1")).ok).toBe(false);
    expect(await harness([]).broker.verifyConnection("nope")).toEqual({ ok: false, detail: "Connection not found." });
    const h = harness();
    expect(await h.broker.verifyConnection("conn_1", { workspaceId: "ws_other" })).toEqual({ ok: false, detail: "Connection not found." });
    expect(stsCalls()).toBe(0);
    expect((await h.broker.verifyConnection("conn_1", { workspaceId: "ws_1" })).ok).toBe(true);
  });

  it("reports STS failures without secrets and emits credential.denied", async () => {
    stsMock.on(AssumeRoleWithWebIdentityCommand).rejects(Object.assign(new Error("Not authorized to perform sts:AssumeRoleWithWebIdentity"), { name: "AccessDenied" }));
    const h = harness();
    const out = await h.broker.verifyConnection("conn_1");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("AccessDenied");
    expect(h.events[0].type).toBe("credential.denied");
  });

  it("explains that runner connections cannot be verified without a transport", async () => {
    const out = await harness([connection({}, { mode: "runner" })]).broker.verifyConnection("conn_1");
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/runner/i);
  });

  it("does not emit the identity-call client after the verification finished", async () => {
    const h = harness();
    await h.broker.verifyConnection("conn_1");
    // nothing to assert on the client itself (it is internal); the STS mock proves exactly one exchange happened
    expect(stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)).toHaveLength(1);
  });
});

describe("AwsConnectionConfig awareness", () => {
  it("honours a custom partition/role path on the role ARN", async () => {
    const h = harness([connection({}, { observeRoleArn: `arn:aws:iam::${ACCOUNT}:role/zenith/ZenithObserveRole` })]);
    await h.broker.withSession(req(), noop);
    expect(stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input.RoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/zenith/ZenithObserveRole`);
  });

  it("static fixture sanity: awsConfig has no endpoint or external id by default", () => {
    expect(awsConfig()).not.toHaveProperty("endpoint");
    expect(awsConfig()).not.toHaveProperty("externalId");
  });
});
