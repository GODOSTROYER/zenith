/**
 * The transaction contract: nothing is visible before COMMIT, everything is
 * visible after it, a throw leaves no trace, and a nested failure costs only
 * the nested work.
 *
 * Visibility is checked from a *second connection to the same file*, because
 * "the same connection can see its own uncommitted writes" would prove
 * nothing about what an acknowledgement means.
 *
 * Workstream W1 (hosted R3).
 */
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-authority-tx-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { seedApp, uuid } = await import("./_helpers");

const a = openAuthority();

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
  it("makes a write visible to another connection only after tx() returns", () => {
    let seenDuring = -1;
    const app = a.tx(() => {
      const created = a.repos.apps.insert({
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
    expect(a.repos.apps.get(app.id)?.slug).toBe("commit-order");
  });

  it("rolls back every table a failed transaction touched, outbox rows included", () => {
    const key = `rollback-${uuid()}`;
    expect(() =>
      a.tx(() => {
        const app = a.repos.apps.insert({
          id: uuid(),
          workspaceId: "ws-one",
          slug: "rolled-back",
          name: "Rolled back",
          createdBy: "founder",
          runtime: "local",
        });
        a.repos.outbox.enqueue({
          id: uuid(),
          idempotencyKey: key,
          kind: "invite_email",
          payload: { appId: app.id },
        });
        a.repos.events.append({
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
    ).toThrow(/the effect this transaction was about failed/);

    expect(appCount("rolled-back")).toBe(0);
    expect(outboxCount(key)).toBe(0);
    expect(a.repos.apps.getBySlug("rolled-back")).toBeNull();
    expect(a.repos.outbox.getByKey(key)).toBeNull();
    expect(a.repos.events.count()).toBe(0);
    expect(a.db.isTransaction).toBe(false);
  });
});

describe("nesting", () => {
  it("rolls a nested failure back to its savepoint and keeps the outer work", () => {
    const app = seedApp(a, { slug: "nested-outer" });

    const outcome = a.tx(() => {
      a.repos.apps.update(app.id, { name: "renamed by the outer transaction" });

      let innerFailed = false;
      try {
        a.tx(() => {
          a.repos.grants.insert({
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
      a.repos.apps.update(app.id, { state: "suspended", stateReason: "outer carried on" });
      return innerFailed;
    });

    expect(outcome).toBe(true);
    expect(a.repos.grants.get("grant-that-should-vanish")).toBeNull();
    expect(a.repos.apps.get(app.id)).toMatchObject({
      name: "renamed by the outer transaction",
      state: "suspended",
      stateReason: "outer carried on",
    });
    expect(appCount("nested-outer")).toBe(1);
  });

  it("discards the outer work too when the outer transaction fails after a nested one committed", () => {
    expect(() =>
      a.tx(() => {
        a.tx(() =>
          a.repos.apps.insert({
            id: uuid(),
            workspaceId: "ws-one",
            slug: "inner-committed",
            name: "Inner committed",
            createdBy: "founder",
            runtime: "local",
          })
        );
        throw new Error("outer failed after the nested step succeeded");
      })
    ).toThrow(/outer failed/);

    expect(appCount("inner-committed")).toBe(0);
    expect(a.db.isTransaction).toBe(false);
  });
});
