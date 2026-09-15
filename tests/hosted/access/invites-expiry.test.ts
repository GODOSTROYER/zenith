/**
 * Expiry is a state, not only a comparison.
 *
 * `app_invites_pending_email` fences one *pending* row per app and address.
 * Expiry used to be enforced only by comparing `expires_at` on the accept path,
 * so a link nobody ever followed kept its address's slot for ever and the 409
 * told the owner to "wait for it to expire" — which never happened. These tests
 * pin the explicit `pending → expired` transition: lazily on the accept path,
 * as a bounded sweep inside the issue transaction and in the gated maintenance
 * pass, and case-folded so a row written with different capitalisation is still
 * the same slot. The list is a read — it *reports* an overdue invitation as
 * expired and writes nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-access-invite-expiry-");
process.env.ZENITH_SECRET_KEY = "1".repeat(64);
delete process.env.ZENITH_SMTP_URL;

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { HostedError } = await import("@/lib/hosted/contracts");
const { acceptInvite, createInvite, listInvites } = await import("@/lib/hosted/access");
const { expireOverdueInvites, pendingInviteConflict } = await import(
  "@/lib/hosted/access/invites"
);
const { IDENTITIES, iso, seedApp, seedGrant, sha256Hex, uuid, verified } = await import("./_helpers");

const a = openAuthority();

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

const refusal = async (fn: () => unknown): Promise<{ code: string; message: string; fix?: string }> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HostedError) return { code: err.code, message: err.message, fix: err.fix };
    throw err;
  }
  throw new Error("expected a refusal, and the call returned");
};

const app = async (slug: string) => {
  const record = await seedApp(a, { slug, name: `App ${slug}` });
  await seedGrant(a, record.id, IDENTITIES.owner, "owner");
  return record;
};

/**
 * A pending invitation written straight through the repository, so its expiry
 * and its capitalisation can be whatever the test needs — exactly what a
 * migration, a seed or a restored backup can leave behind.
 */
const seedInvite = (appId: string, email: string, expiresAt: string) =>
  a.tx((repos) =>
    repos.invites.insert({
      id: uuid(),
      appId,
      email,
      role: "viewer",
      tokenHash: sha256Hex(`token-${uuid()}`),
      createdBy: IDENTITIES.owner.subject,
      expiresAt,
    })
  );

describe("an expired invitation stops holding the address's slot", () => {
  it("lets the same address be invited again", async () => {
    const target = await app("expiry-reinvite");
    const stale = await seedInvite(target.id, "recipient@example.test", iso(-60_000));

    const issued = await createInvite(
      target.id,
      { email: "recipient@example.test", role: "editor" },
      IDENTITIES.owner.subject
    );

    expect(issued.invite.state).toBe("pending");
    // The old row is recorded as expired, not superseded: nobody replaced it,
    // its deadline passed.
    expect((await a.repos.invites.get(stale.id))?.state).toBe("expired");
  });

  it("is reported as expired by the list without the list writing anything", async () => {
    const target = await app("expiry-list");
    const stale = await seedInvite(target.id, "listed@example.test", iso(-1_000));
    const live = await seedInvite(target.id, "live@example.test", iso(600_000));

    const listed = await listInvites(target.id);
    expect(listed.find((invite) => invite.id === stale.id)?.state).toBe("expired");
    expect(listed.find((invite) => invite.id === live.id)?.state).toBe("pending");

    // A GET is a read: the answer is computed, not written back. The row is
    // still `pending` until a write path — or the maintenance call below —
    // records the transition.
    expect((await a.repos.invites.get(stale.id))?.state).toBe("pending");
  });

  it("is recorded by the gated maintenance pass, which is a write path", async () => {
    const target = await app("expiry-sweep");
    const stale = await seedInvite(target.id, "swept@example.test", iso(-1_000));
    const live = await seedInvite(target.id, "kept@example.test", iso(600_000));

    expect(await expireOverdueInvites(target.id)).toBe(1);
    expect((await a.repos.invites.get(stale.id))?.state).toBe("expired");
    expect((await a.repos.invites.get(live.id))?.state).toBe("pending");
    // Bounded and idempotent: a second pass has nothing left to do.
    expect(await expireOverdueInvites(target.id)).toBe(0);
  });

  it("is recorded when a recipient follows a link that has run out", async () => {
    const target = await app("expiry-accept");
    const token = `token-${uuid()}`;
    const stale = await a.tx((repos) =>
      repos.invites.insert({
        id: uuid(),
        appId: target.id,
        email: IDENTITIES.stranger.email,
        role: "viewer",
        tokenHash: sha256Hex(token),
        createdBy: IDENTITIES.owner.subject,
        expiresAt: iso(-1),
      })
    );

    // The recipient still gets the one indistinguishable refusal…
    expect((await refusal(() => acceptInvite(token, verified(IDENTITIES.stranger)))).code).toBe(
      "conflict"
    );
    // …and the transition is committed rather than rolled back with it.
    expect((await a.repos.invites.get(stale.id))?.state).toBe("expired");
    expect(await a.repos.grants.activeFor(target.id, IDENTITIES.stranger.subject)).toBeNull();
  });

  it("sweeps in bounded batches and leaves other apps alone", async () => {
    const mine = await app("expiry-bounded");
    const other = await app("expiry-bounded-other");
    const elsewhere = await seedInvite(other.id, "elsewhere@example.test", iso(-1_000));
    for (let n = 0; n < 3; n++) await seedInvite(mine.id, `bulk-${n}@example.test`, iso(-1_000));

    expect(await a.tx((repos) => repos.invites.expireOverdue(iso(), { appId: mine.id, limit: 2 }))).toBe(2);
    expect(await a.tx((repos) => repos.invites.expireOverdue(iso(), { appId: mine.id, limit: 2 }))).toBe(1);
    expect(await a.tx((repos) => repos.invites.expireOverdue(iso(), { appId: mine.id }))).toBe(0);
    expect((await a.repos.invites.get(elsewhere.id))?.state).toBe("pending");
  });
});

describe("the pending slot is the same slot whatever the capitalisation", () => {
  it("supersedes a differently-cased outstanding invitation instead of colliding", async () => {
    const target = await app("expiry-case");
    const mixed = await seedInvite(target.id, "Recipient@Example.test", iso(600_000));

    const issued = await createInvite(
      target.id,
      { email: "recipient@example.test", role: "viewer" },
      IDENTITIES.owner.subject
    );

    expect((await a.repos.invites.get(mixed.id))?.state).toBe("superseded");
    expect(issued.invite.state).toBe("pending");
  });
});

describe("the pending-invitation conflict names what an operator can do", () => {
  it("fires on a second pending row for one app and address", async () => {
    const target = await app("expiry-conflict-index");
    await seedInvite(target.id, "blocked@example.test", iso(600_000));

    // The index, not the service, is the fence between instances: a second
    // writer that skips the supersede is refused by the database.
    await expect(seedInvite(target.id, "BLOCKED@example.test", iso(600_000))).rejects.toThrow(
      /app_invites_pending_email/
    );
  });

  it("offers resend, revoke and supersede rather than waiting for an expiry", async () => {
    // The refusal the index produces is only reachable through a genuine race
    // with another writer — the issue path supersedes and sweeps first — so the
    // copy is pinned at its source rather than through a contrived collision.
    const refused = pendingInviteConflict("blocked@example.test");
    expect(refused.code).toBe("conflict");
    expect(refused.status).toBe(409);
    expect(refused.fix).toMatch(/resend/i);
    expect(refused.fix).toMatch(/revoke/i);
    expect(refused.fix).toMatch(/supersede/i);
    expect(refused.fix).not.toMatch(/wait for it to expire/i);
  });
});
