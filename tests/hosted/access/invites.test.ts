/**
 * Invitations: one link, one use, one address, forty-eight hours.
 *
 * The properties worth pinning are all about what an invitation *stops* being
 * able to do — after it is accepted, after it is resent, after it is revoked,
 * and at the instant it expires — plus the one that makes a stolen link useless
 * on its own: acceptance is bound to the verified address the invitation names,
 * and a wrong address and an unconfirmed one are refused with the same words.
 *
 * Email delivery is a separate file; here the install has no SMTP, which is
 * exactly the case where `acceptUrl` in the response is the only copy the owner
 * gets.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-access-invites-");
process.env.ZENITH_SECRET_KEY = "1".repeat(64);
delete process.env.ZENITH_SMTP_URL;

const { closeAuthority, openAuthority, sqliteConnection } = await import("@/lib/hosted/authority");
const { HostedError, INVITE_TTL_MS } = await import("@/lib/hosted/contracts");
const { acceptInvite, createInvite, listInvites, resendInvite, revokeInvite, revokeGrant } =
  await import("@/lib/hosted/access");
const { IDENTITIES, seedApp, seedGrant, sha256Hex, uuid, verified } = await import("./_helpers");

const a = openAuthority();

afterAll(async () => {
  closeAuthority();
  removeDir(dataDir);
});

afterEach(async () => {
  vi.useRealTimers();
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

/** The token out of the one place it is ever handed over in clear. */
const tokenOf = (acceptUrl: string): string =>
  new URL(acceptUrl).searchParams.get("token") as string;

const app = async (slug: string) => {
  const record = await seedApp(a, { slug, name: `App ${slug}` });
  await seedGrant(a, record.id, IDENTITIES.owner, "owner");
  return record;
};

describe("creating an invitation", () => {
  it("hands the link over once, stores only its hash, and expires it in 48 hours", async () => {
    const target = await app("invite-create");
    const issued = await createInvite(
      target.id,
      { email: "  Recipient@Example.Test ", role: "editor" },
      IDENTITIES.owner.subject
    );
    const token = tokenOf(issued.acceptUrl);

    expect(issued.invite.email).toBe("recipient@example.test");
    expect(issued.invite.state).toBe("pending");
    expect(issued.invite.tokenHash).toBe(sha256Hex(token));
    expect(issued.acceptUrl).toContain("/apps/accept?token=");

    // The row holds the hash and nothing that can be turned back into a link.
    const row = sqliteConnection(a).prepare("SELECT * FROM app_invites WHERE id = ?").get(issued.invite.id);
    expect(JSON.stringify(row)).not.toContain(token);

    // The expiry is computed a hair before `created_at` is stamped, so the
    // window is TTL minus however long the insert took — never more.
    const ttl = Date.parse(issued.invite.expiresAt) - Date.parse(issued.invite.createdAt);
    expect(ttl).toBeLessThanOrEqual(INVITE_TTL_MS);
    expect(ttl).toBeGreaterThan(INVITE_TTL_MS - 5_000);
  });

  it("refuses an address that already holds access, and points at the access list", async () => {
    const target = await app("invite-held");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const refused = await refusal(() =>
      createInvite(target.id, { email: IDENTITIES.viewer.email, role: "editor" }, IDENTITIES.owner.subject)
    );
    expect(refused.code).toBe("conflict");
    expect(refused.fix).toContain("access list");
  });

  it("supersedes an outstanding invitation for the same address", async () => {
    const target = await app("invite-supersede");
    const first = await createInvite(target.id, { email: "twice@example.test", role: "viewer" }, IDENTITIES.owner.subject);
    const second = await createInvite(target.id, { email: "twice@example.test", role: "viewer" }, IDENTITIES.owner.subject);

    expect((await a.repos.invites.get(first.invite.id))?.state).toBe("superseded");
    expect((await a.repos.invites.get(second.invite.id))?.state).toBe("pending");
    expect((await refusal(() => acceptInvite(tokenOf(first.acceptUrl), verified(IDENTITIES.stranger, { email: "twice@example.test" })))).code).toBe(
      "conflict"
    );
    expect(await listInvites(target.id)).toHaveLength(2);
  });
});

describe("accepting an invitation", () => {
  it("gives the verified recipient the role the invitation named", async () => {
    const target = await app("accept-ok");
    const issued = await createInvite(
      target.id,
      { email: IDENTITIES.stranger.email, role: "editor" },
      IDENTITIES.owner.subject
    );

    const accepted = await acceptInvite(tokenOf(issued.acceptUrl), verified(IDENTITIES.stranger));
    expect(accepted.app.id).toBe(target.id);
    expect(accepted.grant).toMatchObject({
      appId: target.id,
      subject: IDENTITIES.stranger.subject,
      role: "editor",
      state: "active",
      email: IDENTITIES.stranger.email,
    });
    expect(await a.repos.invites.get(issued.invite.id)).toMatchObject({
      state: "accepted",
      acceptedBy: IDENTITIES.stranger.subject,
    });
    expect(await a.repos.events.count({ event: "invite.accepted", appId: target.id })).toBe(1);
  });

  it("refuses a different address and an unconfirmed one with the identical sentence", async () => {
    const target = await app("accept-wrong-address");
    const forViewer = await createInvite(
      target.id,
      { email: IDENTITIES.viewer.email, role: "viewer" },
      IDENTITIES.owner.subject
    );
    const forEditor = await createInvite(
      target.id,
      { email: IDENTITIES.editor.email, role: "viewer" },
      IDENTITIES.owner.subject
    );

    const wrongAddress = await refusal(() =>
      acceptInvite(tokenOf(forViewer.acceptUrl), verified(IDENTITIES.stranger))
    );
    const unconfirmed = await refusal(() =>
      acceptInvite(tokenOf(forEditor.acceptUrl), verified(IDENTITIES.editor, { emailVerified: false }))
    );

    expect(wrongAddress.code).toBe("forbidden");
    expect(wrongAddress).toEqual(unconfirmed);
    // Nothing in the refusal says who the invitation was for.
    expect(JSON.stringify(wrongAddress)).not.toContain(IDENTITIES.viewer.email);
    expect((await a.repos.invites.get(forViewer.invite.id))?.state).toBe("pending");
    expect(await a.repos.grants.activeFor(target.id, IDENTITIES.stranger.subject)).toBeNull();
  });

  it("refuses an unknown token exactly as it refuses a replayed one", async () => {
    const target = await app("accept-replay");
    const issued = await createInvite(
      target.id,
      { email: IDENTITIES.stranger.email, role: "viewer" },
      IDENTITIES.owner.subject
    );
    const token = tokenOf(issued.acceptUrl);
    await acceptInvite(token, verified(IDENTITIES.stranger));

    const replay = await refusal(() => acceptInvite(token, verified(IDENTITIES.stranger)));
    const unknown = await refusal(() => acceptInvite(`never-issued-${uuid()}`, verified(IDENTITIES.stranger)));
    expect(replay.code).toBe("conflict");
    expect(replay).toEqual(unknown);
    expect(await a.repos.grants.listByApp(target.id, { activeOnly: true })).toHaveLength(2);
  });

  it("treats the expiry instant itself as expired", async () => {
    const target = await app("accept-expiry");
    const issued = await createInvite(
      target.id,
      { email: IDENTITIES.stranger.email, role: "viewer" },
      IDENTITIES.owner.subject
    );
    const token = tokenOf(issued.acceptUrl);
    const deadline = issued.invite.expiresAt;

    // Only Date is faked: the transaction helper's own waits stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(deadline));
    expect((await refusal(() => acceptInvite(token, verified(IDENTITIES.stranger)))).code).toBe("conflict");
    expect((await a.repos.invites.get(issued.invite.id))?.state).toBe("pending");

    vi.setSystemTime(new Date(Date.parse(deadline) - 1));
    expect((await acceptInvite(token, verified(IDENTITIES.stranger))).grant.role).toBe("viewer");
  });

  it("issues a fresh grant when the person's previous one was revoked", async () => {
    const target = await app("accept-after-revoke");
    const old = await seedGrant(a, target.id, IDENTITIES.stranger, "viewer");
    await revokeGrant(old.id, IDENTITIES.owner.subject, "left the project");

    const issued = await createInvite(
      target.id,
      { email: IDENTITIES.stranger.email, role: "editor" },
      IDENTITIES.owner.subject
    );
    const grant = (await acceptInvite(tokenOf(issued.acceptUrl), verified(IDENTITIES.stranger))).grant;

    expect(grant.id).not.toBe(old.id);
    expect(grant.state).toBe("active");
    expect(grant.role).toBe("editor");
    // The revoked row is still there: it is the evidence the person was removed.
    expect((await a.repos.grants.get(old.id))?.state).toBe("revoked");
  });
});

describe("resending and revoking", () => {
  it("kills the old link and makes a new one work", async () => {
    const target = await app("invite-resend");
    const first = await createInvite(
      target.id,
      { email: IDENTITIES.stranger.email, role: "viewer" },
      IDENTITIES.owner.subject
    );
    const second = await resendInvite(first.invite.id, IDENTITIES.owner.subject, { appId: target.id });

    expect(second.invite.supersedes).toBe(first.invite.id);
    expect(second.invite.role).toBe("viewer");
    expect(tokenOf(second.acceptUrl)).not.toBe(tokenOf(first.acceptUrl));
    expect((await a.repos.invites.get(first.invite.id))?.state).toBe("superseded");

    expect((await refusal(() => acceptInvite(tokenOf(first.acceptUrl), verified(IDENTITIES.stranger)))).code).toBe(
      "conflict"
    );
    expect((await acceptInvite(tokenOf(second.acceptUrl), verified(IDENTITIES.stranger))).grant.role).toBe("viewer");
    expect((await refusal(() => resendInvite(second.invite.id, IDENTITIES.owner.subject))).code).toBe("conflict");
  });

  it("withdraws an outstanding invitation, and refuses one that belongs to another app", async () => {
    const mine = await app("invite-revoke-mine");
    const theirs = await app("invite-revoke-theirs");
    const issued = await createInvite(
      mine.id,
      { email: IDENTITIES.stranger.email, role: "viewer" },
      IDENTITIES.owner.subject
    );

    const foreign = await refusal(() => revokeInvite(issued.invite.id, IDENTITIES.owner.subject, { appId: theirs.id }));
    const missing = await refusal(() => revokeInvite(uuid(), IDENTITIES.owner.subject, { appId: theirs.id }));
    expect(foreign.code).toBe("not_found");
    expect(foreign.message).toBe(missing.message);

    expect((await revokeInvite(issued.invite.id, IDENTITIES.owner.subject, { appId: mine.id })).state).toBe("revoked");
    expect((await refusal(() => acceptInvite(tokenOf(issued.acceptUrl), verified(IDENTITIES.stranger)))).code).toBe(
      "conflict"
    );
    expect((await refusal(() => revokeInvite(issued.invite.id, IDENTITIES.owner.subject))).code).toBe("conflict");
  });
});
