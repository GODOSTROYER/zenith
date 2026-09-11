/**
 * The three single-use, time-bounded steps of getting a person into an app:
 * redeeming an exchange code, holding a session, and accepting an invitation.
 *
 * Each of them is one conditional UPDATE, and each test here is really the
 * same question asked three ways — what happens when the same thing is
 * redeemed twice, and what happens exactly on the deadline.
 */
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-access-");

const { closeAuthority, openAuthority, sqliteConnection } = await import("@/lib/hosted/authority");
const { iso, seedApp, seedGrant, sha256Hex, uuid } = await import("./_helpers");

const a = openAuthority();

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "33333333-3333-4333-8333-333333333333";

describe("exchange codes", () => {
  it("is redeemed exactly once, and echoes the browser state back", async () => {
    const app = await seedApp(a, { slug: "exchange-app" });
    const grant = await seedGrant(a, app.id, VIEWER, "viewer");
    const code = `code-${uuid()}`;
    const codeHash = sha256Hex(code);
    await a.tx((repos) =>
      repos.exchanges.insert({
        codeHash,
        appId: app.id,
        subject: VIEWER,
        grantId: grant.id,
        state: "browser-state-abc123",
        expiresAt: iso(60_000),
      })
    );

    const sessionId = sha256Hex(`session-${uuid()}`);
    await a.tx((repos) =>
      repos.sessions.insert({
        id: sessionId,
        appId: app.id,
        subject: VIEWER,
        grantId: grant.id,
        expiresAt: iso(3_600_000),
      })
    );

    // Two redemptions of the same code, back to back — one wins.
    const first = await a.tx((repos) => repos.exchanges.consume(codeHash, iso(), sessionId));
    const second = await a.tx((repos) => repos.exchanges.consume(codeHash, iso(), sessionId));

    expect(first).toMatchObject({
      appId: app.id,
      subject: VIEWER,
      grantId: grant.id,
      state: "browser-state-abc123",
      sessionId,
    });
    expect(first?.consumedAt).toBeTruthy();
    expect(second).toBeNull();

    // The stored row still carries the browser state, not a lifecycle word.
    expect((await a.repos.exchanges.get(codeHash))?.state).toBe("browser-state-abc123");
  });

  it("treats its own expiry instant as expired", async () => {
    const app = await seedApp(a, { slug: "exchange-expiry" });
    const grant = await seedGrant(a, app.id, VIEWER, "viewer");
    // Both instants come from one base, so the boundary being tested is the
    // one in the SQL rather than however long the test took to get here.
    const base = Date.now();
    const deadline = new Date(base + 60_000).toISOString();
    const justBefore = new Date(base + 59_999).toISOString();
    const codeHash = sha256Hex(`code-${uuid()}`);
    await a.tx((repos) =>
      repos.exchanges.insert({
        codeHash,
        appId: app.id,
        subject: VIEWER,
        grantId: grant.id,
        state: "s",
        expiresAt: deadline,
      })
    );

    expect(await a.tx((repos) => repos.exchanges.consume(codeHash, deadline))).toBeNull();
    expect(await a.tx((repos) => repos.exchanges.consume(codeHash, justBefore))).not.toBeNull();
  });

  it("refuses an unknown code without saying anything about which part was wrong", async () => {
    expect(await a.tx((repos) => repos.exchanges.consume(sha256Hex("never issued"), iso()))).toBeNull();
  });
});

describe("sessions", () => {
  it("terminates every live session a subject holds and counts only what it changed", async () => {
    // A subject of this test's own, so a session opened by another test in
    // this file cannot be counted as one of the two this one is about.
    const SUBJECT = `55555555-5555-4555-8555-${uuid().slice(0, 12)}`;
    const one = await seedApp(a, { slug: "session-app-1" });
    const two = await seedApp(a, { slug: "session-app-2" });
    const grantOne = await seedGrant(a, one.id, SUBJECT, "viewer");
    const grantTwo = await seedGrant(a, two.id, SUBJECT, "viewer");
    const otherPerson = await seedGrant(a, one.id, OWNER, "owner");

    const open = async (appId: string, subject: string, grantId: string): Promise<string> => {
      const id = sha256Hex(`cookie-${uuid()}`);
      await a.tx((repos) =>
        repos.sessions.insert({ id, appId, subject, grantId, expiresAt: iso(3_600_000) })
      );
      return id;
    };

    const live = [
      await open(one.id, SUBJECT, grantOne.id),
      await open(two.id, SUBJECT, grantTwo.id),
    ];
    const already = await open(one.id, SUBJECT, grantOne.id);
    const untouched = await open(one.id, OWNER, otherPerson.id);
    expect(await a.tx((repos) => repos.sessions.terminate(already, "signed_out"))).toBe(true);

    // Only the two still-live sessions of this subject move.
    expect(await a.tx((repos) => repos.sessions.terminateBySubject(SUBJECT, "revoked"))).toBe(2);
    for (const id of live)
      expect(await a.repos.sessions.get(id)).toMatchObject({ terminatedReason: "revoked" });
    expect((await a.repos.sessions.get(already))?.terminatedReason).toBe("signed_out");
    expect((await a.repos.sessions.get(untouched))?.terminatedAt).toBeUndefined();

    // A second sign-out has nothing left to end.
    expect(await a.tx((repos) => repos.sessions.terminateBySubject(SUBJECT, "revoked"))).toBe(0);
  });

  it("terminates by grant and by app", async () => {
    const app = await seedApp(a, { slug: "session-app-3" });
    const grant = await seedGrant(a, app.id, VIEWER, "viewer");
    const owner = await seedGrant(a, app.id, OWNER, "owner");
    const open = async (subject: string, grantId: string): Promise<string> => {
      const id = sha256Hex(`cookie-${uuid()}`);
      await a.tx((repos) =>
        repos.sessions.insert({ id, appId: app.id, subject, grantId, expiresAt: iso(3_600_000) })
      );
      return id;
    };
    await open(VIEWER, grant.id);
    await open(OWNER, owner.id);

    expect(await a.tx((repos) => repos.sessions.terminateByGrant(grant.id, "revoked"))).toBe(1);
    expect(await a.repos.sessions.listByApp(app.id, { liveOnly: true })).toHaveLength(1);
    expect(await a.tx((repos) => repos.sessions.terminateByApp(app.id, "operator"))).toBe(1);
    expect(await a.repos.sessions.listByApp(app.id, { liveOnly: true })).toHaveLength(0);
  });

  it("purges only what has expired, and keeps a terminated session until it does", async () => {
    const app = await seedApp(a, { slug: "session-app-4" });
    const grant = await seedGrant(a, app.id, VIEWER, "viewer");
    const open = async (expiresAt: string): Promise<string> => {
      const id = sha256Hex(`cookie-${uuid()}`);
      await a.tx((repos) =>
        repos.sessions.insert({ id, appId: app.id, subject: VIEWER, grantId: grant.id, expiresAt })
      );
      return id;
    };
    const expired = await open(iso(-1_000));
    const terminatedButLive = await open(iso(3_600_000));
    const live = await open(iso(3_600_000));
    await a.tx((repos) => repos.sessions.terminate(terminatedButLive, "signed_out"));

    expect(await a.tx((repos) => repos.sessions.purgeExpired(iso(-500)))).toBe(1);
    expect(await a.repos.sessions.get(expired)).toBeNull();

    // A session that was signed out keeps its row and its reason: that is a
    // finding, where running out of time is not.
    expect(await a.repos.sessions.get(terminatedButLive)).toMatchObject({
      terminatedReason: "signed_out",
    });
    expect((await a.repos.sessions.get(live))?.terminatedAt).toBeUndefined();
  });
});

describe("invitations", () => {
  const invite = async (appId: string, expiresAt: string) => {
    const token = `token-${uuid()}`;
    const record = await a.tx((repos) =>
      repos.invites.insert({
        id: uuid(),
        appId,
        email: "recipient@example.test",
        role: "editor",
        tokenHash: sha256Hex(token),
        createdBy: OWNER,
        expiresAt,
      })
    );
    return { token, record };
  };

  it("accepts once and never again", async () => {
    const app = await seedApp(a, { slug: "invite-app" });
    const { token, record } = await invite(app.id, iso(60_000));

    expect((await a.repos.invites.getByTokenHash(sha256Hex(token)))?.id).toBe(record.id);
    expect(await a.tx((repos) => repos.invites.accept(record.id, VIEWER, iso()))).toBe(true);
    expect(await a.tx((repos) => repos.invites.accept(record.id, OWNER, iso()))).toBe(false);
    expect(await a.repos.invites.get(record.id)).toMatchObject({
      state: "accepted",
      acceptedBy: VIEWER,
    });
  });

  it("treats its own expiry instant as expired", async () => {
    const app = await seedApp(a, { slug: "invite-expiry" });
    const base = Date.now();
    const deadline = new Date(base + 60_000).toISOString();
    const justBefore = new Date(base + 59_999).toISOString();
    const first = await invite(app.id, deadline);
    const second = await invite(app.id, deadline);

    expect(await a.tx((repos) => repos.invites.accept(first.record.id, VIEWER, deadline))).toBe(false);
    expect((await a.repos.invites.get(first.record.id))?.state).toBe("pending");
    expect(await a.tx((repos) => repos.invites.accept(second.record.id, VIEWER, justBefore))).toBe(true);
  });

  it("supersedes an outstanding invitation on resend and refuses to accept it afterwards", async () => {
    const app = await seedApp(a, { slug: "invite-resend" });
    const original = await invite(app.id, iso(60_000));

    const replacement = await a.tx(async (repos) => {
      const superseded = await repos.invites.supersede(original.record.id);
      const next = await repos.invites.insert({
        id: uuid(),
        appId: app.id,
        email: "recipient@example.test",
        role: "editor",
        tokenHash: sha256Hex(`token-${uuid()}`),
        createdBy: OWNER,
        expiresAt: iso(60_000),
        supersedes: original.record.id,
      });
      return { superseded, next };
    });

    expect(replacement.superseded).toBe(true);
    expect(replacement.next.supersedes).toBe(original.record.id);
    expect((await a.repos.invites.get(original.record.id))?.state).toBe("superseded");
    expect(await a.tx((repos) => repos.invites.accept(original.record.id, VIEWER, iso()))).toBe(false);
    expect(await a.tx((repos) => repos.invites.accept(replacement.next.id, VIEWER, iso()))).toBe(true);
    expect(await a.repos.invites.listByApp(app.id)).toHaveLength(2);
  });
});

describe("invitation deliveries", () => {
  it("claims before the effect, keeps the sealed token until it can be erased, and reclaims a stale lease", async () => {
    const app = await seedApp(a, { slug: "delivery-app" });
    const invite = await a.tx((repos) =>
      repos.invites.insert({
        id: uuid(),
        appId: app.id,
        email: "recipient@example.test",
        role: "viewer",
        tokenHash: sha256Hex(`token-${uuid()}`),
        createdBy: OWNER,
        expiresAt: iso(60_000),
      })
    );
    // Opaque bytes as far as this module is concerned: W5 seals them, and
    // nothing here holds the key or looks inside.
    const sealed = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    const delivery = await a.tx((repos) =>
      repos.deliveries.insert({ id: uuid(), inviteId: invite.id, sealedPayload: sealed })
    );
    expect(delivery).toMatchObject({ state: "pending", attempts: 0 });

    const claimed = await a.tx((repos) => repos.deliveries.claimPending(60_000));
    expect(claimed).toHaveLength(1);
    expect(claimed[0].delivery).toMatchObject({ id: delivery.id, state: "sending", attempts: 1 });
    expect(claimed[0].sealedPayload).toBeInstanceOf(Uint8Array);
    expect(Array.from(claimed[0].sealedPayload!)).toEqual(Array.from(sealed));

    // While the lease is live nobody else takes it.
    expect(await a.tx((repos) => repos.deliveries.claimPending(60_000))).toHaveLength(0);

    // The sender died. A later claim with an expired lease picks it back up,
    // and the sealed payload is still there so the email can be rebuilt.
    const retried = await a.tx((repos) => repos.deliveries.claimPending(0));
    expect(retried).toHaveLength(1);
    expect(retried[0].delivery.attempts).toBe(2);
    expect(retried[0].sealedPayload).not.toBeNull();

    expect(
      await a.tx((repos) =>
        repos.deliveries.settle(delivery.id, "sent", {
          transport: "smtp",
          providerMessageId: "<abc@smtp.example.test>",
        })
      )
    ).toBe(true);
    // Settling twice is not a second send.
    expect(await a.tx((repos) => repos.deliveries.settle(delivery.id, "sent", { transport: "smtp" }))).toBe(false);

    expect(await a.repos.deliveries.get(delivery.id)).toMatchObject({
      state: "sent",
      attempts: 2,
      transport: "smtp",
      providerMessageId: "<abc@smtp.example.test>",
      claimedAt: undefined,
      error: undefined,
    });

    // Once it can no longer be resent from this row, the token stops existing.
    expect(await a.tx((repos) => repos.deliveries.clearSealedPayload(delivery.id))).toBe(true);
    expect(
      sqliteConnection(a).prepare("SELECT sealed_payload FROM invite_deliveries WHERE id = ?").get(delivery.id)
    ).toMatchObject({ sealed_payload: null });
    expect(await a.repos.deliveries.listByInvite(invite.id)).toHaveLength(1);
  });

  it("records a failure with its reason rather than a bare state", async () => {
    const app = await seedApp(a, { slug: "delivery-app-2" });
    const invite = await a.tx((repos) =>
      repos.invites.insert({
        id: uuid(),
        appId: app.id,
        email: "recipient@example.test",
        role: "viewer",
        tokenHash: sha256Hex(`token-${uuid()}`),
        createdBy: OWNER,
        expiresAt: iso(60_000),
      })
    );
    const delivery = await a.tx((repos) => repos.deliveries.insert({ id: uuid(), inviteId: invite.id }));

    await a.tx((repos) => repos.deliveries.claimPending(60_000));
    expect(
      await a.tx((repos) =>
        repos.deliveries.settle(delivery.id, "failed", {
          error: "the SMTP server rejected the recipient address",
        })
      )
    ).toBe(true);
    expect(await a.repos.deliveries.get(delivery.id)).toMatchObject({
      state: "failed",
      error: "the SMTP server rejected the recipient address",
      transport: undefined,
    });
    // A settled row is not reclaimed by a later sweep.
    expect(await a.tx((repos) => repos.deliveries.reclaimStale(0))).toBe(0);
  });
});

describe("grants", () => {
  it("allows one live grant per person per app and keeps revoked ones as history", async () => {
    const app = await seedApp(a, { slug: "grant-app" });
    const grant = await seedGrant(a, app.id, VIEWER, "viewer");

    await expect(seedGrant(a, app.id, VIEWER, "editor")).rejects.toThrow(/UNIQUE/i);
    expect(await a.repos.grants.countActiveOwners(app.id)).toBe(0);

    const revoked = await a.tx(async (repos) => {
      const result = await repos.grants.revoke(grant.id, OWNER, "left the project");
      await repos.sessions.terminateByGrant(grant.id, "revoked");
      await repos.revocations.append({
        appId: app.id,
        grantId: grant.id,
        subject: VIEWER,
        by: OWNER,
        reason: "left the project",
      });
      return result;
    });

    expect(revoked).toMatchObject({ state: "revoked", revokedBy: OWNER, revokedReason: "left the project" });
    expect(await a.repos.grants.activeFor(app.id, VIEWER)).toBeNull();
    expect(await a.repos.grants.listByApp(app.id)).toHaveLength(1);
    expect(await a.repos.revocations.maxSeq()).toBeGreaterThan(0);
    expect(await a.repos.revocations.listAfter(0)).toHaveLength(1);

    // Re-granting the same person is now possible, and does not resurrect the old row.
    const again = await seedGrant(a, app.id, VIEWER, "viewer");
    expect(again.id).not.toBe(grant.id);
    expect(await a.repos.grants.listByApp(app.id)).toHaveLength(2);
    expect(await a.repos.grants.listByApp(app.id, { activeOnly: true })).toHaveLength(1);
  });

  it("changes the role of a live grant only", async () => {
    const app = await seedApp(a, { slug: "role-app" });
    const grant = await seedGrant(a, app.id, VIEWER, "viewer");

    expect(await a.tx((repos) => repos.grants.setRole(grant.id, "editor"))).toBe(true);
    expect((await a.repos.grants.activeFor(app.id, VIEWER))?.role).toBe("editor");

    await a.tx((repos) => repos.grants.revoke(grant.id, OWNER, "no longer needed"));
    expect(await a.tx((repos) => repos.grants.setRole(grant.id, "owner"))).toBe(false);
    expect((await a.repos.grants.get(grant.id))?.role).toBe("editor");
    expect(await a.tx((repos) => repos.grants.setRole("no-such-grant", "owner"))).toBe(false);
  });

  it("lists an app's grants by subject and an install's apps by workspace", async () => {
    const mine = await seedApp(a, { slug: "listing-app", workspaceId: "ws-listing" });
    const other = await seedApp(a, { slug: "listing-app-2", workspaceId: "ws-listing" });
    await seedApp(a, { slug: "listing-app-3", workspaceId: "ws-elsewhere" });
    const person = `66666666-6666-4666-8666-${uuid().slice(0, 12)}`;
    await seedGrant(a, mine.id, person, "owner");
    await seedGrant(a, other.id, person, "viewer");

    expect((await a.repos.apps.listByWorkspace("ws-listing")).map((app) => app.slug)).toEqual([
      "listing-app",
      "listing-app-2",
    ]);
    expect(await a.repos.apps.listByWorkspace("ws-nothing")).toEqual([]);
    expect((await a.repos.grants.listBySubject(person)).map((g) => g.role).sort()).toEqual([
      "owner",
      "viewer",
    ]);
    expect((await a.repos.apps.listAll()).length).toBeGreaterThanOrEqual(3);
  });

  it("moves grants to needs_reapproval in bulk without touching other apps", async () => {
    const one = await seedApp(a, { slug: "reapproval-1" });
    const two = await seedApp(a, { slug: "reapproval-2" });
    await seedGrant(a, one.id, OWNER, "owner");
    await seedGrant(a, one.id, VIEWER, "viewer");
    await seedGrant(a, two.id, OWNER, "owner");

    expect(await a.tx((repos) => repos.grants.markNeedsReapproval([one.id]))).toBe(2);
    expect(await a.repos.grants.listByApp(one.id, { activeOnly: true })).toHaveLength(0);
    expect(await a.repos.grants.countActiveOwners(one.id)).toBe(0);
    expect(await a.repos.grants.countActiveOwners(two.id)).toBe(1);
    expect(await a.tx((repos) => repos.grants.markNeedsReapproval([]))).toBe(0);
  });
});
