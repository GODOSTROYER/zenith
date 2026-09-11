/**
 * The one-shot hosted migration, `scripts/migrate-hosted-to-postgres.ts`.
 *
 * The script's job is to move a hosted SQLite install into Postgres exactly
 * once and to be safe to run again. Everything asserted here is one of those
 * two properties:
 *
 *  1. **Order.** `apps` goes in before `releases`, with `active_release_id`
 *     NULL, and the pointer is patched once the releases exist —
 *     `apps.active_release_id` and `releases.app_id` reference each other and
 *     Postgres, unlike SQLite, resolves that at insert time.
 *  2. **Idempotence.** Every insert carries `on conflict … do nothing`, so a
 *     second run inserts nothing; `hosted.app_storage` is the deliberate
 *     exception and is an upsert, because it is a derived total.
 *  3. **The three conversions the two schemas do not share.**
 *     `hosted_events.assisted` is 0/1 on SQLite and a boolean in Postgres,
 *     `invite_deliveries.sealed_payload` is a BLOB and a `bytea`, and
 *     `revocation_ledger.seq` is `AUTOINCREMENT` on one side and `generated
 *     always as identity` on the other — so it has to be inserted `overriding
 *     system value` or the ledger renumbers itself, which is exactly what the
 *     off-host reconciliation cannot survive.
 *  4. **Per-app data.** `body` is the tracker record, and `hosted.app_storage`
 *     is the *recomputed* sum of `logical_bytes` — a drifted SQLite counter is
 *     reported, not carried across.
 *  5. **Artifacts.** What is on disk is uploaded, what the bucket already has
 *     is skipped, and what the control database names but the disk has lost is
 *     a warning rather than a failure.
 *
 * The fixture is a **real** SQLite install: the real authority, the real
 * repositories, the real `openAppData` store and the real `FsArtifactStore`
 * write it. Only the two destinations are doubles — a postgres.js tag that
 * records statements instead of sending them, and an artifact target that
 * remembers what it was asked to upload — so what is asserted is the SQL the
 * script decides on, which is the whole of what it decides.
 *
 * The second suite runs the same script against the **real** Supabase project,
 * and only when `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL` are both
 * set. It writes under the `contract-` namespace `_factories.ts` owns, asserts
 * `--verify` passes and that a second run inserts nothing, and deletes exactly
 * what it wrote.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-p2b-hosted-migrate-", { fast: true });
const ARTIFACT_DIR = path.join(DATA, "artifacts");

// The fixture is a SQLite install whatever the ambient .env.local says — the
// live suite below sources it, and `postgres` there would make `openAppData`
// build a PgDataBackend instead of the file this script has to read.
process.env.ZENITH_HOSTED_STORE = "sqlite";

const authority = await import("@/lib/hosted/authority");
const artifactsLib = await import("@/lib/hosted/artifacts");
const contracts = await import("@/lib/hosted/contracts");
const hostedData = await import("@/lib/hosted/data");
const factories = await import("../hosted/authority/contract/_factories");
const script = await import("../../scripts/migrate-hosted-to-postgres");

const { contractHex, contractId, CONTRACT_PREFIX, postgresContractEnabled, postgresSkipReason } =
  factories;

const OWNER = "11111111-1111-4111-8111-111111111111";

/* ------------------------------- the fixture ------------------------------- */

/** Everything the seed created that a test or a cleanup needs to name. */
interface Fixture {
  appId: string;
  /** A second app the control database knows and the filesystem does not. */
  appWithoutData: string;
  releaseId: string;
  /** The artifact that really is on disk, under its real content address. */
  presentDigest: string;
  /** An artifacts row whose bytes are not in the artifact directory. */
  absentDigest: string;
  /** The equipment request the app's own store wrote. */
  recordId: string;
  /** The sum of `logical_bytes` over that app's rows. */
  logicalBytes: number;
  /** The wrong figure left in the SQLite counter on purpose. */
  counter: number;
  /** The bytes stored in `invite_deliveries.sealed_payload`. */
  sealed: Uint8Array;
}

let fixture: Fixture;

/** A believable build output, so the artifact store has something real to key. */
function outputTree(): string {
  const dir = path.join(DATA, "build-output");
  const files: Record<string, string> = {
    "index.html": "<!doctype html><title>Tracker</title>",
    "assets/index-abc.js": "console.log('tracker')",
  };
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

const provenanceFor = (jobId: string): import("@/lib/hosted/contracts").ArtifactProvenance => ({
  sourceDigest: "a".repeat(64),
  sourceKind: "tarball",
  jobId,
  recipe: contracts.RECIPE_V1,
  contractVersion: 1,
  schemaVersion: 1,
  builtBy: "recipe-local",
  buildBoundary: "test fixture: no build ran",
  builtAt: new Date().toISOString(),
});

/**
 * Write one complete little install: a control database, one app's data file
 * and one artifact on disk.
 *
 * Every id is inside this run's `contract-` namespace, so the live suite's
 * cleanup deletes exactly these rows and nothing else. The two 64-hex columns
 * (`token_hash`, and the absent artifact's digest) use the hex namespace for
 * the same reason.
 */
async function seed(): Promise<Fixture> {
  const a = await authority.openAuthority();

  const appId = contractId("app");
  const appWithoutData = contractId("app-nodata");
  const jobId = contractId("job");
  const inviteId = contractId("invite");
  const resendId = contractId("resend");

  const fsStore = new artifactsLib.FsArtifactStore(ARTIFACT_DIR);
  const stored = await fsStore.put(outputTree(), provenanceFor(jobId));
  const absentDigest = contractHex();

  const releaseId = contractId("release");

  await a.tx(async (repos) => {
    await repos.apps.insert({
      id: appId,
      workspaceId: "ws-one",
      slug: `p2b-${appId.slice(-8)}`,
      name: "P2b tracker",
      createdBy: OWNER,
      runtime: "local",
    });
    // Registered, never opened: an app whose data file was never created is
    // the ordinary case for one that has not been published yet.
    await repos.apps.insert({
      id: appWithoutData,
      workspaceId: "ws-one",
      slug: `p2b-${appWithoutData.slice(-8)}`,
      name: "P2b tracker, never opened",
      createdBy: OWNER,
      runtime: "local",
    });
    await repos.artifacts.insert({
      digest: stored.digest,
      byteSize: stored.byteSize,
      fileCount: stored.fileCount,
      provenance: stored.provenance,
    });
    await repos.artifacts.insert({
      digest: absentDigest,
      byteSize: 10,
      fileCount: 1,
      provenance: provenanceFor(jobId),
    });
    await repos.releases.insert({
      id: releaseId,
      appId,
      number: 1,
      artifactDigest: stored.digest,
      jobId,
      runtime: "local",
    });
    await repos.apps.setActiveRelease(appId, releaseId, 0);

    const grantId = contractId("grant");
    await repos.grants.insert({
      id: grantId,
      appId,
      subject: OWNER,
      email: "owner@example.test",
      role: "owner",
      grantedBy: OWNER,
    });
    await repos.invites.insert({
      id: inviteId,
      appId,
      email: "invitee@example.test",
      role: "viewer",
      tokenHash: contractHex(),
      createdBy: OWNER,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // A resend, so `app_invites.supersedes` — the table's self reference —
    // actually has a value to defer and patch.
    await repos.invites.insert({
      id: resendId,
      appId,
      email: "invitee@example.test",
      role: "viewer",
      tokenHash: contractHex(),
      createdBy: OWNER,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      supersedes: inviteId,
    });
    await repos.events.append({
      id: contractId("event"),
      event: "app.created",
      workspaceId: "ws-one",
      appId,
      outcome: "ok",
      assisted: true,
      actorClass: "founder",
    });
    await repos.revocations.append({
      appId,
      grantId,
      subject: OWNER,
      by: OWNER,
      reason: "fixture",
    });
  });

  const sealed = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
  await a.tx((repos) =>
    repos.deliveries.insert({ id: contractId("delivery"), inviteId, sealedPayload: sealed })
  );

  // The app's own data, written by the app's own store.
  const { store } = hostedData.openAppData(appId);
  const created = await store.create(
    {
      appId,
      subject: OWNER,
      email: "owner@example.test",
      role: "owner",
      releaseId,
    },
    {
      writeId: crypto.randomUUID(),
      record: { title: "Standing desk", category: "furniture", quantity: 2 },
    }
  );
  hostedData.closeAppData(appId);

  await authority.closeAuthority();

  // Read the true sum back, then leave a *wrong* running counter behind: the
  // script must recompute and say so rather than copy the drift across.
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(DATA, "apps", encodeURIComponent(appId), hostedData.APP_DATA_FILENAMES.data);
  const db = new DatabaseSync(file);
  const sum = Number(
    (db.prepare("SELECT COALESCE(SUM(logical_bytes), 0) AS total FROM equipment_requests").get() as {
      total: number;
    }).total
  );
  const counter = sum + 4096;
  db.prepare("UPDATE storage SET logical_bytes = ? WHERE id = 1").run(counter);
  db.close();

  return {
    appId,
    appWithoutData,
    releaseId,
    presentDigest: stored.digest,
    absentDigest,
    recordId: created.record.id,
    logicalBytes: sum,
    counter,
    sealed,
  };
}

beforeAll(async () => {
  fixture = await seed();
});

/* --------------------------------- doubles -------------------------------- */

/** One statement the script asked for, and what it bound to it. */
interface Statement {
  text: string;
  params: unknown[];
}

/** A postgres.js tag that records instead of sending. */
function recorder(rowsFor: (text: string) => Record<string, unknown>[] = () => []) {
  const statements: Statement[] = [];
  const answer = (text: string) => {
    const rows = rowsFor(text) as Record<string, unknown>[] & { count: number };
    rows.count = rows.length;
    return rows;
  };
  const sql: import("../../scripts/migrate-hosted-to-postgres").MigrateSql = {
    unsafe: async (text, params = []) => {
      statements.push({ text, params: [...params] });
      return answer(text);
    },
    begin: async (fn) => fn(sql),
  };
  return { sql, statements };
}

/** The statements that write, in the order the script issued them. */
const inserts = (statements: Statement[]): Statement[] =>
  statements.filter((s) => s.text.startsWith("insert into hosted."));

const first = (statements: Statement[], needle: string): Statement => {
  const hit = statements.find((s) => s.text.includes(needle));
  if (!hit) throw new Error(`no statement containing ${needle}; saw:\n${statements.map((s) => s.text.slice(0, 90)).join("\n")}`);
  return hit;
};

const indexOf = (statements: Statement[], needle: string): number =>
  statements.findIndex((s) => s.text.includes(needle));

/** An artifact target that remembers what it was asked for. */
function fakeTarget(alreadyStored: string[] = []) {
  const have = new Set(alreadyStored);
  const puts: { dir: string; provenance: import("@/lib/hosted/contracts").ArtifactProvenance }[] = [];
  const manifestFiles = (digest: string): import("@/lib/hosted/contracts").ArtifactFile[] => {
    const file = path.join(ARTIFACT_DIR, "sha256", digest, "manifest.json");
    if (!fs.existsSync(file)) return [];
    return (
      JSON.parse(fs.readFileSync(file, "utf8")) as import("@/lib/hosted/artifacts").ArtifactManifest
    ).files;
  };
  const target: import("../../scripts/migrate-hosted-to-postgres").ArtifactTarget = {
    get: async (digest) =>
      have.has(digest)
        ? ({ digest, byteSize: 0, fileCount: 0, provenance: provenanceFor("x"), createdAt: "" } as
            import("@/lib/hosted/contracts").Artifact)
        : null,
    list: async (digest) => (have.has(digest) ? manifestFiles(digest) : []),
    put: async (dir, provenance) => {
      puts.push({ dir, provenance });
      const digest = path.basename(path.dirname(dir));
      have.add(digest);
      return {
        digest,
        byteSize: 1,
        fileCount: 1,
        provenance,
        createdAt: new Date().toISOString(),
      } as import("@/lib/hosted/contracts").Artifact;
    },
  };
  return { target, puts };
}

const silent = () => {
  /* the report is asserted through the result, not through stdout */
};

const base = () => ({ dataDir: DATA, artifactDir: ARTIFACT_DIR, log: silent });

/* -------------------------------- the suite -------------------------------- */

describe("migrate-hosted-to-postgres — the plan", () => {
  it("a dry run reads everything, counts it, and writes nothing", async () => {
    const { sql, statements } = recorder();
    const result = await script.migrate({ ...base(), dryRun: true, sql });

    expect(statements).toHaveLength(0);
    expect(result.inserted).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);

    const control = result.phases.find((p) => p.phase === "control")!;
    const row = (table: string): number =>
      control.rows.find((r) => r.table === table)?.sqliteRows ?? -1;
    expect(row("apps")).toBe(2);
    expect(row("releases")).toBe(1);
    expect(row("artifacts")).toBe(2);
    expect(row("app_invites")).toBe(2);
    expect(row("revocation_ledger")).toBe(1);
    // Every line of a dry run's table reports inserted = 0.
    expect(control.rows.every((r) => r.inserted === 0)).toBe(true);

    const apps = result.phases.find((p) => p.phase === "apps")!;
    expect(apps.rows.find((r) => r.table === "app_records")?.sqliteRows).toBe(1);
    expect(apps.rows.find((r) => r.table === "app_writes")?.sqliteRows).toBe(1);
  });

  it("refuses a writing run with no client, and a flag it does not know", async () => {
    await expect(script.migrate(base())).rejects.toBeInstanceOf(script.UsageError);
    expect(() => script.parseArgs(["--only", "everything"])).toThrow(script.UsageError);
    expect(() => script.parseArgs(["--wat"])).toThrow(script.UsageError);
    expect(() => script.parseArgs(["--data"])).toThrow(script.UsageError);
    expect(script.parseArgs(["--dry-run", "--verify", "--only", "apps"])).toMatchObject({
      dryRun: true,
      verify: true,
      only: "apps",
    });
  });

  it("names a data directory with no control authority", async () => {
    await expect(
      script.migrate({ ...base(), dataDir: path.join(DATA, "nowhere"), dryRun: true })
    ).rejects.toThrow(/no control authority/);
  });
});

describe("migrate-hosted-to-postgres — the control tables", () => {
  it("inserts in foreign-key order and patches the circular pointers afterwards", async () => {
    const { sql, statements } = recorder();
    await script.migrate({ ...base(), only: "control", sql });

    const apps = indexOf(statements, "insert into hosted.apps");
    const artifacts = indexOf(statements, "insert into hosted.artifacts");
    const releases = indexOf(statements, "insert into hosted.releases");
    const patch = indexOf(statements, 'update hosted.apps as t set "active_release_id"');
    expect(apps).toBeGreaterThanOrEqual(0);
    expect(apps).toBeLessThan(artifacts);
    expect(artifacts).toBeLessThan(releases);
    expect(releases).toBeLessThan(patch);

    // The app row goes in with no pointer at all — the release does not exist
    // yet, and Postgres checks that reference immediately.
    const appInsert = statements[apps]!;
    expect(appInsert.text).toContain('"active_release_id"');
    expect(appInsert.params).not.toContain(fixture.releaseId);
    expect(statements[patch]!.params).toEqual([fixture.appId, fixture.releaseId]);

    // The same trick for the invite chain, whose reference is to its own table
    // and could otherwise be split across two batches.
    const invitePatch = first(statements, 'update hosted.app_invites as t set "supersedes"');
    expect(invitePatch.params).toHaveLength(2);
  });

  it("makes every insert idempotent", async () => {
    const { sql, statements } = recorder();
    await script.migrate({ ...base(), sql, artifacts: fakeTarget().target });

    const written = inserts(statements);
    expect(written.length).toBeGreaterThan(5);
    for (const statement of written) expect(statement.text).toContain("on conflict (");
    // Every copied row is `do nothing`; the one derived total is the exception
    // and says so.
    for (const statement of written)
      if (statement.text.includes("hosted.app_storage"))
        expect(statement.text).toContain("do update set logical_bytes = excluded.logical_bytes");
      else expect(statement.text).toContain("do nothing");
  });

  it("preserves revocation_ledger.seq and moves the identity sequence past it", async () => {
    const { sql, statements } = recorder();
    await script.migrate({ ...base(), only: "control", sql });

    const ledger = first(statements, "insert into hosted.revocation_ledger");
    expect(ledger.text).toContain("overriding system value");
    expect(ledger.text).toContain('"seq"');
    expect(ledger.params).toContain(1);
    expect(ledger.params).toContain(fixture.appId);

    const setval = first(statements, "setval");
    expect(setval.text).toContain("hosted.revocation_ledger");
    expect(indexOf(statements, "setval")).toBeGreaterThan(
      indexOf(statements, "insert into hosted.revocation_ledger")
    );
  });

  it("turns the 0/1 flag into a boolean and the BLOB into bytea", async () => {
    const { sql, statements } = recorder();
    await script.migrate({ ...base(), only: "control", sql });

    const events = first(statements, "insert into hosted.hosted_events");
    expect(events.params).toContain(true);
    expect(events.params).not.toContain(1);

    const deliveries = first(statements, "insert into hosted.invite_deliveries");
    expect(deliveries.text).toContain("::bytea");
    const payload = deliveries.params.find((p) => Buffer.isBuffer(p)) as Buffer | undefined;
    expect(payload).toBeDefined();
    expect([...payload!]).toEqual([...fixture.sealed]);
  });
});

describe("migrate-hosted-to-postgres — per-app data", () => {
  it("copies the record as jsonb and recomputes the storage total", async () => {
    const { sql, statements } = recorder();
    const result = await script.migrate({ ...base(), only: "apps", sql });

    const records = first(statements, "insert into hosted.app_records");
    expect(records.text).toContain("::jsonb");
    expect(records.params[0]).toBe(fixture.appId);
    expect(records.params[1]).toBe(fixture.recordId);

    const body = JSON.parse(records.params.find((p) => typeof p === "string" && p.startsWith("{")) as string);
    expect(body).toMatchObject({
      id: fixture.recordId,
      title: "Standing desk",
      category: "furniture",
      quantity: 2,
      version: 1,
      createdBy: OWNER,
    });
    // The promoted subject is the record's creator, as 0003 describes it.
    expect(records.params[2]).toBe(body.createdBy);

    const writes = first(statements, "insert into hosted.app_writes");
    expect(writes.text).toContain("::jsonb");
    expect(writes.params[0]).toBe(fixture.appId);

    const storage = first(statements, "insert into hosted.app_storage");
    expect(storage.params).toEqual([fixture.appId, fixture.logicalBytes]);
    expect(result.warnings.join("\n")).toContain(
      `storage counter is ${fixture.counter} but its rows sum to ${fixture.logicalBytes}`
    );
  });

  it("skips an app that has no data file, naming it, and copies the others", async () => {
    const { sql, statements } = recorder();
    const result = await script.migrate({ ...base(), only: "apps", sql });

    expect(result.warnings.join("\n")).toContain(`${fixture.appWithoutData} has no data.sqlite`);
    // The app that does have one is still copied: one missing file is a note,
    // not a reason to abandon the migration.
    expect(first(statements, "insert into hosted.app_records").params[0]).toBe(fixture.appId);
    const storage = statements.filter((s) => s.text.includes("hosted.app_storage"));
    expect(storage).toHaveLength(1);
  });
});

describe("migrate-hosted-to-postgres — artifacts", () => {
  it("uploads what is on disk and warns about what is not", async () => {
    const { sql } = recorder();
    const { target, puts } = fakeTarget();
    const result = await script.migrate({ ...base(), only: "artifacts", sql, artifacts: target });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.dir).toBe(path.join(ARTIFACT_DIR, "sha256", fixture.presentDigest, "files"));
    expect(puts[0]!.provenance.builtBy).toBe("recipe-local");

    const row = result.phases[0]!.rows[0]!;
    expect(row.table).toBe("artifacts");
    expect(row.sqliteRows).toBe(2);
    expect(row.inserted).toBe(1);
    expect(result.warnings.join("\n")).toContain(fixture.absentDigest);
    expect(result.exitCode).toBe(0);
  });

  it("skips a digest the bucket already holds, and verifies its manifest", async () => {
    const { sql } = recorder();
    const { target, puts } = fakeTarget([fixture.presentDigest]);
    const result = await script.migrate({
      ...base(),
      only: "artifacts",
      verify: true,
      sql,
      artifacts: target,
    });

    expect(puts).toHaveLength(0);
    expect(result.phases[0]!.rows[0]).toMatchObject({ inserted: 0, skipped: 1 });
    expect(result.mismatches).toEqual([]);
  });

  it("reports a bucket manifest that does not hash to its own key", async () => {
    const { sql } = recorder();
    const { target } = fakeTarget([fixture.presentDigest]);
    const tampered: typeof target = {
      ...target,
      list: async () => [
        { path: "index.html", bytes: 1, sha256: "b".repeat(64), contentType: "text/html; charset=utf-8" },
      ],
    };
    const result = await script.migrate({
      ...base(),
      only: "artifacts",
      verify: true,
      sql,
      artifacts: tampered,
    });
    expect(result.mismatches.join("\n")).toContain("hashes to");
    expect(result.exitCode).toBe(1);
  });
});

/* --------------------------------- the live run --------------------------------- */

describe.skipIf(!postgresContractEnabled())(
  "migrate-hosted-to-postgres — against the real Supabase project",
  () => {
    let sql: import("../../scripts/migrate-hosted-to-postgres").MigrateSql;
    let client: import("@/lib/hosted/authority").Sql;

    beforeAll(async () => {
      const { pgAuthorityClient } = await import("@/lib/hosted/authority/pg/client");
      client = pgAuthorityClient();
      sql = client as unknown as typeof sql;
    });

    afterAll(async () => {
      await cleanup();
      const { closePgAuthorityClient } = await import("@/lib/hosted/authority/pg/client");
      await closePgAuthorityClient();
    });

    /** This run's rows, and only this run's. */
    async function cleanup(): Promise<void> {
      const like = `${CONTRACT_PREFIX}%`;
      for (const table of ["app_writes", "app_records", "app_storage"])
        await client.unsafe(`delete from hosted.${table} where app_id like $1`, [like]);
      await factories.cleanupPostgresContract();
      // The one row outside the namespace: a real content address, because the
      // bytes on disk decide it.
      await client.unsafe("delete from hosted.artifacts where digest = $1", [fixture.presentDigest]);
    }

    it("copies the control tables, verifies, and inserts nothing on a second run", async () => {
      const run = await script.migrate({ ...base(), only: "control", verify: true, sql });
      expect(run.mismatches).toEqual([]);
      expect(run.exitCode).toBe(0);
      expect(run.inserted).toBeGreaterThan(0);

      const again = await script.migrate({ ...base(), only: "control", verify: true, sql });
      expect(again.inserted).toBe(0);
      expect(again.mismatches).toEqual([]);
      expect(again.exitCode).toBe(0);
    });

    it("copies the app's data, verifies, and inserts nothing on a second run", async () => {
      const run = await script.migrate({ ...base(), only: "apps", verify: true, sql });
      expect(run.mismatches).toEqual([]);
      expect(run.inserted).toBeGreaterThan(0);

      const again = await script.migrate({ ...base(), only: "apps", verify: true, sql });
      expect(again.inserted).toBe(0);
      expect(again.mismatches).toEqual([]);
      expect(again.exitCode).toBe(0);
    });

    it("leaves no contract- rows behind", async () => {
      await cleanup();
      const rows = await client.unsafe(
        "select count(*)::int as n from hosted.apps where id like $1",
        [`${CONTRACT_PREFIX}%`]
      );
      expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);
    });
  }
);

if (!postgresContractEnabled())
  console.log(
    `  (the live half of tests/scripts/migrate-hosted-to-postgres.test.ts is skipped: set ${postgresSkipReason()})`
  );
