/**
 * PROD-MAN-03 custom domains against the real platform schema (PGlite lane here; set ZENITH_TEST_PLATFORM_PG_URL to add real
 * PostgreSQL): claim, DNS proof over a real local DNS server, renewal, lapse, revoke, global uniqueness of a verified hostname,
 * tenant scoping, and the durable `managed-serving` critical job.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { ControlStoreError } from "@/lib/controlplane/db";
import {
  ManagedDomainError, claimCustomDomain, listCustomDomains, renewalPass, revokeCustomDomain, servedCustomHostnames, verifyCustomDomain, type DomainServiceDeps,
} from "@/lib/managed-serving/domain-service";
import { managedServingPass } from "@/lib/managed-serving/job";
import { loadServingInputs } from "@/lib/managed-serving/platform-store";
import { GRACE_MS, MAX_DOMAINS_PER_ENVIRONMENT, PENDING_TTL_MS, PROOF_TTL_MS, RENEWAL_WINDOW_MS, systemDomainDns } from "@/lib/managed-serving/domains";
import { STORE_KINDS, closeSharedPgliteAfterAll, sharedDatabase } from "../capabilities/support";
import { startLocalDns, type LocalDns } from "./_support/dns";

closeSharedPgliteAfterAll();

const BASE = "apps.example.com";
const T0 = new Date("2026-10-07T12:00:00.000Z");

describe.each(STORE_KINDS.filter((k) => k !== "memory"))("custom domains [%s]", (kind) => {
  let dns: LocalDns;
  let now = T0;
  // fresh ids per test: the database is shared across the file and renewal is a cross-workspace pass, so tests assert on their own rows
  let A = "";
  let B = "";
  let ENV_A = "";
  let ENV_A2 = "";
  let ENV_B = "";
  const host = (s: string): string => `${s}-${randomUUID().slice(0, 8)}.customer.com`;

  async function deps(): Promise<DomainServiceDeps> {
    return { sql: await sharedDatabase(kind), dns: systemDomainDns({ servers: [dns.server], timeoutMs: 250 }), baseDomain: BASE, clock: () => now };
  }
  const publish = (hostname: string, value: string): void => dns.set(`_zenith-challenge.${hostname}`, { kind: "txt", values: [[value]] });

  beforeAll(async () => { dns = await startLocalDns(); });
  afterAll(async () => { await dns.close(); });
  beforeEach(() => {
    now = T0;
    dns.clear();
    A = `ws_${randomUUID()}`; B = `ws_${randomUUID()}`; ENV_A = `env_${randomUUID()}`; ENV_A2 = `env_${randomUUID()}`; ENV_B = `env_${randomUUID()}`;
  });

  async function provenDomain(workspaceId = A, environmentId = ENV_A, name = host("shop")): Promise<{ id: string; hostname: string }> {
    const d = await deps();
    const claim = await claimCustomDomain(d, { workspaceId, environmentId, hostname: name, requestedBy: "alice" });
    publish(name, claim.challenge!.recordValue);
    const verified = await verifyCustomDomain(d, { workspaceId, id: claim.domain.id });
    expect(verified.domain.status).toBe("verified");
    return { id: claim.domain.id, hostname: name };
  }

  it("claims a hostname, shows the challenge once, and serves nothing until it is proven", async () => {
    const d = await deps();
    const name = host("shop");
    const claim = await claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: name, requestedBy: "alice" });
    expect(claim).toMatchObject({ outcome: "created", domain: { hostname: name, status: "pending", state: "pending", challengeRecord: `_zenith-challenge.${name}` } });
    expect(claim.challenge).toMatchObject({ recordName: `_zenith-challenge.${name}`, recordType: "TXT" });
    expect(claim.challenge!.recordValue).toMatch(/^zenith-domain-verification=/);
    expect(await servedCustomHostnames(d, A, ENV_A)).toEqual([]);

    // the challenge value is not recoverable from anything the store returns
    const listed = JSON.stringify(await listCustomDomains(d, { workspaceId: A, environmentId: ENV_A }));
    expect(listed).not.toContain(claim.challenge!.recordValue);
    expect(listed).not.toContain(claim.challenge!.recordValue.split("=")[1]);
    const raw = await (await sharedDatabase(kind)).query<{ challenge_hash: string }>("select challenge_hash from platform.managed_domains where id = $1", [claim.domain.id]);
    expect(raw[0].challenge_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw[0].challenge_hash).not.toContain(claim.challenge!.recordValue.split("=")[1]);
  });

  it("verifies from real DNS and then serves the host; a wrong record does not", async () => {
    const d = await deps();
    const name = host("shop");
    const claim = await claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: name, requestedBy: "alice" });

    const missing = await verifyCustomDomain(d, { workspaceId: A, id: claim.domain.id });
    expect(missing.verification.outcome).toBe("not_found");
    expect(missing.domain.status).toBe("pending");

    publish(name, "zenith-domain-verification=wrong");
    expect((await verifyCustomDomain(d, { workspaceId: A, id: claim.domain.id })).verification.outcome).toBe("mismatch");
    expect(await servedCustomHostnames(d, A, ENV_A)).toEqual([]);

    publish(name, claim.challenge!.recordValue);
    const ok = await verifyCustomDomain(d, { workspaceId: A, id: claim.domain.id });
    expect(ok).toMatchObject({ change: "verified", domain: { status: "verified", state: "serving" } });
    expect(Date.parse(ok.domain.expiresAt!) - now.getTime()).toBe(PROOF_TTL_MS);
    expect(await servedCustomHostnames(d, A, ENV_A)).toEqual([name]);
  });

  it("re-claiming a pending hostname re-issues the challenge and the old value stops working", async () => {
    const d = await deps();
    const name = host("shop");
    const first = await claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: name, requestedBy: "alice" });
    const second = await claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: name, requestedBy: "alice" });
    expect(second).toMatchObject({ outcome: "reissued", domain: { id: first.domain.id } });
    expect(second.challenge!.recordValue).not.toBe(first.challenge!.recordValue);
    publish(name, first.challenge!.recordValue);
    expect((await verifyCustomDomain(d, { workspaceId: A, id: first.domain.id })).verification.outcome).toBe("mismatch");
    publish(name, second.challenge!.recordValue);
    expect((await verifyCustomDomain(d, { workspaceId: A, id: first.domain.id })).domain.status).toBe("verified");
    // claiming an already verified hostname issues no new challenge
    expect(await claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: name, requestedBy: "alice" })).toMatchObject({ outcome: "already_verified" });
  });

  it("a hostname verified by one workspace is not available to another, and says nothing more", async () => {
    const d = await deps();
    const { hostname } = await provenDomain(A, ENV_A);
    const refusal = await claimCustomDomain(d, { workspaceId: B, environmentId: ENV_B, hostname, requestedBy: "mallory" }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ManagedDomainError);
    expect((refusal as ManagedDomainError).code).toBe("unavailable");
    expect((refusal as ManagedDomainError).message).not.toMatch(/workspace|ws_|owned|belongs/i);
    // the same environment of the same workspace can see it; B sees none of A's claims
    expect(await listCustomDomains(d, { workspaceId: B, environmentId: ENV_A })).toEqual([]);
  });

  it("two workspaces that can both publish a challenge still cannot both verify one hostname", async () => {
    const d = await deps();
    const name = host("race");
    const a = await claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: name, requestedBy: "alice" });
    const b = await claimCustomDomain(d, { workspaceId: B, environmentId: ENV_B, hostname: name, requestedBy: "bob" });
    dns.set(`_zenith-challenge.${name}`, { kind: "txt", values: [[a.challenge!.recordValue], [b.challenge!.recordValue]] });
    expect((await verifyCustomDomain(d, { workspaceId: A, id: a.domain.id })).domain.status).toBe("verified");
    const second = await verifyCustomDomain(d, { workspaceId: B, id: b.domain.id }).catch((e: unknown) => e);
    expect((second as ManagedDomainError).code).toBe("unavailable");
    expect((await repos.managedServing.getDomain(await sharedDatabase(kind), B, b.domain.id))!.status).toBe("pending");
  });

  it("refuses hostnames the platform owns, malformed hostnames and over-limit claims", async () => {
    const d = await deps();
    await expect(claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: `web.production.acme.${BASE}`, requestedBy: "alice" })).rejects.toMatchObject({ code: "managed_suffix" });
    await expect(claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: "*.customer.com", requestedBy: "alice" })).rejects.toMatchObject({ code: "invalid_hostname" });
    const env = `env_${randomUUID()}`;
    for (let i = 0; i < MAX_DOMAINS_PER_ENVIRONMENT; i++) await claimCustomDomain(d, { workspaceId: A, environmentId: env, hostname: host(`n${i}`), requestedBy: "alice" });
    await expect(claimCustomDomain(d, { workspaceId: A, environmentId: env, hostname: host("extra"), requestedBy: "alice" })).rejects.toMatchObject({ code: "limit_reached" });
    // stale pending claims stop counting
    now = new Date(T0.getTime() + PENDING_TTL_MS + 1000);
    await expect(claimCustomDomain({ ...d, clock: () => now }, { workspaceId: A, environmentId: env, hostname: host("later"), requestedBy: "alice" })).resolves.toMatchObject({ outcome: "created" });
  });

  it("an expired challenge must be re-issued, not verified", async () => {
    const d = await deps();
    const name = host("old");
    const claim = await claimCustomDomain(d, { workspaceId: A, environmentId: ENV_A, hostname: name, requestedBy: "alice" });
    publish(name, claim.challenge!.recordValue);
    now = new Date(T0.getTime() + PENDING_TTL_MS + 1000);
    await expect(verifyCustomDomain({ ...d, clock: () => now }, { workspaceId: A, id: claim.domain.id })).rejects.toMatchObject({ code: "challenge_expired" });
  });

  it("renewal re-checks the same record inside the window and extends the proof", async () => {
    const d = await deps();
    const { id, hostname } = await provenDomain();
    // nothing of this claim is due long before the window opens: the pass leaves its proof untouched
    const before = (await repos.managedServing.getDomain(await sharedDatabase(kind), A, id))!;
    await renewalPass(d);
    expect((await repos.managedServing.getDomain(await sharedDatabase(kind), A, id))!.expiresAt).toBe(before.expiresAt);
    now = new Date(T0.getTime() + PROOF_TTL_MS - RENEWAL_WINDOW_MS + 60_000);
    const pass = await renewalPass({ ...d, clock: () => now });
    expect(pass.renewed).toBeGreaterThanOrEqual(1);
    const after = (await repos.managedServing.getDomain(await sharedDatabase(kind), A, id))!;
    expect(Date.parse(after.expiresAt!)).toBe(now.getTime() + PROOF_TTL_MS);
    expect(after.lastOutcome).toBe("verified");
    expect(dns.queries.filter((q) => q === `_zenith-challenge.${hostname}`).length).toBeGreaterThanOrEqual(2);
  });

  it("an unrenewable proof keeps serving through the grace period, then lapses and stops being served", async () => {
    const d = await deps();
    const { id, hostname } = await provenDomain();
    dns.set(`_zenith-challenge.${hostname}`, { kind: "nxdomain" });
    const clock = (ms: number) => ({ ...d, clock: () => new Date(T0.getTime() + ms) });

    const rowNow = async () => (await repos.managedServing.getDomain(await sharedDatabase(kind), A, id))!;

    expect((await renewalPass(clock(PROOF_TTL_MS - RENEWAL_WINDOW_MS + 1000))).renewed).toBe(0);
    expect(await rowNow()).toMatchObject({ status: "verified", lastOutcome: "not_found", failureCount: 1 });
    expect(await servedCustomHostnames(clock(PROOF_TTL_MS - 1000), A, ENV_A)).toContain(hostname);

    await renewalPass(clock(PROOF_TTL_MS + 1000));
    expect(await rowNow()).toMatchObject({ status: "verified", failureCount: 2 });
    expect(await servedCustomHostnames(clock(PROOF_TTL_MS + 1000), A, ENV_A)).toContain(hostname);

    const lapsed = await renewalPass(clock(PROOF_TTL_MS + GRACE_MS + 1000));
    expect(lapsed.lapsed).toBeGreaterThanOrEqual(1);
    const row = await rowNow();
    expect(row).toMatchObject({ status: "lapsed" });
    expect(row.lapsedAt).not.toBeNull();
    expect(await servedCustomHostnames(clock(PROOF_TTL_MS + GRACE_MS + 1000), A, ENV_A)).not.toContain(hostname);
    const inputs = await loadServingInputs(await sharedDatabase(kind), { workspaceId: A, environmentId: ENV_A }, () => new Date(T0.getTime() + PROOF_TTL_MS + GRACE_MS + 1000));
    expect(inputs.retiredDomains).toContain(hostname);
    expect(inputs.verifiedDomains).not.toContain(hostname);
  });

  it("a stopped renewal job can never keep a host served past proof plus grace (the read filters by time, not status)", async () => {
    const d = await deps();
    const { hostname } = await provenDomain();
    const late = { ...d, clock: () => new Date(T0.getTime() + PROOF_TTL_MS + GRACE_MS + 5000) };
    expect(await servedCustomHostnames(late, A, ENV_A)).not.toContain(hostname);
  });

  it("a DNS outage is uncertain: it never lapses a claim inside its grace period", async () => {
    const d = await deps();
    const { id, hostname } = await provenDomain();
    dns.set(`_zenith-challenge.${hostname}`, { kind: "servfail" });
    const during = { ...d, clock: () => new Date(T0.getTime() + PROOF_TTL_MS + 1000) };
    const pass = await renewalPass(during);
    expect(pass.uncertain).toBeGreaterThanOrEqual(1);
    expect(await repos.managedServing.getDomain(await sharedDatabase(kind), A, id)).toMatchObject({ status: "verified", lastOutcome: "uncertain" });
  });

  it("revocation is terminal, tenant scoped, and frees the hostname for a new claim", async () => {
    const d = await deps();
    const { id, hostname } = await provenDomain();
    await expect(revokeCustomDomain(d, { workspaceId: B, id, by: "mallory" })).rejects.toMatchObject({ code: "not_found" });
    expect((await repos.managedServing.getDomain(await sharedDatabase(kind), A, id))!.status).toBe("verified");
    const revoked = await revokeCustomDomain(d, { workspaceId: A, id, by: "alice" });
    expect(revoked).toMatchObject({ status: "revoked", state: "revoked" });
    await expect(verifyCustomDomain(d, { workspaceId: A, id })).rejects.toMatchObject({ code: "revoked" });
    await expect(revokeCustomDomain(d, { workspaceId: A, id, by: "alice" })).rejects.toMatchObject({ code: "not_found" });
    expect(await servedCustomHostnames(d, A, ENV_A)).not.toContain(hostname);
    // another workspace may now claim it
    await expect(claimCustomDomain(d, { workspaceId: B, environmentId: ENV_B, hostname, requestedBy: "bob" })).resolves.toMatchObject({ outcome: "created" });
  });

  it("scopes every read and write to the workspace", async () => {
    const d = await deps();
    const { id } = await provenDomain();
    const sql = await sharedDatabase(kind);
    expect(await repos.managedServing.getDomain(sql, B, id)).toBeNull();
    expect(await repos.managedServing.getDomainForVerification(sql, B, id)).toBeNull();
    expect(await repos.managedServing.listDomains(sql, B, ENV_A)).toEqual([]);
    expect(await repos.managedServing.verifiedHostnames(sql, B, ENV_A, { now, graceMs: GRACE_MS })).toEqual([]);
    expect(await repos.managedServing.revokeDomain(sql, B, id, "mallory", now)).toBeNull();
    expect(await repos.managedServing.applyDomainTransition(sql, B, id, { expect: "verified", status: "lapsed", outcome: "not_found", checkedAt: now, failureCount: 1, lapsedAt: now })).toBeNull();
    // the same hostname in another environment of the same workspace is a separate live claim only when not verified elsewhere
    const other = await listCustomDomains(d, { workspaceId: A, environmentId: ENV_A2 });
    expect(other).toEqual([]);
  });

  it("scopes scoped-credential records to the workspace, keeps one active key per store and supersedes atomically", async () => {
    const sql = await sharedDatabase(kind);
    const base = { workspaceId: A, environmentId: ENV_A, address: "object_store/media", bucket: "zenith-tenants", prefix: "tenants/a/b/media/", policyDigest: "c".repeat(64), principalName: "zenith-t-abc", secretRef: "vault:generated/e/object_store/media/storage-secret" };
    const one = await repos.managedServing.recordStorageKey(sql, { ...base, accessKeyId: "AKIAONE0001" });
    expect(one).toMatchObject({ key: { status: "active", accessKeyId: "AKIAONE0001" } });
    expect(one.superseded).toBeUndefined();
    const two = await repos.managedServing.recordStorageKey(sql, { ...base, accessKeyId: "AKIATWO0002" });
    expect(two.superseded).toMatchObject({ accessKeyId: "AKIAONE0001", status: "revoke_pending" });
    expect((await repos.managedServing.activeStorageKey(sql, A, ENV_A, base.address))!.accessKeyId).toBe("AKIATWO0002");
    // the credential itself is never a column: only the vault reference is stored
    const columns = (await sql.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'platform' and table_name = 'managed_storage_keys'")).map((c) => c.column_name);
    expect(columns).toEqual(expect.arrayContaining(["secret_ref", "access_key_id"]));
    expect(columns.some((c) => /secret_value|secret_access|password|token/.test(c))).toBe(false);

    // another workspace sees nothing and changes nothing
    expect(await repos.managedServing.activeStorageKey(sql, B, ENV_A, base.address)).toBeNull();
    expect(await repos.managedServing.listStorageKeys(sql, B, ENV_A)).toEqual([]);
    expect(await repos.managedServing.markStorageKeyRevoked(sql, B, one.key.id, now)).toBeNull();
    expect(await repos.managedServing.retireStorageKey(sql, B, ENV_A, base.address)).toBeNull();
    expect((await repos.managedServing.listStorageKeys(sql, A, ENV_A)).map((k) => k.status).sort()).toEqual(["active", "revoke_pending"]);

    // retiring and settling
    expect((await repos.managedServing.retireStorageKey(sql, A, ENV_A, base.address))!.status).toBe("revoke_pending");
    expect(await repos.managedServing.activeStorageKey(sql, A, ENV_A, base.address)).toBeNull();
    const settled = await repos.managedServing.markStorageKeyRevoked(sql, A, two.key.id, now);
    expect(settled).toMatchObject({ status: "revoked" });
    expect(settled!.revokedAt).not.toBeNull();
    // a revoked key is final
    expect(await repos.managedServing.markStorageKeyRevoked(sql, A, two.key.id, now)).toBeNull();
    // the table cannot hold a malformed prefix, digest or secret reference
    await expect(repos.managedServing.recordStorageKey(sql, { ...base, accessKeyId: "AKIABAD1", prefix: "no-trailing-slash" })).rejects.toBeDefined();
    await expect(repos.managedServing.recordStorageKey(sql, { ...base, accessKeyId: "AKIABAD2", secretRef: "plaintext-secret-value" })).rejects.toBeDefined();
    await expect(repos.managedServing.recordStorageKey(sql, { ...base, accessKeyId: "AKIABAD3", policyDigest: "short" })).rejects.toBeDefined();
  });

  it("rejects bad inputs at the store boundary", async () => {
    const sql = await sharedDatabase(kind);
    await expect(repos.managedServing.claimDomain(sql, { workspaceId: A, environmentId: ENV_A, hostname: "UPPER.customer.com", challengeHash: "a".repeat(64), requestedBy: "x", maxLive: 5, pendingTtlMs: 1000, now })).rejects.toBeInstanceOf(ControlStoreError);
    await expect(repos.managedServing.claimDomain(sql, { workspaceId: A, environmentId: ENV_A, hostname: "ok.customer.com", challengeHash: "nothex", requestedBy: "x", maxLive: 5, pendingTtlMs: 1000, now })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("the durable job renews, counts what it could not revoke, and never silently skips storage revocations", async () => {
    const sql = await sharedDatabase(kind);
    const { id } = await provenDomain();
    const early = await managedServingPass(sql, { dns: systemDomainDns({ servers: [dns.server], timeoutMs: 250 }), clock: () => new Date(T0.getTime() + PROOF_TTL_MS - RENEWAL_WINDOW_MS + 5000), baseDomain: BASE });
    expect(early.due).toBeGreaterThanOrEqual(1);
    expect(early.renewed).toBeGreaterThanOrEqual(1);
    expect(early).toHaveProperty("revocationsBlocked");
    expect((await repos.managedServing.getDomain(sql, A, id))!.lastOutcome).toBe("verified");

    // an owed revocation with no admin port is blocked and counted, not skipped
    const key = await repos.managedServing.recordStorageKey(sql, { workspaceId: A, environmentId: ENV_A, address: "resource/jobs-test", bucket: "zenith-tenants", prefix: "tenants/a/b/jobs/", policyDigest: "d".repeat(64), principalName: "zenith-t-x", accessKeyId: "AKIAEXAMPLE1", secretRef: "vault:generated/e/resource/jobs-test/storage-secret" });
    await repos.managedServing.recordStorageKey(sql, { workspaceId: A, environmentId: ENV_A, address: "resource/jobs-test", bucket: "zenith-tenants", prefix: "tenants/a/b/jobs/", policyDigest: "d".repeat(64), principalName: "zenith-t-x", accessKeyId: "AKIAEXAMPLE2", secretRef: "vault:generated/e/resource/jobs-test/storage-secret" });
    expect(key.key.status).toBe("active");
    const blocked = await managedServingPass(sql, { dns: systemDomainDns({ servers: [dns.server], timeoutMs: 250 }), clock: () => T0, baseDomain: BASE });
    expect(blocked.revocationsOwed).toBeGreaterThanOrEqual(1);
    expect(blocked.revocationsBlocked).toBe(blocked.revocationsOwed);
    expect(blocked.revoked).toBe(0);

    // with a working admin port the same pass settles them
    const deleted: string[] = [];
    const admin = { id: "fake", availability: () => ({ available: true as const }), ensurePrincipal: async () => ({ ok: true as const, value: { created: false } }), readPolicyDigest: async () => ({ ok: true as const, value: undefined }), createAccessKey: async () => ({ ok: true as const, value: { accessKeyId: "x", secretAccessKey: "y" } }), listAccessKeys: async () => ({ ok: true as const, value: [] }), deleteAccessKey: async (_n: string, id: string) => { deleted.push(id); return { ok: true as const, value: undefined }; } };
    const settled = await managedServingPass(sql, { dns: systemDomainDns({ servers: [dns.server], timeoutMs: 250 }), clock: () => T0, baseDomain: BASE, storageAdmin: admin });
    expect(settled.revoked).toBeGreaterThanOrEqual(1);
    expect(deleted).toContain("AKIAEXAMPLE1");
    expect((await repos.managedServing.listStorageKeys(sql, A, ENV_A)).find((k) => k.accessKeyId === "AKIAEXAMPLE1")!.status).toBe("revoked");
  });
});
