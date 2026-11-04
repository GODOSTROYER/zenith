/**
 * The install-global `settings` row is version-guarded like every other
 * collection.
 *
 * `writeSettings` was an unguarded upsert: two requests that both read version
 * N and each changed a setting both "won", and whichever flushed last silently
 * replaced the other's edit — the one collection where the store's optimistic
 * concurrency did not apply. It now behaves like `writeRow`:
 *
 *   - a row that existed at load is updated `where version = <loaded version>`,
 *     and matching nothing is the same 409 every other collection answers;
 *   - a row that did not exist at load is *inserted*, and a unique violation
 *     (someone inserted it first) is the same 409;
 *   - an unchanged bag writes nothing at all.
 *
 * The client is a PostgREST-shaped double that honours `.eq()` on `update` and
 * the primary key on `insert` — unlike the fixed-answer mocks elsewhere in this
 * directory, which cannot tell an update that matched from one that did not.
 * What this proves is the statements the store sends and how it reads the
 * database's answer; it cannot prove PostgREST itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-pg-settings-guard-", { fast: true });
process.env.ZENITH_STORE = "postgres";
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-test-key";

type Row = Record<string, unknown>;

/** The fake project's tables. Only `settings` ever holds anything here. */
const TABLES: Record<string, Row[]> = {};

interface Statement {
  op: "select" | "insert" | "update" | "upsert" | "delete";
  table: string;
  payload?: Row;
  filters: [column: string, value: unknown][];
}
const sent: Statement[] = [];

/** Run once, just before the next `settings` write is applied — i.e. mid-flush. */
let beforeSettingsWrite: (() => void) | undefined;

function builder(table: string, op: Statement["op"], payload: Row | Row[] | undefined) {
  const filters: [string, unknown][] = [];
  const self: Record<string, unknown> = {};
  for (const name of ["select", "or", "like", "order", "limit"]) self[name] = () => self;
  self.eq = (column: string, value: unknown) => {
    filters.push([column, value]);
    return self;
  };
  self.in = (column: string, values: unknown[]) => {
    filters.push([column, values]);
    return self;
  };
  self.then = (resolve: (v: unknown) => unknown) => {
    sent.push({ op, table, payload: Array.isArray(payload) ? payload[0] : payload, filters: [...filters] });
    if (op !== "select" && table === "settings" && beforeSettingsWrite) {
      const hook = beforeSettingsWrite;
      beforeSettingsWrite = undefined;
      hook();
    }
    const rows = (TABLES[table] ??= []);
    const matches = (r: Row) =>
      filters.every(([column, value]) => (Array.isArray(value) ? value.includes(r[column]) : r[column] === value));
    if (op === "select") return Promise.resolve(resolve({ data: rows.filter(matches), error: null }));
    if (op === "insert") {
      const incoming = Array.isArray(payload) ? payload : [payload as Row];
      for (const row of incoming) {
        if (table === "settings" && rows.some((r) => r.workspace_id === row.workspace_id))
          return Promise.resolve(
            resolve({
              data: null,
              error: { code: "23505", message: 'duplicate key value violates unique constraint "settings_pkey"' },
            })
          );
        rows.push({ ...row });
      }
      return Promise.resolve(resolve({ data: null, error: null }));
    }
    if (op === "update") {
      const hit = rows.filter(matches);
      for (const r of hit) Object.assign(r, payload);
      return Promise.resolve(resolve({ data: hit.map((r) => ({ ...r })), error: null }));
    }
    if (op === "upsert") {
      // What an unguarded write does: it lands, whatever version the row is at.
      for (const row of Array.isArray(payload) ? payload : [payload as Row]) {
        const existing = rows.find((r) => r.workspace_id === row.workspace_id);
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
      }
      return Promise.resolve(resolve({ data: null, error: null }));
    }
    const kept = rows.filter((r) => !matches(r));
    TABLES[table] = kept;
    return Promise.resolve(resolve({ data: null, error: null }));
  };
  return self;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => ({ data: {}, error: null }),
    from: (table: string) => ({
      select: (...a: unknown[]) => {
        void a;
        return builder(table, "select", undefined);
      },
      insert: (payload: Row | Row[]) => builder(table, "insert", payload),
      update: (payload: Row) => builder(table, "update", payload),
      upsert: (payload: Row | Row[]) => builder(table, "upsert", payload),
      delete: () => builder(table, "delete", undefined),
    }),
  }),
}));

const { db, save, flushPendingAsync } = await import("@/lib/db/store");
const pg = await import("@/lib/db/postgres-store");
const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
const { ApiError } = await import("@/lib/server/errors");

const USER = { id: "user-ada", email: "ada@acme.example" };
const SETTINGS_KEY = pg.INSTALL_SETTINGS_ID;

function reset(row?: Row): void {
  for (const key of Object.keys(TABLES)) delete TABLES[key];
  for (const table of [
    "workspaces", "members", "invites", "connections", "projects", "environments", "revisions",
    "deployments", "revision_manifests", "deployment_events", "audit_events", "findings",
    "navigator_runs", "alert_rules", "alert_events", "alert_outbox", "workspace_versions",
  ])
    TABLES[table] = [];
  TABLES.settings = row ? [row] : [];
  sent.length = 0;
  beforeSettingsWrite = undefined;
  pg.clearProcessSnapshot();
  pg.resetPgClient();
}

const settingsRow = (): Row | undefined => TABLES.settings.find((r) => r.workspace_id === SETTINGS_KEY);
const settingsWrites = () => sent.filter((s) => s.table === "settings" && s.op !== "select");

/** Load a snapshot, run `edit` inside it, flush. Rejects if the flush does. */
async function editSettings(
  snapshot: Awaited<ReturnType<typeof pg.loadSnapshot>>,
  edit: (settings: Record<string, unknown>) => void
): Promise<void> {
  await runWithSnapshot(snapshot, async () => {
    edit(db().settings as unknown as Record<string, unknown>);
    save();
    await flushPendingAsync();
  });
}

const CONFLICT = "Someone else changed this workspace; reload and retry";

beforeEach(() => reset({ workspace_id: SETTINGS_KEY, data: { autonomy: "approve" }, version: 4 }));

describe("writing the install settings", () => {
  it("updates the row it loaded, only at the version it loaded", async () => {
    const snapshot = await pg.loadSnapshot(pg.pgClient(), USER);
    sent.length = 0;
    await editSettings(snapshot, (s) => {
      s.autonomy = "bounded";
    });

    const writes = settingsWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe("update");
    // The guard: the version this snapshot loaded, not "whatever is there now".
    expect(writes[0].filters).toEqual(
      expect.arrayContaining([
        ["workspace_id", SETTINGS_KEY],
        ["version", 4],
      ])
    );
    expect(writes[0].payload).toMatchObject({ version: 5, data: { autonomy: "bounded" } });
    expect(settingsRow()).toMatchObject({ version: 5, data: { autonomy: "bounded" } });
  });

  it("guards the next write in the same snapshot at the version the last one produced", async () => {
    const snapshot = await pg.loadSnapshot(pg.pgClient(), USER);
    await editSettings(snapshot, (s) => {
      s.autonomy = "bounded";
    });
    sent.length = 0;
    await editSettings(snapshot, (s) => {
      s.autonomy = "autonomous";
    });
    const writes = settingsWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].filters).toEqual(expect.arrayContaining([["version", 5]]));
    expect(settingsRow()).toMatchObject({ version: 6, data: { autonomy: "autonomous" } });
  });

  it("writes nothing when the settings did not change", async () => {
    const snapshot = await pg.loadSnapshot(pg.pgClient(), USER);
    sent.length = 0;
    await editSettings(snapshot, () => undefined);
    expect(settingsWrites()).toEqual([]);
    expect(settingsRow()).toMatchObject({ version: 4 });
  });

  it("answers the same 409 as every other collection when somebody else moved the row first", async () => {
    const mine = await pg.loadSnapshot(pg.pgClient(), USER);
    const theirs = await pg.loadSnapshot(pg.pgClient(), USER);

    await editSettings(theirs, (s) => {
      s.autonomy = "autonomous";
    });
    expect(settingsRow()).toMatchObject({ version: 5, data: { autonomy: "autonomous" } });

    const failure = await editSettings(mine, (s) => {
      s.autonomy = "observe";
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as InstanceType<typeof ApiError>).status).toBe(409);
    expect((failure as Error).message).toBe(CONFLICT);
    // Their edit stands. (Unguarded, this is where it was silently replaced.)
    expect(settingsRow()).toMatchObject({ version: 5, data: { autonomy: "autonomous" } });
  });

  it("does not let a stale writer overwrite a row that moved after the guard was sent", async () => {
    const snapshot = await pg.loadSnapshot(pg.pgClient(), USER);
    // Another instance's write lands between this snapshot's load and its flush.
    beforeSettingsWrite = () => {
      const row = settingsRow()!;
      Object.assign(row, { version: 5, data: { autonomy: "autonomous" } });
    };
    await expect(
      editSettings(snapshot, (s) => {
        s.autonomy = "bounded";
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(settingsRow()).toMatchObject({ version: 5, data: { autonomy: "autonomous" } });
  });

  it("keeps a conflicting request able to reload and retry", async () => {
    const mine = await pg.loadSnapshot(pg.pgClient(), USER);
    const theirs = await pg.loadSnapshot(pg.pgClient(), USER);
    await editSettings(theirs, (s) => {
      s.autonomy = "autonomous";
    });
    await expect(
      editSettings(mine, (s) => {
        s.autonomy = "observe";
      })
    ).rejects.toMatchObject({ status: 409 });

    // "Reload the page, then make the change again": a fresh snapshot loads
    // version 5 and its edit lands at version 6.
    pg.clearProcessSnapshot();
    const reloaded = await pg.loadSnapshot(pg.pgClient(), USER);
    await editSettings(reloaded, (s) => {
      s.autonomy = "observe";
    });
    expect(settingsRow()).toMatchObject({ version: 6, data: { autonomy: "observe" } });
  });
});

describe("writing the install settings for the first time", () => {
  beforeEach(() => reset());

  it("inserts the row at version 1, and does not upsert", async () => {
    const snapshot = await pg.loadSnapshot(pg.pgClient(), USER);
    sent.length = 0;
    await editSettings(snapshot, (s) => {
      s.autonomy = "bounded";
    });
    const writes = settingsWrites();
    expect(writes.map((w) => w.op)).toEqual(["insert"]);
    expect(writes[0].payload).toMatchObject({ workspace_id: SETTINGS_KEY, version: 1, data: { autonomy: "bounded" } });
    expect(settingsRow()).toMatchObject({ version: 1, data: { autonomy: "bounded" } });
  });

  it("answers 409 when somebody inserted it first, and leaves their row alone", async () => {
    const mine = await pg.loadSnapshot(pg.pgClient(), USER);
    const theirs = await pg.loadSnapshot(pg.pgClient(), USER);
    await editSettings(theirs, (s) => {
      s.autonomy = "autonomous";
    });

    const failure = await editSettings(mine, (s) => {
      s.autonomy = "observe";
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as InstanceType<typeof ApiError>).status).toBe(409);
    expect((failure as Error).message).toBe(CONFLICT);
    expect(settingsRow()).toMatchObject({ version: 1, data: { autonomy: "autonomous" } });
  });
});
