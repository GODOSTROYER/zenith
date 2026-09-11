/**
 * The LIVE contract check: the tracker's scenario run against the real
 * `hosted.*` tables in Supabase.
 *
 * Skipped unless all three are set:
 *
 *   ZENITH_CONTRACT_POSTGRES=1
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * …and it also needs `supabase/migrations/0003_hosted_app_data.sql` applied and
 * `hosted` added to the project's exposed schemas (Settings → API). When the
 * tables are not reachable the preflight below fails with that instruction
 * rather than with a wall of PostgREST errors, so a red run says what to do.
 *
 * Why it exists: `pg-backend.test.ts` pins the requests `PgDataBackend` builds,
 * which is the half a double can check. Whether *Postgres* agrees — that
 * `version = eq.<expected>` really refuses the second writer, that the quota
 * function really admits under one lock, that a jsonb `body` really comes back
 * as the record that went in — only a real database can answer.
 *
 * Every app id it uses starts with `contract-`, and `afterAll` deletes every row
 * under those ids. It never touches an app id it did not mint.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DataContext, HostedError } from "@/lib/hosted/contracts";
import { IDENTITIES } from "../_fixtures";
import { RELEASE_ID, input } from "./_helpers";

const { PgDataBackend, PgTrackerStore, hostedPgClient, logicalBytes } = await import(
  "@/lib/hosted/data"
);

const enabled =
  process.env.ZENITH_CONTRACT_POSTGRES === "1" &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

/** Ids are minted per run, so two runs in parallel cannot collide. */
const APP_A = `contract-${randomUUID()}`;
const APP_B = `contract-${randomUUID()}`;
const MINTED = [APP_A, APP_B];

function ctx(role: DataContext["role"], appId: string): DataContext {
  return {
    appId,
    subject: IDENTITIES.editor.subject,
    email: IDENTITIES.editor.email,
    role,
    releaseId: RELEASE_ID,
  };
}

function storeFor(appId: string, storageBytes = 100_000) {
  return new PgTrackerStore({
    backend: new PgDataBackend({ appId }),
    appId,
    limits: { storageBytes },
  });
}

async function refusal(fn: () => Promise<unknown>): Promise<HostedError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof HostedError) return error;
    throw error;
  }
  throw new Error("expected a HostedError, but the call succeeded");
}

describe.skipIf(!enabled)("the tracker contract against real Postgres tables", () => {
  beforeAll(async () => {
    // Preflight: one read that proves the schema is applied AND exposed.
    const probe = await storeFor(APP_A)
      .storageBytes(APP_A)
      .catch((error: unknown) => error);
    if (probe instanceof HostedError) {
      throw new Error(
        `The hosted app-data tables are not reachable, so this live contract run cannot start.\n` +
          `${probe.message}\n${probe.fix}`
      );
    }
  });

  afterAll(async () => {
    if (!enabled) return;
    // Everything this file wrote, and nothing else: the ids were minted above
    // and every one of them starts with `contract-`.
    const client = hostedPgClient();
    for (const appId of [...MINTED, ...MINTED.map((id) => `${id}::test`)]) {
      expect(appId.startsWith("contract-")).toBe(true);
      await client.from("app_writes").delete().eq("app_id", appId);
      await client.from("app_records").delete().eq("app_id", appId);
      await client.from("app_storage").delete().eq("app_id", appId);
    }
  });

  it("creates, reads back and pages the records it stored", async () => {
    const store = storeFor(APP_A);
    const first = await store.create(ctx("editor", APP_A), {
      writeId: randomUUID(),
      record: input({ title: "Standing desk", status: "requested", category: "furniture" }),
    });
    // The page order is (created_at desc, id desc); a shared millisecond ties.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.create(ctx("editor", APP_A), {
      writeId: randomUUID(),
      record: input({ title: "Monitor", status: "approved", category: "monitor" }),
    });

    expect(first.replayed).toBe(false);
    expect(await store.get(ctx("viewer", APP_A), first.record.id)).toEqual(first.record);

    const page = await store.list(ctx("viewer", APP_A), { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(second.record.id); // newest first
    expect(page.nextCursor).toBeDefined();

    const next = await store.list(ctx("viewer", APP_A), { limit: 1, cursor: page.nextCursor! });
    expect(next.items[0].id).toBe(first.record.id);
    expect(next.nextCursor).toBeUndefined();

    const filtered = await store.list(ctx("viewer", APP_A), { status: "approved", limit: 10 });
    expect(filtered.items.map((item) => item.id)).toEqual([second.record.id]);

    const byCategory = await store.list(ctx("viewer", APP_A), { category: "furniture", limit: 10 });
    expect(byCategory.items.map((item) => item.id)).toEqual([first.record.id]);
  });

  it("lets the first writer through and refuses the second with stale_version", async () => {
    const store = storeFor(APP_A);
    const created = await store.create(ctx("editor", APP_A), {
      writeId: randomUUID(),
      record: input({ title: "Keyboard", category: "peripheral" }),
    });

    const updated = await store.update(ctx("editor", APP_A), created.record.id, {
      writeId: randomUUID(),
      expectedVersion: 1,
      patch: { status: "approved" },
    });
    expect(updated.record.version).toBe(2);
    expect(updated.record.status).toBe("approved");
    expect(updated.record.title).toBe("Keyboard"); // the untouched half of the jsonb survived

    const error = await refusal(() =>
      store.update(ctx("editor", APP_A), created.record.id, {
        writeId: randomUUID(),
        expectedVersion: 1,
        patch: { status: "ordered" },
      })
    );
    expect(error.code).toBe("stale_version");

    const now = await store.get(ctx("viewer", APP_A), created.record.id);
    expect(now?.status).toBe("approved"); // the loser wrote nothing
  });

  it("replays a retried write id instead of writing a second record", async () => {
    const store = storeFor(APP_A);
    const writeId = randomUUID();
    const body = { writeId, record: input({ title: "Docking station", category: "peripheral" }) };

    const first = await store.create(ctx("editor", APP_A), body);
    const again = await store.create(ctx("editor", APP_A), body);

    expect(again.replayed).toBe(true);
    expect(again.record).toEqual(first.record);

    const conflict = await refusal(() =>
      store.create(ctx("editor", APP_A), { writeId, record: input({ title: "Something else" }) })
    );
    expect(conflict.code).toBe("idempotency_conflict");
  });

  it("refuses a record that would take the app past its storage ceiling, and writes nothing", async () => {
    const tiny = storeFor(APP_B, 1);
    const error = await refusal(() =>
      tiny.create(ctx("editor", APP_B), { writeId: randomUUID(), record: input() })
    );

    expect(error.code).toBe("quota_exceeded");
    expect(error.message).toContain("logical bytes: the UTF-8 JSON size");
    expect(await tiny.storageBytes(APP_B)).toBe(0);
    expect((await tiny.list(ctx("viewer", APP_B), { limit: 10 })).items).toEqual([]);
  });

  it("keeps one app's records out of another app's reach", async () => {
    const a = storeFor(APP_A);
    const b = storeFor(APP_B);
    const mine = await a.create(ctx("editor", APP_A), {
      writeId: randomUUID(),
      record: input({ title: "Only in app A" }),
    });

    expect(await b.get(ctx("viewer", APP_B), mine.record.id)).toBeNull();
    expect((await b.list(ctx("viewer", APP_B), { limit: 50 })).items).toEqual([]);
  });

  it("accounts storage as the same logical-byte figure the measure defines", async () => {
    const store = storeFor(APP_A);
    const before = await store.storageBytes(APP_A);
    const created = await store.create(ctx("editor", APP_A), {
      writeId: randomUUID(),
      record: input({ title: "Accounted", details: "x".repeat(200) }),
    });

    expect(await store.storageBytes(APP_A)).toBe(before + logicalBytes(created.record));
  });
});
