/**
 * The transaction contract: nothing is visible before COMMIT, everything is
 * visible after it, a throw leaves no trace, a nested failure costs only the
 * nested work, and two awaited transactions never interleave.
 *
 * Visibility is checked from a *second connection to the same file*, because
 * "the same connection can see its own uncommitted writes" would prove
 * nothing about what an acknowledgement means.
 */
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-tx-");

const { closeAuthority, openAuthority, sqliteConnection } = await import("@/lib/hosted/authority");
const { seedApp, uuid } = await import("./_helpers");

const a = openAuthority();
const db = sqliteConnection(a);

/** A separate connection, so "visible" means visible to somebody else. */
let observer: DatabaseSync;

beforeAll(() => {
  observer = new DatabaseSync(a.path, { readOnly: true });
  observer.exec("PRAGMA busy_timeout = 2000;");
});

afterAll(() => {
  observer.close();
  closeAuthority();
  removeDir(dataDir);
});

const appCount = (slug: string): number =>
  Number(observer.prepare("SELECT COUNT(*) AS n FROM apps WHERE slug = ?").get(slug)?.n ?? -1);

const outboxCount = (key: string): number =>
  Number(
    observer.prepare("SELECT COUNT(*) AS n FROM hosted_outbox WHERE idempotency_key = ?").get(key)?.n ??
      -1
  );

describe("commit before acknowledgement", () => {
  it("makes a write visible to another connection only after tx() resolves", async () => {
    let seenDuring = -1;
    const app = await a.tx(async (repos) => {
      const created = await repos.apps.insert({
        id: uuid(),
        workspaceId: "ws-one",
        slug: "commit-order",
        name: "Commit order",
        createdBy: "founder",
        runtime: "local",
      });
      // Inside the transaction the other connection must still see nothing.
      seenDuring = appCount("commit-order");
      return created;
    });

    expect(seenDuring).toBe(0);
    expect(appCount("commit-order")).toBe(1);
    expect((await a.repos.apps.get(app.id))?.slug).toBe("commit-order");
  });

  it("rolls back every table a failed transaction touched, outbox rows included", async () => {
    const key = `rollback-${uuid()}`;
    await expect(
      a.tx(async (repos) => {
        const app = await repos.apps.insert({
          id: uuid(),
          workspaceId: "ws-one",
          slug: "rolled-back",
          name: "Rolled back",
          createdBy: "founder",
          runtime: "local",
        });
        await repos.outbox.enqueue({
          id: uuid(),
          idempotencyKey: key,
          kind: "invite_email",
          payload: { appId: app.id },
        });
        await repos.events.append({
          id: uuid(),
          event: "app.created",
          workspaceId: "ws-one",
          appId: app.id,
          outcome: "ok",
          assisted: false,
          actorClass: "test",
        });
        throw new Error("the effect this transaction was about failed");
      })
    ).rejects.toThrow(/the effect this transaction was about failed/);

    expect(appCount("rolled-back")).toBe(0);
    expect(outboxCount(key)).toBe(0);
    expect(await a.repos.apps.getBySlug("rolled-back")).toBeNull();
    expect(await a.repos.outbox.getByKey(key)).toBeNull();
    expect(await a.repos.events.count()).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it("autocommits a repository call made outside tx(), one statement at a time", async () => {
    const id = uuid();
    // No tx() anywhere: the insert is its own transaction and is durable the
    // moment it resolves, which the second connection is what proves.
    const app = await a.repos.apps.insert({
      id,
      workspaceId: "ws-one",
      slug: "autocommitted",
      name: "Autocommitted",
      createdBy: "founder",
      runtime: "local",
    });

    expect(app.id).toBe(id);
    expect(appCount("autocommitted")).toBe(1);
    expect(db.isTransaction).toBe(false);

    // And the next call is a separate transaction, not a continuation of it.
    await a.repos.apps.update(id, { name: "Renamed on its own" });
    expect(
      observer.prepare("SELECT name FROM apps WHERE id = ?").get(id)
    ).toMatchObject({ name: "Renamed on its own" });
  });
});

describe("nesting", () => {
  it("rolls a nested failure back to its savepoint and keeps the outer work", async () => {
    const app = await seedApp(a, { slug: "nested-outer" });

    const outcome = await a.tx(async (repos) => {
      await repos.apps.update(app.id, { name: "renamed by the outer transaction" });

      let innerFailed = false;
      try {
        await a.tx(async (inner) => {
          await inner.grants.insert({
            id: "grant-that-should-vanish",
            appId: app.id,
            subject: "someone",
            email: "someone@example.test",
            role: "owner",
            grantedBy: "founder",
          });
          throw new Error("inner step failed");
        });
      } catch {
        innerFailed = true;
      }

      // The outer transaction is still alive and can keep working.
      await repos.apps.update(app.id, { state: "suspended", stateReason: "outer carried on" });
      return innerFailed;
    });

    expect(outcome).toBe(true);
    expect(await a.repos.grants.get("grant-that-should-vanish")).toBeNull();
    expect(await a.repos.apps.get(app.id)).toMatchObject({
      name: "renamed by the outer transaction",
      state: "suspended",
      stateReason: "outer carried on",
    });
    expect(appCount("nested-outer")).toBe(1);
  });

  it("keeps only the work of the savepoint that failed, at two levels deep", async () => {
    const app = await seedApp(a, { slug: "nested-deep" });

    await a.tx(async (repos) => {
      await repos.apps.update(app.id, { name: "level one" });
      await a.tx(async () => {
        // Level two commits.
        await a.repos.grants.insert({
          id: "grant-level-two",
          appId: app.id,
          subject: "level-two",
          email: "two@example.test",
          role: "viewer",
          grantedBy: "founder",
        });
        // Level three does not, and takes nothing else with it.
        await expect(
          a.tx(async (three) => {
            await three.grants.insert({
              id: "grant-level-three",
              appId: app.id,
              subject: "level-three",
              email: "three@example.test",
              role: "viewer",
              grantedBy: "founder",
            });
            throw new Error("level three failed");
          })
        ).rejects.toThrow(/level three failed/);
      });
    });

    expect(await a.repos.grants.get("grant-level-two")).not.toBeNull();
    expect(await a.repos.grants.get("grant-level-three")).toBeNull();
    expect((await a.repos.apps.get(app.id))?.name).toBe("level one");
  });

  it("uses the open transaction for authority().repos rather than deadlocking on it", async () => {
    // The mistake the migration note warns about: reaching for the authority's
    // own repositories inside a tx() callback. It joins the transaction — and
    // is discarded with it — instead of waiting for a mutex its caller holds.
    await expect(
      a.tx(async () => {
        await a.repos.apps.insert({
          id: uuid(),
          workspaceId: "ws-one",
          slug: "joined-the-transaction",
          name: "Joined the transaction",
          createdBy: "founder",
          runtime: "local",
        });
        expect(appCount("joined-the-transaction")).toBe(0);
        throw new Error("discard it");
      })
    ).rejects.toThrow(/discard it/);

    expect(appCount("joined-the-transaction")).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it("discards the outer work too when the outer transaction fails after a nested one committed", async () => {
    await expect(
      a.tx(async (repos) => {
        await a.tx((inner) =>
          inner.apps.insert({
            id: uuid(),
            workspaceId: "ws-one",
            slug: "inner-committed",
            name: "Inner committed",
            createdBy: "founder",
            runtime: "local",
          })
        );
        await repos.apps.getBySlug("inner-committed");
        throw new Error("outer failed after the nested step succeeded");
      })
    ).rejects.toThrow(/outer failed/);

    expect(appCount("inner-committed")).toBe(0);
    expect(db.isTransaction).toBe(false);
  });
});

describe("the transaction mutex", () => {
  it("runs two overlapping tx() calls strictly one after the other, and commits both", async () => {
    // Each callback yields in the middle — the exact moment a second
    // transaction on one connection would slip its statements in between this
    // one's BEGIN and COMMIT.
    const order: string[] = [];
    const half = async (name: string, slug: string): Promise<void> => {
      await a.tx(async (repos) => {
        order.push(`${name}:begin`);
        await repos.apps.insert({
          id: uuid(),
          workspaceId: "ws-one",
          slug,
          name,
          createdBy: "founder",
          runtime: "local",
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Nobody else may have written inside this transaction's window.
        order.push(`${name}:end`);
      });
      order.push(`${name}:committed`);
    };

    await Promise.all([half("first", "mutex-one"), half("second", "mutex-two")]);

    // Strictly serial: one whole transaction, then the other. Never
    // first:begin, second:begin, ...
    expect(order).toEqual([
      "first:begin",
      "first:end",
      "first:committed",
      "second:begin",
      "second:end",
      "second:committed",
    ]);
    expect(appCount("mutex-one")).toBe(1);
    expect(appCount("mutex-two")).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it("lets the next transaction run after one of them throws", async () => {
    const results: string[] = [];
    const failing = a
      .tx(async (repos) => {
        await repos.apps.insert({
          id: uuid(),
          workspaceId: "ws-one",
          slug: "mutex-failed",
          name: "Mutex failed",
          createdBy: "founder",
          runtime: "local",
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("the first one failed");
      })
      .then(
        () => results.push("failing:resolved"),
        () => results.push("failing:rejected")
      );
    const following = a
      .tx(async (repos) => {
        await repos.apps.insert({
          id: uuid(),
          workspaceId: "ws-one",
          slug: "mutex-after-failure",
          name: "Mutex after failure",
          createdBy: "founder",
          runtime: "local",
        });
      })
      .then(() => results.push("following:resolved"));

    await Promise.all([failing, following]);

    expect(results).toEqual(["failing:rejected", "following:resolved"]);
    expect(appCount("mutex-failed")).toBe(0);
    expect(appCount("mutex-after-failure")).toBe(1);
  });

  it("queues a bare repository call behind a transaction that is already open", async () => {
    const order: string[] = [];
    const transaction = a.tx(async (repos) => {
      order.push("tx:begin");
      await repos.apps.insert({
        id: uuid(),
        workspaceId: "ws-one",
        slug: "mutex-queued-tx",
        name: "Queued tx",
        createdBy: "founder",
        runtime: "local",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("tx:end");
    });
    const bare = a.repos.apps
      .insert({
        id: uuid(),
        workspaceId: "ws-one",
        slug: "mutex-queued-bare",
        name: "Queued bare",
        createdBy: "founder",
        runtime: "local",
      })
      .then(() => order.push("bare:done"));

    await Promise.all([transaction, bare]);

    expect(order).toEqual(["tx:begin", "tx:end", "bare:done"]);
    expect(appCount("mutex-queued-tx")).toBe(1);
    expect(appCount("mutex-queued-bare")).toBe(1);
  });
});
