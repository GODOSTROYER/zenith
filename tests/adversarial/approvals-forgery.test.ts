/**
 * Threat class: stale, forged and replayed approvals, forged execution grants and tampered semantics digests (PROD-OPS-08).
 *
 * Attacker model: a requester, an agent holding an integration credential, the Navigator, a workspace member of another
 * tenant, or someone who captured a valid grant or approval. Goal: get a gated operation executed without the exact
 * human review the policy demands, or execute something other than what was reviewed.
 *
 * Driven only through the public capability broker (propose, approve, reject, revokeApproval, beginExecution,
 * completeExecution), the exported grant verifier and the exported semantics digest functions. The harness used for
 * setup is the shared two-workspace capability harness; every attack runs on the in-memory store AND the real PGlite
 * platform store.
 */
import { createHmac, generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCapabilityGrant, type PublicJwk } from "@/lib/credentials";
import { SEMANTIC_COMPONENTS, computeExecutableSemantics, diffSemantics, readExecutableSemantics, type ExecutableSemanticsInputs } from "@/lib/execution/semantics/digest";
import { STORE_KINDS, allowDecision, approveAs, closeSharedPgliteAfterAll, integrationOf, makeHarness, navigator, proposeOk, requestFor, requireApproval, scriptedEngine, sessionFor, systemPrincipal, user, type Harness } from "../capabilities/support";

closeSharedPgliteAfterAll();

const prodRestart = (h: Harness, who = "bob") => proposeOk(h, requestFor(h, "service.restart", "prod"), user(who));
const detail = (h: Harness, id: string) => h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: id, principal: user("bob") });
const begin = (h: Harness, operationId: string, extra: Record<string, unknown> = {}) =>
  h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId, holder: "worker:1", audience: "worker", ...extra });
const b64 = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const settled = async <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string | undefined }> => {
  try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, code: (error as { code?: string }).code }; }
};

describe.each(STORE_KINDS)("approval authority matrix [%s]", (kind) => {
  it("no non-human principal can approve, reject or revoke, and nothing is recorded", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    const actors: [string, ReturnType<typeof user>, ReturnType<typeof sessionFor> | null][] = [
      ["integration read-write", integrationOf(h, "intRW", "dave"), sessionFor("dave")],
      ["integration read-only", integrationOf(h, "intRO", "erin"), sessionFor("erin")],
      ["integration with its own id as session", integrationOf(h, "intRW", "dave"), sessionFor(h.ids.intRW)],
      ["navigator acting for an admin", navigator("alice"), sessionFor("alice")],
      ["navigator alone", navigator(), sessionFor("navigator")],
      ["user wearing onBehalfOf", { ...user("dave"), onBehalfOf: "alice" }, sessionFor("dave")],
      ["user wearing an integrationId", { ...user("dave"), integrationId: h.ids.intRW } as ReturnType<typeof user>, sessionFor("dave")],
      ["system", systemPrincipal(), sessionFor("reconciler")],
      ["human with a session for someone else", user("dave"), sessionFor("alice")],
      ["human with no session", user("dave"), null],
      ["human with a bearer session", user("dave"), { method: "bearer", subject: "dave", verifiedAtMs: 0 } as never],
    ];
    const outcomes: string[] = [];
    for (const [label, approver, session] of actors) {
      for (const action of ["approve", "reject"] as const) {
        const result = await settled(h.broker[action]({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver, session: session as never }));
        if (result.ok) outcomes.push(`${label} ${action} SUCCEEDED`);
      }
      const revoke = await settled(h.broker.revokeApproval({ workspaceId: h.ids.wsA, operationId: op.id, actor: approver, session: session as never }));
      if (revoke.ok) outcomes.push(`${label} revokeApproval SUCCEEDED`);
    }
    expect(outcomes).toEqual([]);
    const after = await detail(h, op.id);
    expect(after.operation.status).toBe("awaiting_approval");
    expect(after.approvals).toHaveLength(0);
  });

  it("a member of another tenant cannot approve by naming either workspace", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    for (const workspaceId of [h.ids.wsA, h.ids.wsB]) {
      const result = await settled(h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.digest, approver: user("mallory"), session: sessionFor("mallory") }));
      expect(result.ok, `mallory naming ${workspaceId}`).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_found");
    }
    expect((await detail(h, op.id)).operation.status).toBe("awaiting_approval");
  });

  it("forged and mutated digests never approve (every mutation of the real digest, plus another operation's)", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    const other = await proposeOk(h, requestFor(h, "service.restart", "prod", { input: { other: true } }), user("bob"));
    const real = op.digest;
    const flip = (at: number) => real.slice(0, at) + (real[at] === "0" ? "1" : "0") + real.slice(at + 1);
    const forged = [
      ...[0, 1, 17, 31, 62, 63].map(flip), real.toUpperCase(), real.slice(0, 63), `${real}0`, ` ${real}`, `${real}\n`, "", "0".repeat(64),
      other.digest, real.split("").reverse().join(""), `${real.slice(0, 32)}${real.slice(0, 32)}`,
    ].filter((d) => d !== real);
    const accepted: string[] = [];
    for (const proposalDigest of forged) {
      const result = await settled(h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest, approver: user("dave"), session: sessionFor("dave") }));
      if (result.ok) accepted.push(proposalDigest);
    }
    expect(accepted).toEqual([]);
    expect((await detail(h, op.id)).approvals).toHaveLength(0);
    // the control: the real digest still works afterwards, so the refusals above were about the digest and nothing else
    expect((await approveAs(h, op.operation, "dave")).operation.status).toBe("approved");
  });

  it("an approval is not a transferable ticket: it cannot be replayed on a sibling operation or a second time", async () => {
    const h = await makeHarness({ kind });
    const a = await prodRestart(h);
    const b = await proposeOk(h, requestFor(h, "service.restart", "prod", { input: { sibling: true } }), user("bob"));
    await approveAs(h, a.operation, "dave");
    expect((await settled(approveAs(h, a.operation, "dave"))).ok).toBe(false);
    expect((await settled(begin(h, b.id))).ok).toBe(false);
    expect((await detail(h, b.id)).operation.status).toBe("awaiting_approval");
  });
});

describe.each(STORE_KINDS)("stale approvals [%s]", (kind) => {
  it("an executed approval cannot be executed again (single use)", async () => {
    const h = await makeHarness({ kind });
    const op = await prodRestart(h);
    await approveAs(h, op.operation, "dave");
    await begin(h, op.id);
    for (let i = 0; i < 3; i++) expect((await settled(begin(h, op.id))).ok, `replay ${i}`).toBe(false);
    await h.broker.completeExecution({ workspaceId: h.ids.wsA, operationId: op.id, outcome: "succeeded" });
    expect((await settled(begin(h, op.id))).ok).toBe(false);
  });

  it("lapsed approvals and operations cannot start", async () => {
    const h = await makeHarness({ kind });
    const lapsed = await prodRestart(h);
    await approveAs(h, lapsed.operation, "dave");
    await h.expireApprovals(lapsed.id);
    expect((await settled(begin(h, lapsed.id))).ok).toBe(false);
    const expired = await prodRestart(h);
    await approveAs(h, expired.operation, "dave");
    await h.expireOperation(expired.id);
    expect((await settled(begin(h, expired.id))).ok).toBe(false);
    expect((await detail(h, expired.id)).operation.status).not.toBe("running");
  });

  it("a policy that tightens after approval is applied at dispatch (deny, or more approvers than were given)", async () => {
    for (const tighten of [() => allowDecisionDeny(), () => requireApproval(2, "admin", true)]) {
      const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1)) });
      const op = await prodRestart(h);
      await approveAs(h, op.operation, "dave");
      h.setEngine(scriptedEngine("v2", tighten));
      const result = await settled(begin(h, op.id));
      expect(result.ok).toBe(false);
      expect((await detail(h, op.id)).operation.status).not.toBe("running");
    }
  });

  it("an approver demoted or removed after approving no longer counts at dispatch", async () => {
    for (const change of ["viewer", "removed"] as const) {
      const h = await makeHarness({ kind });
      const op = await prodRestart(h);
      await approveAs(h, op.operation, "dave");
      if (change === "removed") h.world.members.delete(`${h.ids.wsA}|dave`);
      else h.world.members.set(`${h.ids.wsA}|dave`, "viewer");
      expect((await settled(begin(h, op.id))).ok, change).toBe(false);
    }
  });

  it("a requester who loses access cannot have their queued operation executed", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => allowDecision()) });
    const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    h.world.members.delete(`${h.ids.wsA}|bob`);
    expect((await settled(begin(h, op.id))).ok).toBe(false);
  });
});

/** A deny decision shaped like the scripted ones. */
function allowDecisionDeny() {
  return { outcome: "deny" as const, reasons: [{ code: "scripted_deny", message: "scripted", rule: "test" }] };
}

describe.each(STORE_KINDS)("forged execution grants [%s]", (kind) => {
  async function realGrant(h: Harness) {
    const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    const begun = await begin(h, op.id);
    const jwk = (await h.publicJwk()) as unknown as PublicJwk;
    return { op, grant: begun.grant, jwk, parts: begun.grant.split(".") as [string, string, string] };
  }
  const verify = (h: Harness, grant: string, jwk: PublicJwk, extra: Partial<Parameters<typeof verifyCapabilityGrant>[1]> = {}) =>
    verifyCapabilityGrant(grant, { audience: "worker", keys: [jwk], now: h.clock.now(), ...extra });

  it("the control grant verifies, so each refusal below is about the forgery", async () => {
    const h = await makeHarness({ kind });
    const { grant, jwk, op } = await realGrant(h);
    await expect(verify(h, grant, jwk, { expectedOperationId: op.id, expectedCapability: "service.restart" })).resolves.toMatchObject({ op: op.id });
  });

  it("refuses payload tampering that keeps the signature (capability, operation, workspace, lifetime, audience)", async () => {
    const h = await makeHarness({ kind });
    const { parts, jwk } = await realGrant(h);
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const mutations: Record<string, unknown>[] = [
      { cap: "infrastructure.destroy" }, { op: "op_forged" }, { ws: h.ids.wsB }, { exp: Number(payload.exp) + 86_400 }, { aud: "runner:evil" },
      { sub: "alice" }, { env: h.ids.envAProd }, { digest: "0".repeat(64) }, { jti: "grt_forged" },
    ];
    const accepted: string[] = [];
    for (const m of mutations) {
      const forged = `${parts[0]}.${b64({ ...payload, ...m })}.${parts[2]}`;
      if ((await settled(verify(h, forged, jwk))).ok) accepted.push(Object.keys(m)[0]!);
    }
    expect(accepted).toEqual([]);
  });

  it("refuses algorithm confusion: none, HS256 keyed with the public key, and an attacker key under the real kid", async () => {
    const h = await makeHarness({ kind });
    const { parts, jwk } = await realGrant(h);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    const body = parts[1];
    const none = `${b64({ ...header, alg: "none" })}.${body}.`;
    const publicKeyBytes = Buffer.from(String((jwk as unknown as { x: string }).x), "base64url");
    const hsHeader = b64({ ...header, alg: "HS256" });
    const hs = `${hsHeader}.${body}.${createHmac("sha256", publicKeyBytes).update(`${hsHeader}.${body}`).digest("base64url")}`;
    const attacker = generateKeyPairSync("ed25519");
    const signed = `${parts[0]}.${body}`;
    const wrongKey = `${signed}.${edSign(null, Buffer.from(signed), attacker.privateKey).toString("base64url")}`;
    const embedHeader = b64({ ...header, jwk: attacker.publicKey.export({ format: "jwk" }), kid: "attacker" });
    const embedSigned = `${embedHeader}.${body}`;
    const embedded = `${embedSigned}.${edSign(null, Buffer.from(embedSigned), attacker.privateKey).toString("base64url")}`;
    const critHeader = b64({ ...header, crit: ["exp"], x5u: "https://attacker.example/keys" });
    const crit = `${critHeader}.${body}.${parts[2]}`;
    for (const [label, forged] of [["alg none", none], ["HS256 with the public key as secret", hs], ["attacker signature under the real kid", wrongKey], ["embedded attacker jwk", embedded], ["crit and x5u headers", crit]] as const) {
      expect((await settled(verify(h, forged, jwk))).ok, label).toBe(false);
    }
    expect((await settled(verify(h, `${signed}.${edSign(null, Buffer.from(signed), attacker.privateKey).toString("base64url")}`, jwk))).ok).toBe(false);
  });

  it("refuses audience, operation, capability and time confusion", async () => {
    const h = await makeHarness({ kind });
    const { grant, jwk, op } = await realGrant(h);
    expect((await settled(verify(h, grant, jwk, { audience: "runner:other" }))).ok).toBe(false);
    expect((await settled(verify(h, grant, jwk, { audience: "" }))).ok).toBe(false);
    expect((await settled(verify(h, grant, jwk, { expectedOperationId: "op_other" }))).ok).toBe(false);
    expect((await settled(verify(h, grant, jwk, { expectedCapability: "infrastructure.destroy" }))).ok).toBe(false);
    expect((await settled(verify(h, grant, jwk, { now: new Date(h.clock.now().getTime() + 2 * 3_600_000) }))).ok).toBe(false);
    expect((await settled(verify(h, grant, jwk, { now: new Date(h.clock.now().getTime() - 3_600_000) }))).ok).toBe(false);
    expect((await settled(verify(h, grant, [] as never))).ok).toBe(false);
    expect(op.id).toBeTruthy();
  });

  it("refuses malformed compact tokens of every shape", async () => {
    const h = await makeHarness({ kind });
    const { grant, jwk, parts } = await realGrant(h);
    for (const bad of ["", "a", "a.b", "a.b.c.d", `${grant}.extra`, `${parts[0]}..${parts[2]}`, `..`, "x".repeat(20_000), `${parts[0]}.${parts[1]}`, grant.replace(/\./g, "/")]) {
      expect((await settled(verify(h, bad, jwk))).ok, bad.slice(0, 20)).toBe(false);
    }
  });

  it("a grant is bound to its workspace and audience in the store: other tenants and audiences cannot consume it", async () => {
    const h = await makeHarness({ kind });
    const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    const { claims } = await begin(h, op.id, { audience: "runner:r1" });
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsB, jti: claims.jti, audience: "runner:r1" })).toBe(false);
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: claims.jti, audience: "runner:r2" })).toBe(false);
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: claims.jti, audience: "runner:r1" })).toBe(true);
    for (let i = 0; i < 3; i++) expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: claims.jti, audience: "runner:r1" })).toBe(false);
  });
});

/* ------------------------- executable semantics digest ------------------------- */

const hex = (c: string): string => c.repeat(64);
function inputs(over: Partial<ExecutableSemanticsInputs> = {}): ExecutableSemanticsInputs {
  return {
    revision: { id: "rev_1", deployedRevisionId: null, manifestDigest: hex("1") },
    recipe: { executableSourceDigest: null, sources: [] },
    scripts: { release: null },
    migrations: null,
    targets: { graphDigest: hex("a"), provider: "aws", region: "us-east-1", environmentId: "env", connectionId: "conn", connectionConfigDigest: hex("b") },
    configuration: { configDigest: hex("c") },
    providerLocks: { lockDigest: hex("d"), tofuVersion: "1.12.5" },
    backend: { kind: "s3", configDigest: hex("e") },
    savedPlan: { planDigest: hex("f") },
    provenance: { pipelines: [] },
    ownership: { transfers: [] },
    runbook: null,
    decommission: { adoptions: [] },
    ...over,
  };
}
const ALTERNATES: Record<string, Partial<ExecutableSemanticsInputs>> = {
  revision: { revision: { id: "rev_2", deployedRevisionId: null, manifestDigest: hex("1") } },
  recipe: { recipe: { executableSourceDigest: hex("9"), sources: [] } },
  targets: { targets: { graphDigest: hex("a"), provider: "aws", region: "eu-west-1", environmentId: "env", connectionId: "conn", connectionConfigDigest: hex("b") } },
  configuration: { configuration: { configDigest: hex("0") } },
  providerLocks: { providerLocks: { lockDigest: hex("d"), tofuVersion: "1.12.6" } },
  backend: { backend: { kind: "s3", configDigest: hex("0") } },
  savedPlan: { savedPlan: { planDigest: hex("0") } },
};

describe("executable semantics digest", () => {
  const approved = computeExecutableSemantics(inputs());

  it("every component that can change what runs changes the digest and is named by the diff", () => {
    expect(SEMANTIC_COMPONENTS.length).toBeGreaterThanOrEqual(13);
    for (const [name, over] of Object.entries(ALTERNATES)) {
      const current = computeExecutableSemantics(inputs(over));
      expect(current.digest, name).not.toBe(approved.digest);
      expect(diffSemantics(approved, current), name).toEqual([name]);
    }
  });

  it("is deterministic and insensitive to nothing it covers", () => {
    expect(computeExecutableSemantics(inputs()).digest).toBe(approved.digest);
  });

  it("refuses a stored document whose components were altered after the digest was fixed, or whose digest was swapped", () => {
    const doc = JSON.parse(JSON.stringify(approved)) as { digest: string; components: Record<string, unknown> };
    expect(readExecutableSemantics(doc)).toBeDefined();
    const altered = JSON.parse(JSON.stringify(doc)) as typeof doc;
    altered.components.configuration = { configDigest: hex("0") };
    expect(readExecutableSemantics(altered)).toBeUndefined();
    const swapped = { ...doc, digest: computeExecutableSemantics(inputs(ALTERNATES.configuration)).digest };
    expect(readExecutableSemantics(swapped)).toBeUndefined();
    for (const bad of [null, undefined, 1, "x", [], {}, { digest: doc.digest }, { components: doc.components }, { ...doc, digest: doc.digest.toUpperCase() }, { ...doc, format: "zenith.executable-semantics.v0" }]) {
      expect(readExecutableSemantics(bad as never), JSON.stringify(bad)?.slice(0, 40)).toBeUndefined();
    }
  });
});
