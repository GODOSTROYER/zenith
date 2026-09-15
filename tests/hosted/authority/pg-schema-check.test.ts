/**
 * The Postgres boot check for the pending-invite uniqueness index, against a
 * mocked tag function.
 *
 * No database, on purpose — and the absence is the point. What broke here was
 * not a query that returned the wrong rows; it was a *match on rendered text*.
 * `regclass::text` and `pg_get_indexdef()` drop the schema qualifier whenever
 * `hosted` is on the connection's `search_path`, so the same correct index
 * renders two different ways depending on an operator setting the application
 * never sees. The check then found nothing, refused to boot, and — because the
 * rejection is memoised — kept refusing until the instance was restarted.
 *
 * So both renderings are fed in here as fixtures, along with the near-misses a
 * text match would wave through: a non-unique index, an invalid one left by a
 * failed concurrent build, the wrong columns and the wrong predicate.
 *
 * No live Postgres was available in this environment; the contract suite under
 * `./contract/` is where this code meets a real database.
 */
import { describe, expect, it } from "vitest";
import { isolatedDataDir } from "../_fixtures";

isolatedDataDir("zenith-authority-pg-schema-check-");

const { hasPendingInviteUniquenessIndex, isPendingInviteUniquenessIndex } = await import(
  "@/lib/hosted/authority/pg/repos/migrations"
);
const { createPostgresAuthority } = await import("@/lib/hosted/authority/pg");
const { MIGRATIONS } = await import("@/lib/hosted/authority/schema");

type Sql = Parameters<typeof hasPendingInviteUniquenessIndex>[0];
type Row = Record<string, unknown>;

/** What `pg_get_indexdef` renders when `hosted` is NOT on the search_path. */
const QUALIFIED =
  "CREATE UNIQUE INDEX app_invites_pending_email ON hosted.app_invites USING btree (app_id, lower(email)) WHERE (state = 'pending'::text)";

/** …and what it renders for the very same index when `hosted` IS on it. */
const UNQUALIFIED =
  "CREATE UNIQUE INDEX app_invites_pending_email ON app_invites USING btree (app_id, lower(email)) WHERE (state = 'pending'::text)";

const row = (patch: Row = {}): Row => ({
  indexdef: QUALIFIED,
  predicate: "(state = 'pending'::text)",
  isunique: true,
  isvalid: true,
  ...patch,
});

/** Records the statement it was handed and answers with fixed rows. */
function fakeSql(rows: Row[] | (() => never)): { sql: Sql; statements: string[] } {
  const statements: string[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(strings.raw.join("?"));
    void values;
    return Promise.resolve(typeof rows === "function" ? rows() : rows);
  };
  return { sql: sql as unknown as Sql, statements };
}

describe("recognising the index", () => {
  it("accepts it whether or not the rendering is schema-qualified", () => {
    expect(isPendingInviteUniquenessIndex(row() as never)).toBe(true);
    expect(isPendingInviteUniquenessIndex(row({ indexdef: UNQUALIFIED }) as never)).toBe(true);
  });

  it("accepts the predicate and the column cast in either rendering", () => {
    expect(isPendingInviteUniquenessIndex(row({ predicate: "state = 'pending'" }) as never)).toBe(true);
    expect(
      isPendingInviteUniquenessIndex(
        row({
          indexdef: QUALIFIED.replace("lower(email)", "lower((email)::text)"),
        }) as never
      )
    ).toBe(true);
  });

  it("reads the driver's booleans however they arrive", () => {
    expect(isPendingInviteUniquenessIndex(row({ isunique: "t", isvalid: "t" }) as never)).toBe(true);
  });

  it("refuses the near-misses a text match would accept", () => {
    // Same name, same table, not unique: it fences nothing.
    expect(isPendingInviteUniquenessIndex(row({ isunique: false }) as never)).toBe(false);
    // A failed CREATE INDEX CONCURRENTLY leaves a unique index that is not
    // enforced. The catalog says so; the definition does not.
    expect(isPendingInviteUniquenessIndex(row({ isvalid: false }) as never)).toBe(false);
    // Case-sensitive columns: two capitalisations would both be admitted.
    expect(
      isPendingInviteUniquenessIndex(
        row({ indexdef: QUALIFIED.replace("lower(email)", "email") }) as never
      )
    ).toBe(false);
    // A different partial predicate fences a different set of rows.
    expect(
      isPendingInviteUniquenessIndex(row({ predicate: "(state = 'accepted'::text)" }) as never)
    ).toBe(false);
  });
});

describe("the lookup itself", () => {
  it("identifies the index through catalog joins, never through rendered names", async () => {
    const { sql, statements } = fakeSql([row()]);
    expect(await hasPendingInviteUniquenessIndex(sql)).toBe(true);

    const statement = statements.join(" ").replace(/\s+/g, " ").toLowerCase();
    // The trap this check fell into: both of these render differently depending
    // on the connection's search_path, so neither may appear in the predicate.
    expect(statement).not.toContain("regclass");
    expect(statement).not.toContain("'hosted.app_invites_pending_email'");
    // What identifies it instead: the namespace, the table and the index, each
    // by catalog name.
    expect(statement).toContain("n.nspname = 'hosted'");
    expect(statement).toContain("c.relname = 'app_invites'");
    expect(statement).toContain("ic.relname = 'app_invites_pending_email'");
  });

  it("answers false, not an error, when the hosted schema is not there at all", async () => {
    const { sql } = fakeSql(() => {
      const err = new Error('relation "hosted.app_invites" does not exist') as Error & { code: string };
      err.code = "42P01";
      throw err;
    });
    expect(await hasPendingInviteUniquenessIndex(sql)).toBe(false);
  });

  it("answers false when the index simply is not there", async () => {
    const { sql } = fakeSql([]);
    expect(await hasPendingInviteUniquenessIndex(sql)).toBe(false);
  });
});

describe("the boot gate that consults it", () => {
  /**
   * A client that reports every migration this build knows as applied, and
   * answers the index lookup with whatever the test says.
   *
   * Nothing here names version 3: the gate used to read `expected.version === 3`
   * and would have disabled itself the moment a version 4 was added. This
   * fixture stays true whatever `MIGRATIONS` grows to, which is the property
   * being defended.
   */
  function fakeAuthorityClient(indexRows: Row[]): Sql {
    const sql = (strings: TemplateStringsArray) => {
      const statement = strings.raw.join("?").replace(/\s+/g, " ").toLowerCase();
      if (statement.includes("schema_migrations"))
        return Promise.resolve(
          MIGRATIONS.map((migration) => ({
            version: migration.version,
            name: migration.name,
            applied_at: "2026-01-01T00:00:00.000Z",
          }))
        );
      if (statement.includes("pg_index")) return Promise.resolve(indexRows);
      return Promise.resolve([]);
    };
    return sql as unknown as Sql;
  }

  const authorityWith = (indexRows: Row[]) =>
    createPostgresAuthority({
      client: fakeAuthorityClient(indexRows) as never,
      identity: "fake://schema-check",
    });

  it("refuses to serve when the ledger is complete but the index is not there", async () => {
    const authority = authorityWith([]);
    await expect(authority.repos.apps.get("11111111-1111-4111-8111-111111111111")).rejects.toThrow(
      /app_invites_pending_email/
    );
  });

  it("serves once the index is actually present", async () => {
    const authority = authorityWith([row()]);
    expect(await authority.repos.apps.get("11111111-1111-4111-8111-111111111111")).toBeNull();
  });
});
