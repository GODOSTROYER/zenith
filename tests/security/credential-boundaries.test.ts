/**
 * Broker boundary tests with synthetic STS credentials, never live AWS (WS-SEC).
 * Scan the real broker's return values, events and errors, including Error.name.
 * Callback code is trusted: the broker revokes sessions but does not scrub a
 * callback's return/throw. SEC-F10 pins that error-path limit and the unsanitized
 * STS error name; no claim is made that the callback is a credential sandbox.
 */
import { inspect } from "node:util";
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AwsCredentialBroker } from "@/lib/credentials/aws";
import { redactCredentials } from "@/lib/credentials/redact";
import { generateSigningJwk, LocalJwkSigner } from "@/lib/credentials/signing";
import { workloadSubject } from "@/lib/credentials/oidc/issuer";
import { CredentialDeniedError, type AwsSession, type CredentialEventDraft } from "@/lib/credentials/types";
import { connection, grant } from "../credentials/helpers";
import { assertNoCanaries, canarySecret, deepScanForCanaries, tenantMatrix } from "../_support/security";
import { expectCoverage, measureCoverage, type CoverageMap } from "../_support/security/coverage";

const sts = mockClient(STSClient);
const access = canarySecret("broker/access", "aws-access-key-id", { stable: true });
const secret = canarySecret("broker/secret", "aws-secret-access-key", { stable: true });
const token = canarySecret("broker/token", "aws-session-token", { stable: true });
const externalId = canarySecret("broker/external-id", "hex-key", { stable: true });
const canaries = [access, secret, token, externalId];
let signer: LocalJwkSigner;
beforeAll(async () => {
  signer = LocalJwkSigner.fromJwk("security-test", (await generateSigningJwk("RS256")).privateJwk, { alg: "RS256" });
});
beforeEach(() => {
  sts.reset();
  const response = { Credentials: { AccessKeyId: access, SecretAccessKey: secret, SessionToken: token, Expiration: new Date(Date.now() + 900_000) } };
  sts.on(AssumeRoleCommand).resolves(response);
  sts.on(AssumeRoleWithWebIdentityCommand).resolves(response);
});
afterAll(() => sts.restore());

function harness(mode: "aws_assume_role" | "oidc_web_identity" = "aws_assume_role", ext: string | undefined = externalId) {
  const events: CredentialEventDraft[] = [];
  const connections = [connection({}, { mode, externalId: ext }), connection({ id: "conn_2", workspaceId: "ws_2" }, { mode, externalId: ext })];
  const broker = new AwsCredentialBroker({
    resolveConnection: async (id) => connections.find((c) => c.id === id) ?? null,
    emit: (e) => void events.push(e),
    oidc: { signer, issuer: "https://zenith.test/api/oidc" },
  });
  return { broker, events };
}
const request = () => ({ grant: grant(), connectionId: "conn_1", purpose: "observe" as const });

describe("credential broker composed boundaries", () => {
  it("a foreign or missing connection never obtains a session or calls STS", async () => {
    const h = harness();
    const matrix = await tenantMatrix({
      label: "AwsCredentialBroker.withSession (internal API)", workspaces: ["ws_1", "ws_2"],
      principals: [{ id: "alice", workspaceId: "ws_1" }, { id: "bob", workspaceId: "ws_2" }],
      targets: [{ id: "conn_1", workspaceId: "ws_1" }, { id: "conn_2", workspaceId: "ws_2" }, { id: "conn_missing", workspaceId: null }],
      call: async (p, t) => {
        const before = sts.calls().length;
        try {
          return await h.broker.withSession({ ...request(), grant: grant({ ws: p.workspaceId }), connectionId: t.id }, async () => ({ ok: true }));
        } catch (e) {
          expect(sts.calls().length, "a refused connection must never reach STS").toBe(before);
          throw e;
        }
      },
      classify: (e) => {
        if (!(e instanceof CredentialDeniedError)) throw e;
        return { kind: e.reason === "connection_not_found" ? "not_found" : "forbidden", code: e.reason, message: e.message };
      },
    });
    // Internal diagnostics explicitly distinguish missing from workspace mismatch.
    // No public existence-hiding claim: the eventual route must collapse these.
    matrix.assertIsolated({ noExistenceLeak: false });
    expect(sts.calls(), "exactly the two own-workspace cells exchanged credentials").toHaveLength(2);
    assertNoCanaries(h.events, canaries, "broker events contain references and reason codes only");
  });

  it("ExternalId is required before exchange and appears only in the STS request", async () => {
    const missing = harness("aws_assume_role", "");
    await expect(missing.broker.withSession(request(), async () => true)).rejects.toMatchObject({ reason: "external_id_missing" });
    expect(sts.calls()).toHaveLength(0);
    const h = harness();
    let held: AwsSession | undefined;
    const returned = await h.broker.withAwsSession(request(), async (s) => {
      held = s;
      expect(Object.keys(s.childProcessEnv()).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);
      expect(s.childProcessEnv().AWS_SECRET_ACCESS_KEY).toBe(secret);
      assertNoCanaries([s, inspect(s)], canaries, "session serialization/inspection has no credential accessor");
      return s;
    });
    expect(sts.commandCalls(AssumeRoleCommand)[0].args[0].input.ExternalId).toBe(externalId);
    assertNoCanaries([returned, h.events, missing.events], canaries, "ExternalId and session credentials do not leave via serialization or events");
    expect(() => held!.childProcessEnv(), "escaped session must be revoked after callback").toThrow();
  });

  it("OIDC subject binds both tenant and connection exactly, with no delimiter injection", async () => {
    const h = harness("oidc_web_identity");
    await h.broker.withSession(request(), async () => true);
    const jwt = sts.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input.WebIdentityToken!;
    const verified = await jwtVerify(jwt, createLocalJWKSet({ keys: [signer.publicJwk()] }), {
      issuer: "https://zenith.test/api/oidc", audience: "sts.amazonaws.com", subject: "zenith:ws:ws_1:conn:conn_1", algorithms: ["RS256"],
    });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(120);
    for (const id of ["a:conn:b", "a/b", "a\nsub", "", "a b"]) {
      expect(() => workloadSubject(id, "conn_1"), "workspace cannot inject a subject delimiter").toThrow();
      expect(() => workloadSubject("ws_1", id), "connection cannot inject a subject delimiter").toThrow();
    }
    assertNoCanaries(h.events, [...canaries, jwt], "the exchanged OIDC bearer never reaches broker events");
  });

  it("CONTROL: STS credential-shaped error messages are scrubbed before leaving the broker", async () => {
    const h = harness();
    sts.on(AssumeRoleCommand).rejects(new Error(`denied ${access} SecretAccessKey=${secret} SessionToken=${token}`));
    const error: unknown = await h.broker.withSession(request(), async () => true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialDeniedError);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    assertNoCanaries([error, h.events], [access, secret, token], "STS message credentials must be absent from broker errors and events");
  });

  it("SEC-F10 (MED): external STS Error.name must not leak credentials into errors or events", async () => {
    const h = harness();
    const upstream = new Error("exchange denied");
    upstream.name = access;
    sts.on(AssumeRoleCommand).rejects(upstream);
    const error: unknown = await h.broker.withSession(request(), async () => true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialDeniedError);
    assertNoCanaries([error, h.events], [access], "broker must scrub external error names as well as messages");
  });

  it("characterizes callback errors: session revocation does not sanitize trusted activity errors", async () => {
    const h = harness();
    let held: AwsSession | undefined;
    const thrown = new Error(`unexpected ${secret}`);
    const error: unknown = await h.broker.withAwsSession(request(), async (s) => { held = s; throw thrown; }).catch((e: unknown) => e);
    expect(error).toBe(thrown);
    expect(deepScanForCanaries(error, [secret]).length).toBeGreaterThan(0);
    assertNoCanaries(h.events, canaries, "callback error is not copied into broker events");
    expect(() => held!.childProcessEnv()).toThrow();
  });
});

// Exact ratchet: heuristic coverage, not a promise to recognize arbitrary secrets.
const KNOWN_GAPS: CoverageMap = {
  "free text": ["github-token", "hex-key", "password", "slack-token"],
  "json string": ["github-token", "hex-key", "password", "slack-token"],
  "base64": ["aws-access-key-id", "aws-secret-access-key", "github-token", "hex-key", "password", "slack-token", "zenith-agent-token"],
};
it("credential redaction coverage ratchet across plaintext and encoded positions", async () => {
  const coverage = await measureCoverage({
    contexts: {
      "free text": { build: (s) => `failed with ${s} end` },
      "secret assignment": { build: (s) => `SecretAccessKey=${s}` },
      "bearer header": { build: (s) => `Authorization: Bearer ${s}` , shapes: ["password", "hex-key", "aws-secret-access-key", "zenith-agent-token"] },
      "json string": { build: (s) => JSON.stringify({ message: s }) },
      "base64": { build: (s) => Buffer.from(s).toString("base64") },
    },
    redact: (value) => redactCredentials(String(value)),
  });
  if (process.env.ZENITH_SEC_PRINT_COVERAGE === "1") console.log(`\n=== credential redactCredentials() ===\n${coverage.table()}\nKNOWN_GAPS_JSON<credentials>${JSON.stringify(coverage.leaks)}`);
  expectCoverage(coverage.leaks, KNOWN_GAPS, "credential redactCredentials()");
});
