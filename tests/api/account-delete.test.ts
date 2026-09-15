/**
 * DELETE /api/account — the refusal, and the order of the irreversible half.
 *
 * The two things worth pinning: a workspace never loses its last admin to
 * somebody deleting themselves, and when the deletion does run, every door is
 * closed before the identity goes. An identity deleted first would leave live
 * grants naming a subject nobody can sign in as.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-account-", { fast: true });
// The reconcile pass asks the identity provider before it assumes anything, and
// `isSupabaseConfigured()` is what decides whether there is one to ask.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||= "publishable-test-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-test-key";
process.env.CRON_SECRET ||= "keepalive-test-secret";

const state = vi.hoisted(() => ({
  user: { id: "u-me", email: "me@example.com", name: "Mika" },
  /** every side effect, in the order it happened */
  order: [] as string[],
  grants: [] as { id: string }[],
  adminClients: 0,
  deleteUserError: null as { message: string } | null,
  /** what `getUserById` reports: the provider's answer to "is this gone?" */
  identity: "present" as "present" | "gone" | "unreachable",
  /** run inside `deleteUser`, so a test can read the journal mid-call */
  probe: null as (() => void) | null,
}));

vi.mock("@/lib/server/request", () => ({
  route: (a: unknown, b?: unknown) => (typeof a === "function" ? a : b),
  currentRequest: () => ({ user: state.user }),
  intParam: () => 0,
}));

vi.mock("@/lib/hosted/access", () => ({
  terminateAppSessionsForSubject: () => {
    state.order.push("sessions");
    return 3;
  },
  revokeGrant: (grantId: string) => {
    state.order.push(`revoke:${grantId}`);
  },
}));

vi.mock("@/lib/hosted/authority", () => ({
  authority: () => ({ repos: { grants: { listBySubject: () => state.grants } } }),
}));

/**
 * `cronRoute` boots the process before it runs its pass. Everything boot wires
 * up — the hosted authority, the engine, the alert evaluator — is mocked away
 * or irrelevant here, and what boot itself owes is pinned in
 * tests/api/internal-cron.test.ts. This suite is about the pass.
 */
vi.mock("@/lib/server/boot", () => ({
  ensureBoot: async () => undefined,
  securityModule: async () => ({}),
  logsimModule: async () => ({}),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminClients += 1;
    return {
      auth: {
        admin: {
          deleteUser: async () => {
            state.order.push("deleteUser");
            // Lets a test look at the journal from *inside* the irreversible
            // call, which is the only place the ordering claim is observable.
            state.probe?.();
            return { error: state.deleteUserError };
          },
          getUserById: async (id: string) => {
            state.order.push(`getUserById:${id}`);
            if (state.identity === "present") return { data: { user: { id } }, error: null };
            if (state.identity === "gone")
              return { data: { user: null }, error: { message: "User not found", status: 404 } };
            return { data: { user: null }, error: { message: "service unavailable", status: 503 } };
          },
        },
      },
    };
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signOut: async () => {
        state.order.push("signOut");
        return { error: null };
      },
    },
  }),
}));

const { DELETE } = await import("@/app/api/account/route");
const { GET: keepalive } = await import("@/app/api/internal/keepalive/route");
const { reconcilePendingAccountDeletionsAsync } = await import("@/lib/server/account");
const { appendAudit, db, readAudit, resetDb } = await import("@/lib/db/store");
const { resetPgClient } = await import("@/lib/db/postgres-store");
const { NextRequest } = await import("next/server");

const workspace = (id: string, name: string) => ({
  id,
  name,
  slug: id,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const member = (id: string, workspaceId: string, role: "admin" | "editor") => ({
  id,
  workspaceId,
  name: id,
  email: `${id}@example.com`,
  role,
});

const run = () => (DELETE as unknown as () => Promise<Response>)();

beforeEach(() => {
  state.order = [];
  state.grants = [];
  state.adminClients = 0;
  state.deleteUserError = null;
  state.identity = "present";
  state.probe = null;
  state.user = { id: "u-me", email: "me@example.com", name: "Mika" };
  resetDb({
    workspaces: [workspace("w-atlas", "Atlas")],
    members: [member("u-me", "w-atlas", "admin"), member("u-other", "w-atlas", "editor")],
  });
});

describe("deleting your own account", () => {
  it("refuses while you are the only admin, and names the workspace", async () => {
    await expect(run()).rejects.toMatchObject({
      status: 409,
      message: "You are the only admin of Atlas.",
      fix: "Make someone else an admin first from Settings → Members, then delete your account.",
    });
    expect(db().members).toHaveLength(2);
  });

  it("never constructs the service-role client on the refusal path", async () => {
    await expect(run()).rejects.toThrow();
    expect(state.adminClients).toBe(0);
    expect(state.order).toEqual([]);
  });

  it("fails closed in Product-Postgres mode before touching another authority", async () => {
    const previous = process.env.ZENITH_STORE;
    process.env.ZENITH_STORE = "postgres";
    try {
      await expect(run()).rejects.toMatchObject({
        status: 503,
        message: "Account deletion is unavailable while Product storage uses PostgreSQL.",
        fix: expect.stringContaining("No identity, grant, session or membership was changed."),
      });
      expect(state.adminClients).toBe(0);
      expect(state.order).toEqual([]);
      expect(db().members).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.ZENITH_STORE;
      else process.env.ZENITH_STORE = previous;
    }
  });

  it("names every workspace that would be left without an admin", async () => {
    db().workspaces.push(workspace("w-orbit", "Orbit"));
    db().members.push(member("u-me", "w-orbit", "admin"));
    await expect(run()).rejects.toMatchObject({
      message: "You are the only admin of Atlas and Orbit.",
    });
  });

  it("ends sessions and revokes grants before the identity is deleted", async () => {
    db().members[1].role = "admin";
    state.grants = [{ id: "g-1" }, { id: "g-2" }];

    const res = await run();
    expect(res.status).toBe(204);
    expect(state.order).toEqual([
      "sessions",
      "revoke:g-1",
      "revoke:g-2",
      "deleteUser",
      "signOut",
    ]);
    expect(state.adminClients).toBe(1);
    expect(db().settings.pendingAccountDeletions).toEqual([]);
  });

  it("resumes local cleanup from an identity-deleted journal without repeating provider calls", async () => {
    db().members[1].role = "admin";
    db().settings.pendingAccountDeletions = [
      {
        operationId: "op-recovery",
        user: state.user,
        stage: "identity-deleted",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];

    const res = await run();
    expect(res.status).toBe(204);
    expect(state.order).toEqual(["signOut"]);
    expect(db().members.map((m) => m.id)).toEqual(["u-other"]);
    expect(db().settings.pendingAccountDeletions).toEqual([]);
    expect(readAudit({ workspaceId: "w-atlas" })[0]?.id).toBe("op-recovery:workspace.removeMember:w-atlas");
  });

  it("finds a deterministic audit row that a busy workspace pushed off the newest page", async () => {
    db().members[1].role = "admin";
    const actor = { type: "user" as const, id: "u-me", name: "Mika" };
    const auditId = "op-busy:workspace.removeMember:w-atlas";

    // The first attempt's row did reach the log, and then the workspace kept
    // working. The retry's dedupe check used to read only the newest 500 rows,
    // so everything below this line was invisible to it and the reconcile pass
    // wrote a second row with the same id — which `FileStore.appendAudit`, with
    // no dedupe of its own, happily appended.
    appendAudit({
      ts: "2026-01-03T00:00:00.000Z",
      id: auditId,
      workspaceId: "w-atlas",
      actor,
      actionId: "workspace.removeMember",
      input: { memberId: "u-me", reason: "account.delete" },
      result: "ok",
      summary: "Mika deleted their Zenith account.",
    });
    for (let n = 0; n < 600; n++)
      appendAudit({
        ts: "2026-01-03T00:00:01.000Z",
        id: `noise-${n}`,
        workspaceId: "w-atlas",
        actor: { type: "system", id: "sys", name: "Zenith" },
        actionId: "deploy.apply",
        input: {},
        result: "ok",
        summary: "a busy workspace",
      });

    db().settings.pendingAccountDeletions = [
      {
        operationId: "op-busy",
        user: state.user,
        stage: "identity-deleted",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];

    const res = await run();
    expect(res.status).toBe(204);

    // Exactly one row with that id: the retry recognised the durable one
    // instead of duplicating it, and the deletion still completed.
    const removals = readAudit({
      workspaceId: "w-atlas",
      actionId: "workspace.removeMember",
      limit: 5000,
    });
    expect(removals.filter((event) => event.id === auditId)).toHaveLength(1);
    expect(removals).toHaveLength(1);
    expect(db().members.map((m) => m.id)).toEqual(["u-other"]);
  });

  it("removes the member row and the invites they issued, and records why", async () => {
    db().members[1].role = "admin";
    db().settings.invites = [
      { id: "i-1", workspaceId: "w-atlas", email: "new@example.com", role: "editor", createdBy: "u-me", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "i-2", workspaceId: "w-atlas", email: "other@example.com", role: "editor", createdBy: "u-other", createdAt: "2026-01-02T00:00:00.000Z" },
    ];

    await run();

    expect(db().members.map((m) => m.id)).toEqual(["u-other"]);
    expect((db().settings.invites as { id: string }[]).map((i) => i.id)).toEqual(["i-2"]);
    const audit = readAudit({ workspaceId: "w-atlas" });
    expect(audit).toHaveLength(1);
    expect(audit[0].actionId).toBe("workspace.removeMember");
    expect(audit[0].actor).toEqual({ type: "user", id: "u-me", name: "Mika" });
    expect(audit[0].summary).toContain("deleted their Zenith account");
  });

  it("says the doors are already shut when Supabase will not delete the sign-in", async () => {
    db().members[1].role = "admin";
    state.deleteUserError = { message: "service unavailable" };
    await expect(run()).rejects.toMatchObject({
      status: 502,
      message: "Your Zenith sign-in was not deleted: service unavailable",
    });
    expect(db().members.map((m) => m.id)).toEqual(["u-me", "u-other"]);
  });

  it("journals the attempt before the irreversible call, not after it", async () => {
    db().members[1].role = "admin";
    let stageInsideTheCall: string | undefined;
    state.probe = () => {
      const journal = db().settings.pendingAccountDeletions as { stage: string }[];
      stageInsideTheCall = journal[0]?.stage;
    };

    await run();

    // The window the journal exists for is the one *around* deleteUser, so the
    // entry has to be on this side of it to be answerable afterwards.
    expect(stageInsideTheCall).toBe("identity-delete-attempted");
  });

  it("leaves a retryable journal entry when the provider refuses", async () => {
    db().members[1].role = "admin";
    state.deleteUserError = { message: "service unavailable" };
    await expect(run()).rejects.toMatchObject({ status: 502 });

    const journal = db().settings.pendingAccountDeletions as { stage: string }[];
    expect(journal).toHaveLength(1);
    expect(journal[0].stage).toBe("identity-delete-attempted");
  });
});

/**
 * The crash window A-3 names: the process dies between `deleteUser` returning
 * 200 and the journal write landing. The identity is gone, the account's owner
 * cannot sign in to retry, and only a reconcile pass can finish the job — but
 * only if it can tell which side of the irreversible call the process died on.
 */
describe("resuming a deletion that crashed at the irreversible boundary", () => {
  /** What the store looks like after the crash: doors shut, members intact. */
  const crashedJournal = () => {
    db().members[1].role = "admin";
    db().settings.pendingAccountDeletions = [
      {
        operationId: "op-crash",
        user: state.user,
        stage: "identity-delete-attempted",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
  };

  it("completes local cleanup when the provider says the identity is gone", async () => {
    crashedJournal();
    state.identity = "gone";

    const completed = await reconcilePendingAccountDeletionsAsync();

    expect(completed).toBe(1);
    expect(state.order).toEqual(["getUserById:u-me"]);
    // It asked; it did not re-run the irreversible call.
    expect(state.order).not.toContain("deleteUser");
    expect(db().members.map((m) => m.id)).toEqual(["u-other"]);
    expect(db().settings.pendingAccountDeletions).toEqual([]);
    expect(readAudit({ workspaceId: "w-atlas" })[0]?.id).toBe(
      "op-crash:workspace.removeMember:w-atlas"
    );
  });

  it("changes nothing when the identity is still there", async () => {
    crashedJournal();
    state.identity = "present";

    const completed = await reconcilePendingAccountDeletionsAsync();

    expect(completed).toBe(0);
    expect(state.order).toEqual(["getUserById:u-me"]);
    expect(state.order).not.toContain("deleteUser");
    // The account is whole and its owner can still retry: nothing was removed
    // and the entry is kept rather than resolved by guesswork.
    expect(db().members.map((m) => m.id)).toEqual(["u-me", "u-other"]);
    const journal = db().settings.pendingAccountDeletions as { stage: string }[];
    expect(journal[0].stage).toBe("identity-delete-attempted");
    expect(readAudit({ workspaceId: "w-atlas" })).toHaveLength(0);
  });

  it("assumes nothing when the provider cannot be asked", async () => {
    crashedJournal();
    state.identity = "unreachable";

    expect(await reconcilePendingAccountDeletionsAsync()).toBe(0);
    expect(db().members.map((m) => m.id)).toEqual(["u-me", "u-other"]);
    const journal = db().settings.pendingAccountDeletions as { stage: string }[];
    expect(journal[0].stage).toBe("identity-delete-attempted");
  });

  it("still finishes an entry that already reached identity-deleted", async () => {
    db().members[1].role = "admin";
    db().settings.pendingAccountDeletions = [
      {
        operationId: "op-confirmed",
        user: state.user,
        stage: "identity-deleted",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];

    expect(await reconcilePendingAccountDeletionsAsync()).toBe(1);
    // No probe needed: the provider already answered once, durably.
    expect(state.order).toEqual([]);
    expect(db().members.map((m) => m.id)).toEqual(["u-other"]);
  });
});

/**
 * A-5: the cron pass runs the same local cleanup `DELETE /api/account` refuses
 * on Product-Postgres. It has to fail closed the same way, or the refusal is
 * only a refusal of the front door.
 */
describe("the keepalive reconcile pass", () => {
  /**
   * `inCronScope()` primes a real snapshot on Postgres, so the pass needs a
   * client that answers. An empty project is enough — what is under test is
   * whether the reconcile runs at all, and an empty snapshot makes it obvious
   * that nothing the pass did came from Postgres.
   */
  const emptyProject = () => {
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "in", "or", "eq", "like", "order", "limit"])
      builder[name] = () => builder;
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [], error: null, count: 0 }));
    return { from: () => builder } as never;
  };

  const tick = (): Promise<Response> =>
    (keepalive as unknown as (req: InstanceType<typeof NextRequest>) => Promise<Response>)(
      new NextRequest("http://zenith.test/api/internal/keepalive", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      })
    );

  it("runs the reconcile on the file store", async () => {
    db().members[1].role = "admin";
    db().settings.pendingAccountDeletions = [
      {
        operationId: "op-tick",
        user: state.user,
        stage: "identity-deleted",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];

    const body = (await (await tick()).json()) as {
      accountDeletionsReconciled: number;
      accountDeletionReconcile: string;
    };
    expect(body.accountDeletionReconcile).toBe("ran");
    expect(body.accountDeletionsReconciled).toBe(1);
    expect(db().members.map((m) => m.id)).toEqual(["u-other"]);
  });

  it("fails closed in Product-Postgres mode, like the DELETE route", async () => {
    db().members[1].role = "admin";
    db().settings.pendingAccountDeletions = [
      {
        operationId: "op-tick-pg",
        user: state.user,
        stage: "identity-deleted",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];

    const previous = process.env.ZENITH_STORE;
    process.env.ZENITH_STORE = "postgres";
    resetPgClient(emptyProject());
    try {
      const body = (await (await tick()).json()) as {
        accountDeletionsReconciled: number;
        accountDeletionReconcile: string;
      };
      expect(body.accountDeletionReconcile).toBe("refused-postgres");
      expect(body.accountDeletionsReconciled).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ZENITH_STORE;
      else process.env.ZENITH_STORE = previous;
      resetPgClient();
    }

    // The reconcile never ran: it asked the identity provider nothing and it
    // wrote no `workspace.removeMember` row, which is the durable half of the
    // cleanup the DELETE route refuses.
    expect(state.order).toEqual([]);
    expect(readAudit({ workspaceId: "w-atlas" })).toHaveLength(0);
    // …and the membership this process holds is untouched, which is now a real
    // assertion rather than a caveat. A1 could only assert the audit log here:
    // `loadSnapshot` adopted its rows into the file store's one process-global
    // graph (A-1), so the cron pass's empty fake project emptied the graph this
    // test was holding. A snapshot owns its graph now, so an empty Postgres
    // project cannot reach into the file store's rows at all.
    expect(db().members.map((m) => m.id)).toEqual(["u-me", "u-other"]);
  });
});
