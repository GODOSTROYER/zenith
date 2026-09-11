/**
 * Access contract: grants, invites, deliveries, sessions and exchanges answer
 * identically on SqliteAuthority and PostgresAuthority.
 *
 * Same shape as `contract.test.ts`: one `describe.each` over the factories, an
 * app seeded raw in `beforeAll`, every id `contract-` prefixed (hex ids in the
 * run's hex namespace for the 64-char columns) and `factory.close` deleting
 * exactly this run's rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir } from "../../_fixtures";

isolatedDataDir("zenith-authority-access-");

const { nowIso } = await import("@/lib/hosted/authority");
const { contractHex, contractId, loadAuthorities, postgresContractEnabled, postgresSkipReason } =
  await import("./_factories");

const authorities = await loadAuthorities();

if (!postgresContractEnabled())
  console.warn(
    `\n[access contract] PostgreSQL row SKIPPED — set ${postgresSkipReason()} to include it.\n`
  );

const plus = (ms: number, from = Date.now()): string => nowIso(from + ms);

describe.each(authorities)("$name", (factory) => {
  let a: Awaited<ReturnType<typeof factory.open>>;

  const appId = contractId("app");
  const workspaceId = contractId("ws");
  const owner = contractId("owner");

  beforeAll(async () => {
    a = await factory.open();
    await factory.raw(
      "INSERT INTO {{h}}apps (id, workspace_id, slug, name, contract_version, schema_version, state, " +
        "state_reason, created_by, created_at, updated_at, active_release_id, active_fence, runtime) " +
        "VALUES (?, ?, ?, ?, 1, 1, 'active', NULL, ?, ?, ?, NULL, 0, 'local')",
      [appId, workspaceId, contractId("slug"), "Access contract app", owner, nowIso(), nowIso()]
    );
  });

  afterAll(async () => {
    await factory.close(a);
  });

  const grantFor = async (subject: string, role: "owner" | "editor" | "viewer" = "editor") =>
    a.tx((repos) =>
      repos.grants.insert({
        id: contractId("grant"),
        appId,
        subject,
        email: `${subject}@example.test`,
        role,
        grantedBy: owner,
      })
    );

  /* --------------------------------- grants -------------------------------- */

  describe("grants", () => {
    it("round-trips every field and answers activeFor only for the live grant", async () => {
      const subject = contractId("subj");
      const grant = await grantFor(subject, "viewer");
      expect(await a.repos.grants.get(grant.id)).toEqual(grant);
      expect(grant).toMatchObject({ state: "active", role: "viewer", updatedAt: grant.createdAt });
      expect(grant.revokedAt).toBeUndefined();
      expect(await a.repos.grants.activeFor(appId, subject)).toEqual(grant);
      expect(await a.repos.grants.activeFor(appId, contractId("nobody"))).toBeNull();
    });

    it("keeps one live grant per (app, subject) — a second is refused by the index", async () => {
      const subject = contractId("dup");
      await grantFor(subject);
      await expect(grantFor(subject)).rejects.toBeDefined();
      // A revoked one is history, so a new live grant is allowed afterwards.
      const first = await a.repos.grants.activeFor(appId, subject);
      await a.tx((repos) => repos.grants.revoke(first!.id, owner, "test"));
      const again = await grantFor(subject);
      expect(await a.repos.grants.activeFor(appId, subject)).toEqual(again);
    });

    it("revoke answers the row as it now stands, including an already-revoked one", async () => {
      const grant = await grantFor(contractId("rev"));
      const at = nowIso();
      const revoked = await a.tx((repos) => repos.grants.revoke(grant.id, owner, "left", at));
      expect(revoked).toMatchObject({
        state: "revoked",
        revokedAt: at,
        revokedBy: owner,
        revokedReason: "left",
        updatedAt: at,
      });
      const twice = await a.tx((repos) => repos.grants.revoke(grant.id, owner, "again"));
      expect(twice).toEqual(revoked);
      expect(await a.tx((repos) => repos.grants.revoke(contractId("missing"), owner, "x"))).toBeNull();
    });

    it("setRole moves only an active grant; markNeedsReapproval moves every active one on the apps", async () => {
      const live = await grantFor(contractId("role"));
      const gone = await grantFor(contractId("role-gone"));
      await a.tx((repos) => repos.grants.revoke(gone.id, owner, "x"));
      expect(await a.tx((repos) => repos.grants.setRole(live.id, "owner"))).toBe(true);
      expect(await a.tx((repos) => repos.grants.setRole(gone.id, "owner"))).toBe(false);
      expect((await a.repos.grants.get(live.id))!.role).toBe("owner");

      expect(await a.tx((repos) => repos.grants.markNeedsReapproval([]))).toBe(0);
      const before = (await a.repos.grants.listByApp(appId, { activeOnly: true })).length;
      expect(before).toBeGreaterThan(0);
      expect(await a.tx((repos) => repos.grants.markNeedsReapproval([appId]))).toBe(before);
      expect(await a.repos.grants.listByApp(appId, { activeOnly: true })).toEqual([]);
      expect((await a.repos.grants.get(live.id))!.state).toBe("needs_reapproval");
    });

    it("lists newest first, filters activeOnly, and counts live owners", async () => {
      const s1 = contractId("l1");
      const s2 = contractId("l2");
      const g1 = await grantFor(s1, "owner");
      const g2 = await a.tx((repos) =>
        repos.grants.insert({
          id: contractId("grant"),
          appId,
          subject: s2,
          email: "x@example.test",
          role: "owner",
          grantedBy: owner,
          createdAt: plus(1_000),
        })
      );
      const byApp = await a.repos.grants.listByApp(appId);
      expect(byApp.findIndex((g) => g.id === g2.id)).toBeLessThan(byApp.findIndex((g) => g.id === g1.id));
      expect(await a.repos.grants.listBySubject(s1)).toEqual([g1]);
      expect(await a.repos.grants.listBySubject(s1, { activeOnly: true })).toEqual([g1]);
      expect(await a.repos.grants.countActiveOwners(appId)).toBe(2);
      await a.tx((repos) => repos.grants.revoke(g2.id, owner, "x"));
      expect(await a.repos.grants.countActiveOwners(appId)).toBe(1);
      expect(await a.repos.grants.listBySubject(s2, { activeOnly: true })).toEqual([]);
    });
  });

  /* -------------------------------- invites -------------------------------- */

  describe("invites", () => {
    const inviteFor = (overrides: Partial<{ expiresAt: string; supersedes: string }> = {}) =>
      a.tx((repos) =>
        repos.invites.insert({
          id: contractId("inv"),
          appId,
          email: "person@example.test",
          role: "editor",
          tokenHash: contractHex(),
          createdBy: owner,
          expiresAt: overrides.expiresAt ?? plus(60_000),
          supersedes: overrides.supersedes,
        })
      );

    it("round-trips, finds by token hash, and refuses a duplicate hash", async () => {
      const invite = await inviteFor();
      expect(invite.state).toBe("pending");
      expect(await a.repos.invites.get(invite.id)).toEqual(invite);
      expect(await a.repos.invites.getByTokenHash(invite.tokenHash)).toEqual(invite);
      expect(await a.repos.invites.getByTokenHash(contractHex())).toBeNull();
      await expect(
        a.tx((repos) =>
          repos.invites.insert({
            id: contractId("inv"),
            appId,
            email: "other@example.test",
            role: "viewer",
            tokenHash: invite.tokenHash,
            createdBy: owner,
            expiresAt: plus(60_000),
          })
        )
      ).rejects.toBeDefined();
    });

    it("accepts exactly once, never past expiry, and the boundary is strict", async () => {
      const invite = await inviteFor();
      const subject = contractId("acceptor");
      const at = nowIso();
      expect(await a.tx((repos) => repos.invites.accept(invite.id, subject, at))).toBe(true);
      expect(await a.tx((repos) => repos.invites.accept(invite.id, subject, at))).toBe(false);
      expect(await a.repos.invites.get(invite.id)).toMatchObject({
        state: "accepted",
        acceptedAt: at,
        acceptedBy: subject,
      });

      const deadline = plus(5_000);
      const edge = await inviteFor({ expiresAt: deadline });
      expect(await a.tx((repos) => repos.invites.accept(edge.id, subject, deadline))).toBe(false);
      expect(await a.tx((repos) => repos.invites.accept(edge.id, subject, plus(-1, Date.parse(deadline))))).toBe(
        true
      );
    });

    it("setState and supersede move only a pending invitation; listByApp filters by state", async () => {
      const first = await inviteFor();
      const second = await inviteFor({ supersedes: first.id });
      expect(second.supersedes).toBe(first.id);
      expect(await a.tx((repos) => repos.invites.supersede(first.id))).toBe(true);
      expect(await a.tx((repos) => repos.invites.supersede(first.id))).toBe(false);
      expect(await a.tx((repos) => repos.invites.setState(second.id, "revoked"))).toBe(true);
      expect(await a.tx((repos) => repos.invites.setState(second.id, "expired"))).toBe(false);
      const superseded = await a.repos.invites.listByApp(appId, { state: "superseded" });
      expect(superseded.map((i) => i.id)).toContain(first.id);
      expect(superseded.map((i) => i.id)).not.toContain(second.id);
      const all = await a.repos.invites.listByApp(appId);
      expect(all.map((i) => i.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    });
  });

  /* ------------------------------- deliveries ------------------------------ */

  describe("deliveries", () => {
    const deliveryFor = async (payload: Uint8Array | null = new Uint8Array([1, 2, 3, 4]), createdAt?: string) => {
      const invite = await a.tx((repos) =>
        repos.invites.insert({
          id: contractId("dinv"),
          appId,
          email: "d@example.test",
          role: "viewer",
          tokenHash: contractHex(),
          createdBy: owner,
          expiresAt: plus(60_000),
        })
      );
      const delivery = await a.tx((repos) =>
        repos.deliveries.insert({ id: contractId("del"), inviteId: invite.id, sealedPayload: payload, createdAt })
      );
      return { invite, delivery };
    };

    it("round-trips and lists by invite oldest first", async () => {
      const { invite, delivery } = await deliveryFor();
      expect(delivery).toMatchObject({ state: "pending", attempts: 0 });
      expect(await a.repos.deliveries.get(delivery.id)).toEqual(delivery);
      const later = await a.tx((repos) =>
        repos.deliveries.insert({ id: contractId("del"), inviteId: invite.id, createdAt: plus(1_000) })
      );
      expect((await a.repos.deliveries.listByInvite(invite.id)).map((d) => d.id)).toEqual([delivery.id, later.id]);
    });

    it("claim hands back the sealed bytes, refuses a live claim, allows a stale or failed one, never a sent one", async () => {
      const { delivery } = await deliveryFor(new Uint8Array([9, 8, 7]));
      const now = nowIso();
      const claimed = await a.tx((repos) => repos.deliveries.claim(delivery.id, 60_000, now));
      expect(claimed.kind).toBe("claimed");
      if (claimed.kind !== "claimed") throw new Error("unreachable");
      expect(Array.from(claimed.sealedPayload!)).toEqual([9, 8, 7]);
      expect(claimed.delivery).toMatchObject({ state: "sending", attempts: 1, claimedAt: now });

      expect(await a.tx((repos) => repos.deliveries.claim(delivery.id, 60_000, now))).toEqual({ kind: "busy" });
      // The lease has passed: claimable again, and attempts moves again.
      const stale = await a.tx((repos) => repos.deliveries.claim(delivery.id, 1, plus(5_000)));
      expect(stale).toMatchObject({ kind: "claimed", delivery: { attempts: 2 } });

      expect(
        await a.tx((repos) =>
          repos.deliveries.settle(delivery.id, "failed", { transport: "smtp", error: "boom" })
        )
      ).toBe(true);
      expect(await a.repos.deliveries.get(delivery.id)).toMatchObject({
        state: "failed",
        transport: "smtp",
        error: "boom",
        claimedAt: undefined,
      });
      const retry = await a.tx((repos) => repos.deliveries.claim(delivery.id, 60_000));
      expect(retry).toMatchObject({ kind: "claimed", delivery: { attempts: 3 } });
      expect(
        await a.tx((repos) =>
          repos.deliveries.settle(delivery.id, "sent", { providerMessageId: "msg-1", transport: "smtp" })
        )
      ).toBe(true);
      expect(await a.tx((repos) => repos.deliveries.claim(delivery.id, 60_000))).toEqual({ kind: "sent" });
      expect(await a.tx((repos) => repos.deliveries.claim(contractId("nope"), 60_000))).toEqual({ kind: "missing" });
      expect(await a.repos.deliveries.get(delivery.id)).toMatchObject({ providerMessageId: "msg-1", error: undefined });
    });

    it("claimPending takes the pending rows oldest first, reclaims stale leases, and settle moves only sending rows", async () => {
      // Explicit timestamps: two inserts in the same millisecond would fall back
      // to ordering by id, which is random.
      const first = await deliveryFor(new Uint8Array([1]), plus(-2_000));
      const second = await deliveryFor(null, plus(-1_000));
      const now = plus(2_000);
      const batch = await a.tx((repos) => repos.deliveries.claimPending(60_000, { now, limit: 100 }));
      const ours = batch.filter((c) => [first.delivery.id, second.delivery.id].includes(c.delivery.id));
      expect(ours.map((c) => c.delivery.id)).toEqual([first.delivery.id, second.delivery.id]);
      expect(ours[1].sealedPayload).toBeNull();
      expect(ours.every((c) => c.delivery.state === "sending" && c.delivery.attempts === 1)).toBe(true);

      // Nothing pending now, so a second drain owns nothing of ours.
      const again = await a.tx((repos) => repos.deliveries.claimPending(60_000, { now }));
      expect(again.some((c) => c.delivery.id === first.delivery.id)).toBe(false);

      // reclaimStale puts a dead worker's rows back.
      expect(await a.tx((repos) => repos.deliveries.reclaimStale(1, plus(10_000)))).toBeGreaterThanOrEqual(2);
      expect(await a.repos.deliveries.get(first.delivery.id)).toMatchObject({ state: "pending", claimedAt: undefined });

      // settle refuses a pending row; settlePending is the path for one.
      expect(await a.tx((repos) => repos.deliveries.settle(first.delivery.id, "failed", { error: "x" }))).toBe(false);
      expect(
        await a.tx((repos) =>
          repos.deliveries.settlePending(first.delivery.id, { transport: null, error: "no transport" })
        )
      ).toBe(true);
      expect(await a.tx((repos) => repos.deliveries.settlePending(first.delivery.id, { error: "again" }))).toBe(false);
      expect(await a.repos.deliveries.get(first.delivery.id)).toMatchObject({
        state: "failed",
        error: "no transport",
        transport: undefined,
      });
    });

    it("clearSealedPayload erases the bytes and reports whether a row existed", async () => {
      const { delivery } = await deliveryFor(new Uint8Array([1]));
      expect(await a.tx((repos) => repos.deliveries.clearSealedPayload(delivery.id))).toBe(true);
      const claimed = await a.tx((repos) => repos.deliveries.claim(delivery.id, 60_000));
      expect(claimed).toMatchObject({ kind: "claimed", sealedPayload: null });
      expect(await a.tx((repos) => repos.deliveries.clearSealedPayload(contractId("nope")))).toBe(false);
    });
  });

  /* -------------------------------- sessions ------------------------------- */

  describe("sessions", () => {
    const sessionFor = async (subject: string, grantId: string, expiresAt = plus(3_600_000)) =>
      a.tx((repos) => repos.sessions.insert({ id: contractHex(), appId, subject, grantId, expiresAt }));

    it("round-trips, lists live ones only when asked, and terminates once", async () => {
      const subject = contractId("sess");
      const grant = await grantFor(subject);
      const live = await sessionFor(subject, grant.id);
      const expired = await sessionFor(subject, grant.id, plus(-1_000));
      expect(await a.repos.sessions.get(live.id)).toEqual(live);
      expect(live.terminatedAt).toBeUndefined();

      const all = (await a.repos.sessions.listByApp(appId)).map((s) => s.id);
      expect(all).toEqual(expect.arrayContaining([live.id, expired.id]));
      const liveOnly = (await a.repos.sessions.listByApp(appId, { liveOnly: true })).map((s) => s.id);
      expect(liveOnly).toContain(live.id);
      expect(liveOnly).not.toContain(expired.id);

      const at = nowIso();
      expect(await a.tx((repos) => repos.sessions.terminate(live.id, "signed_out", at))).toBe(true);
      expect(await a.tx((repos) => repos.sessions.terminate(live.id, "operator", at))).toBe(false);
      expect(await a.repos.sessions.get(live.id)).toMatchObject({ terminatedAt: at, terminatedReason: "signed_out" });
      expect((await a.repos.sessions.listByApp(appId, { liveOnly: true })).map((s) => s.id)).not.toContain(live.id);
    });

    it("bulk terminators act on exactly the live rows in scope, and appIdsForSubject reads them first", async () => {
      const subject = contractId("bulk");
      const grant = await grantFor(subject);
      const s1 = await sessionFor(subject, grant.id);
      const s2 = await sessionFor(subject, grant.id);
      await a.tx((repos) => repos.sessions.terminate(s2.id, "operator"));
      expect(await a.repos.sessions.appIdsForSubject(subject)).toEqual([appId]);

      expect(await a.tx((repos) => repos.sessions.terminateBySubject(subject, "signed_out"))).toBe(1);
      expect(await a.repos.sessions.appIdsForSubject(subject)).toEqual([]);
      expect(await a.repos.sessions.get(s1.id)).toMatchObject({ terminatedReason: "signed_out" });
      expect(await a.repos.sessions.get(s2.id)).toMatchObject({ terminatedReason: "operator" });

      const other = contractId("bulk2");
      const g2 = await grantFor(other);
      await sessionFor(other, g2.id);
      await sessionFor(other, g2.id);
      expect(await a.tx((repos) => repos.sessions.terminateByGrant(g2.id, "revoked"))).toBe(2);
      expect(await a.tx((repos) => repos.sessions.terminateByGrant(g2.id, "revoked"))).toBe(0);

      const third = contractId("bulk3");
      const g3 = await grantFor(third);
      await sessionFor(third, g3.id);
      expect(await a.tx((repos) => repos.sessions.terminateByApp(appId, "operator"))).toBeGreaterThanOrEqual(1);
      expect(await a.repos.sessions.listByApp(appId, { liveOnly: true })).toEqual([]);
    });

    it("purgeExpired deletes only rows past expiry, terminated or not", async () => {
      const subject = contractId("purge");
      const grant = await grantFor(subject);
      const old = await sessionFor(subject, grant.id, plus(-60_000));
      const fresh = await sessionFor(subject, grant.id, plus(60_000));
      expect(await a.tx((repos) => repos.sessions.purgeExpired())).toBeGreaterThanOrEqual(1);
      expect(await a.repos.sessions.get(old.id)).toBeNull();
      expect(await a.repos.sessions.get(fresh.id)).toEqual(fresh);
    });
  });

  /* -------------------------------- exchanges ------------------------------ */

  describe("exchanges", () => {
    it("consumes a code exactly once, echoes the browser state, and refuses past expiry", async () => {
      const subject = contractId("xchg");
      const grant = await grantFor(subject);
      const exchange = await a.tx((repos) =>
        repos.exchanges.insert({
          codeHash: contractHex(),
          appId,
          subject,
          grantId: grant.id,
          state: "opaque-browser-state",
          expiresAt: plus(60_000),
        })
      );
      expect(await a.repos.exchanges.get(exchange.codeHash)).toEqual(exchange);
      expect(exchange.consumedAt).toBeUndefined();

      const at = nowIso();
      const consumed = await a.tx((repos) => repos.exchanges.consume(exchange.codeHash, at));
      expect(consumed).toMatchObject({ state: "opaque-browser-state", consumedAt: at, sessionId: undefined });
      expect(await a.tx((repos) => repos.exchanges.consume(exchange.codeHash, at))).toBeNull();

      const session = await a.tx((repos) =>
        repos.sessions.insert({ id: contractHex(), appId, subject, grantId: grant.id, expiresAt: plus(60_000) })
      );
      expect(await a.tx((repos) => repos.exchanges.linkSession(exchange.codeHash, session.id))).toBe(true);
      expect(await a.tx((repos) => repos.exchanges.linkSession(contractHex(), session.id))).toBe(false);
      expect((await a.repos.exchanges.get(exchange.codeHash))!.sessionId).toBe(session.id);

      const deadline = plus(5_000);
      const late = await a.tx((repos) =>
        repos.exchanges.insert({
          codeHash: contractHex(),
          appId,
          subject,
          grantId: grant.id,
          state: "s",
          expiresAt: deadline,
        })
      );
      expect(await a.tx((repos) => repos.exchanges.consume(late.codeHash, deadline))).toBeNull();
      expect(await a.tx((repos) => repos.exchanges.consume(contractHex(), at))).toBeNull();
    });

    it("purgeExpired removes settled and expired codes, and leaves live ones", async () => {
      const subject = contractId("xpurge");
      const grant = await grantFor(subject);
      const mint = (expiresAt: string) =>
        a.tx((repos) =>
          repos.exchanges.insert({ codeHash: contractHex(), appId, subject, grantId: grant.id, state: "s", expiresAt })
        );
      const old = await mint(plus(-1_000));
      const live = await mint(plus(60_000));
      expect(await a.tx((repos) => repos.exchanges.purgeExpired())).toBeGreaterThanOrEqual(1);
      expect(await a.repos.exchanges.get(old.codeHash)).toBeNull();
      expect(await a.repos.exchanges.get(live.codeHash)).toEqual(live);
    });
  });
});
