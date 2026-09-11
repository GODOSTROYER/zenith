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
 * The create and update suite additionally needs
 * `supabase/migrations/0004_hosted_app_data_atomic.sql`, which is what makes a
 * mutation one transaction. It is probed for once, with a call that cannot
 * write anything, and the suite skips with an instruction when it is absent —
 * an unapplied migration should read as "apply this", not as a dozen failures.
 * The whole-app suite at the bottom needs only 0003 and always runs.
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
import { type DataContext, type EquipmentRequest, HostedError } from "@/lib/hosted/contracts";
import { IDENTITIES } from "../_fixtures";
import { RELEASE_ID, input } from "./_helpers";

const { PgDataBackend, PgTrackerStore, hostedPgClient, logicalBytes, postgresOps } = await import(
  "@/lib/hosted/data"
);

const enabled =
  process.env.ZENITH_CONTRACT_POSTGRES === "1" &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

/** Ids are minted per run, so two runs in parallel cannot collide. */
const APP_A = `contract-${randomUUID()}`;
const APP_B = `contract-${randomUUID()}`;
const APP_C = `contract-${randomUUID()}`;
const MINTED = [APP_A, APP_B, APP_C];

/**
 * Is migration 0004 applied?
 *
 * Probed with a real call that cannot write anything: `app_record_update_atomic`
 * against a record id that does not exist returns `{"outcome":"not_found"}`
 * before it touches a table. A function that is not there answers PGRST202
 * instead, and the create/update suite below skips with an instruction rather
 * than failing every test with a schema-cache error.
 */
async function atomicFunctionsApplied(): Promise<boolean> {
  try {
    const { error } = await hostedPgClient().rpc("app_record_update_atomic", {
      p_app_id: APP_C,
      p_record_id: `probe-${randomUUID()}`,
      p_expected_version: 1,
      p_logical_bytes: 0,
      p_body: {},
      p_updated_at: new Date().toISOString(),
      p_limit_bytes: 0,
      p_subject: "migration-probe",
      p_write_id: `probe-${randomUUID()}`,
      p_intent_hash: "probe",
      p_status_code: 200,
      p_result: {},
      p_at: new Date().toISOString(),
    });
    return !error;
  } catch {
    return false;
  }
}

const atomicReady = enabled ? await atomicFunctionsApplied() : false;

if (enabled && !atomicReady) {
  console.warn(
    "[pg-contract.live] Skipping the create and update suite: supabase/migrations/0004_hosted_app_data_atomic.sql " +
      "is not applied to this project. Apply it in the Supabase SQL editor and re-run. The suites that only need " +
      "0003 (integrity, import, probe reset) still run."
  );
}

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

/**
 * Everything this file wrote, and nothing else: the ids were minted above and
 * every one of them starts with `contract-`, including their `::test` probe
 * namespaces. Both suites run it, because either can be the one that ran.
 */
async function cleanUpMintedRows(): Promise<void> {
  if (!enabled) return;
  const client = hostedPgClient();
  for (const appId of [...MINTED, ...MINTED.map((id) => `${id}::test`)]) {
    expect(appId.startsWith("contract-")).toBe(true);
    await client.from("app_writes").delete().eq("app_id", appId);
    await client.from("app_records").delete().eq("app_id", appId);
    await client.from("app_storage").delete().eq("app_id", appId);
  }
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

describe.skipIf(!enabled || !atomicReady)("the tracker contract against real Postgres tables", () => {
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

  afterAll(cleanUpMintedRows);

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

  it("commits the record, the counter and the ledger row together", async () => {
    const store = storeFor(APP_C);
    const writeId = randomUUID();
    const before = await store.storageBytes(APP_C);

    const created = await store.create(ctx("editor", APP_C), {
      writeId,
      record: input({ title: "Atomic", category: "laptop" }),
    });

    // All three, read straight off the tables rather than through the store.
    const client = hostedPgClient();
    const record = await client
      .from("app_records")
      .select("record_id,version,logical_bytes")
      .eq("app_id", APP_C)
      .eq("record_id", created.record.id);
    const ledger = await client
      .from("app_writes")
      .select("write_id,op,record_id,status_code")
      .eq("app_id", APP_C)
      .eq("write_id", writeId);
    const counter = await client.from("app_storage").select("logical_bytes").eq("app_id", APP_C);

    expect(record.data).toHaveLength(1);
    expect(ledger.data).toHaveLength(1);
    expect((ledger.data as { op: string; record_id: string; status_code: number }[])[0]).toMatchObject({
      op: "create",
      record_id: created.record.id,
      status_code: 201,
    });
    expect(Number((counter.data as { logical_bytes: number }[])[0].logical_bytes)).toBe(
      before + logicalBytes(created.record)
    );

    // …and the same again for an update: one transaction, one ledger row.
    const updateId = randomUUID();
    const updated = await store.update(ctx("editor", APP_C), created.record.id, {
      writeId: updateId,
      expectedVersion: 1,
      patch: { status: "approved", details: "y".repeat(120) },
    });
    const afterLedger = await client
      .from("app_writes")
      .select("write_id,op")
      .eq("app_id", APP_C)
      .eq("write_id", updateId);
    expect(afterLedger.data).toHaveLength(1);
    expect(await store.storageBytes(APP_C)).toBe(before + logicalBytes(updated.record));

    // The ledger row is what makes the retry a replay rather than a second
    // write, which is the whole point of them committing together.
    const replay = await store.update(ctx("editor", APP_C), created.record.id, {
      writeId: updateId,
      expectedVersion: 1,
      patch: { status: "approved", details: "y".repeat(120) },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(updated.record);
  });
});

/* ---------------------- what 0003 alone already backs ---------------------- */

/**
 * The paths that do not go through migration 0004's functions: the integrity
 * probe health and reopen ask for, the bulk import an export bundle is read
 * back through (it admits records one at a time through 0003's
 * `app_record_insert_within_quota`), and emptying a probe namespace. These run
 * whether or not 0004 is applied.
 */
describe.skipIf(!enabled)("the whole-app operations against real Postgres tables", () => {
  afterAll(cleanUpMintedRows);

  /** A stored record with the server-assigned fields an import carries. */
  const imported = (n: number): EquipmentRequest => ({
    id: `contract-import-${n}-${randomUUID()}`,
    ...input({ title: `Imported ${n}` }),
    version: 1,
    createdBy: IDENTITIES.editor.subject,
    createdByEmail: IDENTITIES.editor.email,
    createdAt: `2026-09-07T10:00:0${n}.000Z`,
    updatedBy: IDENTITIES.editor.subject,
    updatedByEmail: IDENTITIES.editor.email,
    updatedAt: `2026-09-07T10:00:0${n}.000Z`,
  });

  it("imports a bundle, skips ids already stored, and keeps the counter true", async () => {
    const backend = new PgDataBackend({ appId: APP_B });
    const store = new PgTrackerStore({ backend, appId: APP_B, limits: { storageBytes: 100_000 } });
    const ops = postgresOps(backend, store);
    const records = [imported(1), imported(2)];
    const quotaRefusal = (count: number): HostedError =>
      new HostedError("quota_exceeded", `would not fit (${count} imported)`, { fix: "raise the limit" });

    const before = await store.storageBytes(APP_B);
    const first = await ops.importRecords(records, { quotaRefusal });
    expect(first).toEqual({ imported: 2, skipped: [] });

    const expected = records.reduce((sum, record) => sum + logicalBytes(record), 0);
    expect(await store.storageBytes(APP_B)).toBe(before + expected);

    // Re-importing the same bundle writes nothing and reports why.
    const again = await ops.importRecords(records, { quotaRefusal });
    expect(again.imported).toBe(0);
    expect(again.skipped.map((skip) => skip.id).sort()).toEqual(records.map((r) => r.id).sort());
    expect(await store.storageBytes(APP_B)).toBe(before + expected);

    // …and the records came back as the records that went in.
    const read = await store.get(ctx("viewer", APP_B), records[0].id);
    expect(read).toEqual(records[0]);
  });

  it("reports the logical integrity check, and it passes on rows it just wrote", async () => {
    const backend = new PgDataBackend({ appId: APP_B });
    const store = new PgTrackerStore({ backend, appId: APP_B, limits: { storageBytes: 100_000 } });
    const verdict = await postgresOps(backend, store).integrity();

    expect(verdict.kind).toBe("logical");
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("Logical check");
    expect(await postgresOps(backend, store).countRecords()).toBeGreaterThan(0);
  });

  it("empties the probe namespace and leaves the app's own rows alone", async () => {
    const probeBackend = new PgDataBackend({ appId: `${APP_B}::test` });
    const probeStore = new PgTrackerStore({ backend: probeBackend, appId: APP_B });
    const probeOps = postgresOps(probeBackend, probeStore);

    const seeded = await probeOps.importRecords([imported(3)], {
      quotaRefusal: () => new HostedError("quota_exceeded", "would not fit", { fix: "raise the limit" }),
    });
    expect(seeded.imported).toBe(1);
    expect(await probeOps.countRecords()).toBe(1);

    const appRecordsBefore = await postgresOps(
      new PgDataBackend({ appId: APP_B }),
      new PgTrackerStore({ backend: new PgDataBackend({ appId: APP_B }), appId: APP_B })
    ).countRecords();

    const purged = await probeBackend.purgeTestNamespace();
    expect(purged.records).toBe(1);
    expect(await probeOps.countRecords()).toBe(0);

    // The app's own namespace is a different set of rows and was not touched.
    const after = await postgresOps(
      new PgDataBackend({ appId: APP_B }),
      new PgTrackerStore({ backend: new PgDataBackend({ appId: APP_B }), appId: APP_B })
    ).countRecords();
    expect(after).toBe(appRecordsBefore);
  });

  it("refuses to empty anything that is not a probe namespace", async () => {
    const error = await refusal(() => new PgDataBackend({ appId: APP_B }).purgeTestNamespace());
    expect(error.code).toBe("forbidden");
  });
});
