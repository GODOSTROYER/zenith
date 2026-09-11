/**
 * Grants: the role matrix, the last owner, and the one transaction a revoke is.
 *
 * The three questions this file asks:
 *
 *  1. Does every denial look the same? A stranger, a revoked grant and a
 *     too-junior role must be indistinguishable, or the refusal answers "does
 *     this person have access to this app?" for whoever asked.
 *  2. Can an app be left with nobody who can administer it? It must not be,
 *     and the guard has to be inside the write's own transaction.
 *  3. Does a revoke land whole? State, sessions, ledger, outbox row and event
 *     commit together — proved both ways, by reading them after a success and
 *     by making one of them fail and finding nothing written.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-access-grants-");
process.env.ZENITH_SECRET_KEY = "0".repeat(64);

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { HostedError } = await import("@/lib/hosted/contracts");
const {
  activeGrant,
  changeGrantRole,
  grantDirect,
  listGrants,
  requireAppRole,
  revokeGrant,
} = await import("@/lib/hosted/access");
const { IDENTITIES, seedApp, seedGrant, seedSession, uuid } = await import("./_helpers");

const a = openAuthority();

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

/** The refusal a caller sees, with nothing else about the throw. */
const denial = (fn: () => unknown): { code: string; message: string; fix?: string } => {
  try {
    fn();
  } catch (err) {
    if (err instanceof HostedError) return { code: err.code, message: err.message, fix: err.fix };
    throw err;
  }
  throw new Error("expected a refusal, and the call returned");
};

describe("the role matrix", () => {
  let appId = "";

  beforeAll(() => {
    const app = seedApp(a, { slug: "matrix" });
    appId = app.id;
    seedGrant(a, appId, IDENTITIES.owner, "owner");
    seedGrant(a, appId, IDENTITIES.editor, "editor");
    seedGrant(a, appId, IDENTITIES.viewer, "viewer");
  });

  const matrix: { who: keyof typeof IDENTITIES; allowed: ("owner" | "editor" | "viewer")[] }[] = [
    { who: "owner", allowed: ["owner", "editor", "viewer"] },
    { who: "editor", allowed: ["editor", "viewer"] },
    { who: "viewer", allowed: ["viewer"] },
  ];

  for (const row of matrix)
    for (const min of ["owner", "editor", "viewer"] as const)
      it(`${row.who} ${row.allowed.includes(min) ? "passes" : "is refused"} requireAppRole("${min}")`, () => {
        const call = () => requireAppRole(appId, IDENTITIES[row.who].subject, min);
        if (row.allowed.includes(min)) expect(call().role).toBe(row.who);
        else expect(denial(call).code).toBe("forbidden");
      });

  it("refuses a stranger, a revoked grant and an unknown app with the identical sentence", () => {
    const revoked = seedGrant(a, appId, { ...IDENTITIES.stranger, subject: `revoked-${uuid()}` }, "editor");
    revokeGrant(revoked.id, IDENTITIES.owner.subject, "left the project");

    const stranger = denial(() => requireAppRole(appId, IDENTITIES.stranger.subject, "viewer"));
    const wasGranted = denial(() => requireAppRole(appId, revoked.subject, "viewer"));
    const noSuchApp = denial(() => requireAppRole(`app-${uuid()}`, IDENTITIES.owner.subject, "viewer"));

    expect(stranger).toEqual(wasGranted);
    expect(stranger).toEqual(noSuchApp);
    expect(stranger.code).toBe("forbidden");
    // And it names what to ask for without saying anything about what is held.
    expect(stranger.message).toContain("viewer");
    for (const leak of ["revoked", "removed", "editor", IDENTITIES.stranger.email])
      expect(stranger.message).not.toContain(leak);
  });

  it("answers activeGrant with null rather than throwing, for the admission read", () => {
    expect(activeGrant(appId, IDENTITIES.stranger.subject)).toBeNull();
    expect(activeGrant(appId, IDENTITIES.viewer.subject)?.role).toBe("viewer");
  });
});

describe("direct grants", () => {
  it("refuses a second live grant for the same person and for the same address", () => {
    const app = seedApp(a, { slug: "direct" });
    const subject = `direct-${uuid()}`;
    const granted = grantDirect(
      app.id,
      { subject, email: "  New.Person@Example.Test ", role: "editor" },
      IDENTITIES.owner.subject
    );
    expect(granted.email).toBe("new.person@example.test");

    expect(
      denial(() =>
        grantDirect(app.id, { subject, email: "new.person@example.test", role: "viewer" }, IDENTITIES.owner.subject)
      ).code
    ).toBe("conflict");
    // Same address, different subject: still one seat.
    expect(
      denial(() =>
        grantDirect(
          app.id,
          { subject: `other-${uuid()}`, email: "NEW.PERSON@example.test", role: "viewer" },
          IDENTITIES.owner.subject
        )
      ).code
    ).toBe("conflict");
    expect(listGrants(app.id)).toHaveLength(1);
  });

  it("refuses an address that is not one", () => {
    const app = seedApp(a, { slug: "direct-bad-email" });
    expect(
      denial(() =>
        grantDirect(app.id, { subject: uuid(), email: "not-an-address", role: "viewer" }, IDENTITIES.owner.subject)
      ).code
    ).toBe("invalid_input");
  });
});

describe("the last owner", () => {
  it("cannot be demoted or revoked, and can be once a second owner exists", () => {
    const app = seedApp(a, { slug: "last-owner" });
    const owner = seedGrant(a, app.id, IDENTITIES.owner, "owner");
    seedGrant(a, app.id, IDENTITIES.viewer, "viewer");

    expect(denial(() => changeGrantRole(owner.id, "editor", IDENTITIES.owner.subject)).code).toBe("conflict");
    expect(denial(() => revokeGrant(owner.id, IDENTITIES.owner.subject, "leaving")).code).toBe("conflict");
    expect(a.repos.grants.get(owner.id)).toMatchObject({ state: "active", role: "owner" });

    const second = seedGrant(a, app.id, IDENTITIES.editor, "owner");
    expect(changeGrantRole(owner.id, "editor", second.subject).role).toBe("editor");
    expect(a.repos.grants.countActiveOwners(app.id)).toBe(1);
    // …and now the remaining one is protected in its turn.
    expect(denial(() => revokeGrant(second.id, second.subject, "leaving")).code).toBe("conflict");
  });

  it("treats a second revoke as a conflict rather than a crash", () => {
    const app = seedApp(a, { slug: "double-revoke" });
    seedGrant(a, app.id, IDENTITIES.owner, "owner");
    const victim = seedGrant(a, app.id, IDENTITIES.editor, "editor");

    const first = revokeGrant(victim.id, IDENTITIES.owner.subject, "left the project");
    expect(first.grant.state).toBe("revoked");

    const second = denial(() => revokeGrant(victim.id, IDENTITIES.owner.subject, "left the project"));
    expect(second.code).toBe("conflict");
    expect(a.repos.revocations.listAfter(0).filter((r) => r.grantId === victim.id)).toHaveLength(1);
  });

  it("refuses a grant that belongs to another app exactly as it refuses an unknown one", () => {
    const mine = seedApp(a, { slug: "scope-mine" });
    const theirs = seedApp(a, { slug: "scope-theirs" });
    seedGrant(a, mine.id, IDENTITIES.owner, "owner");
    const elsewhere = seedGrant(a, theirs.id, IDENTITIES.viewer, "viewer");

    const foreign = denial(() => revokeGrant(elsewhere.id, IDENTITIES.owner.subject, "no", { appId: mine.id }));
    const missing = denial(() => revokeGrant(uuid(), IDENTITIES.owner.subject, "no", { appId: mine.id }));
    expect(foreign.code).toBe("not_found");
    expect(foreign.message).toBe(missing.message);
    expect(a.repos.grants.get(elsewhere.id)?.state).toBe("active");
  });
});

describe("a revoke is one transaction", () => {
  it("ends sessions, numbers the ledger, queues the copy and records the event together", () => {
    const app = seedApp(a, { slug: "revoke-tx" });
    seedGrant(a, app.id, IDENTITIES.owner, "owner");
    const grant = seedGrant(a, app.id, IDENTITIES.editor, "editor");
    const live = seedSession(a, app.id, IDENTITIES.editor, grant.id);
    const other = seedSession(a, app.id, IDENTITIES.editor, grant.id);

    const before = a.repos.revocations.maxSeq();
    const result = revokeGrant(grant.id, IDENTITIES.owner.subject, "left the project");

    expect(result.grant).toMatchObject({ state: "revoked", revokedReason: "left the project" });
    expect(result.sessionsTerminated).toBe(2);
    expect(result.revocation.seq).toBeGreaterThan(before);

    for (const session of [live, other])
      expect(a.repos.sessions.get(session.id)).toMatchObject({ terminatedReason: "revoked" });

    const queued = a.repos.outbox.getByKey(`revocation:${grant.id}:${result.revocation.seq}`);
    expect(queued).toMatchObject({ kind: "revocation_ledger", state: "pending" });
    expect(queued?.payload).toMatchObject({
      grantId: grant.id,
      subject: IDENTITIES.editor.subject,
      reason: "left the project",
    });

    const events = a.repos.events.listSince({ event: "grant.revoked", appId: app.id });
    expect(events).toHaveLength(1);
    // The subject is present only as a hash — never an id, never an email.
    expect(events[0].subjectHash).toBeTruthy();
    expect(JSON.stringify(events[0])).not.toContain(IDENTITIES.editor.subject);
    expect(JSON.stringify(events[0])).not.toContain(IDENTITIES.editor.email);
  });

  it("writes nothing at all when a later statement in the transaction fails", () => {
    const app = seedApp(a, { slug: "revoke-rollback" });
    seedGrant(a, app.id, IDENTITIES.owner, "owner");
    const grant = seedGrant(a, app.id, IDENTITIES.viewer, "viewer");
    const session = seedSession(a, app.id, IDENTITIES.viewer, grant.id);
    const seqBefore = a.repos.revocations.maxSeq();

    // A real failure inside the transaction, after the grant and the sessions
    // have already been written: the ledger append is made to abort.
    a.db.exec(
      "CREATE TRIGGER zenith_test_block_ledger BEFORE INSERT ON revocation_ledger " +
        "BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END"
    );
    try {
      expect(() => revokeGrant(grant.id, IDENTITIES.owner.subject, "left the project")).toThrow(
        /injected ledger failure/
      );
    } finally {
      a.db.exec("DROP TRIGGER zenith_test_block_ledger");
    }

    expect(a.repos.grants.get(grant.id)?.state).toBe("active");
    expect(a.repos.sessions.get(session.id)?.terminatedAt).toBeUndefined();
    expect(a.repos.revocations.maxSeq()).toBe(seqBefore);
    expect(a.repos.events.count({ event: "grant.revoked", appId: app.id })).toBe(0);
    expect(a.repos.outbox.listPending({ kinds: ["revocation_ledger"] }).some((e) =>
      e.idempotencyKey.includes(grant.id)
    )).toBe(false);

    // And the same call succeeds once the injected failure is gone.
    expect(revokeGrant(grant.id, IDENTITIES.owner.subject, "left the project").grant.state).toBe("revoked");
  });
});
