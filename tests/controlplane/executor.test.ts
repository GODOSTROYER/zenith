/**
 * The SQL executor: row-type normalisation, parameter rules, transactions and
 * savepoints, bounded retry on serialization failure, and error hygiene — on
 * PGlite and (when configured) PostgreSQL, plus a cross-engine shape check.
 */
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlStoreError, PlatformDbError, normalizeParams, normalizeRows, normalizeValue, openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { LANES, PG_URL, expectCode, openLane, uid } from "./_support/harness";

const SHAPE_SQL = `select
    '2026-01-02 03:04:05.678+00'::timestamptz as ts,
    9007199254740991::bigint as safe_big,
    42::bigint as small_big,
    (select count(*) from generate_series(1, 7)) as counted,
    '{"a":[1,{"b":null,"c":"x"}],"d":true}'::jsonb as doc,
    '[1,2,3]'::jsonb as arr_doc,
    'null'::jsonb as json_null,
    1.5::numeric as num,
    null::timestamptz as no_ts,
    null::bigint as no_big,
    true as flag,
    'é"\\ text'::text as txt,
    7::int as small_int`;

const EXPECTED_SHAPE = {
  ts: "2026-01-02T03:04:05.678Z",
  safe_big: 9007199254740991,
  small_big: 42,
  counted: 7,
  doc: { a: [1, { b: null, c: "x" }], d: true },
  arr_doc: [1, 2, 3],
  json_null: null,
  num: "1.5",
  no_ts: null,
  no_big: null,
  flag: true,
  txt: 'é"\\ text',
  small_int: 7,
};

describe("normalisation helpers", () => {
  it("normalizeValue: Date to ISO, bigint to number with a 2^53 bound", () => {
    expect(normalizeValue(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:05.678Z");
    expect(normalizeValue(5n)).toBe(5);
    expect(normalizeValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => normalizeValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrowError(/2\^53/);
    expect(() => normalizeValue(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrowError(ControlStoreError);
    expect(() => normalizeValue(new Date(Number.NaN))).toThrowError(/infinity/);
    expect(normalizeValue("x")).toBe("x");
    expect(normalizeValue(null)).toBeNull();
    const obj = { a: 1 };
    expect(normalizeValue(obj)).toBe(obj); // jsonb values are never rewritten
    expect(normalizeRows([{ a: 1n, b: new Date(0), c: { d: 2n } }])).toEqual([{ a: 1, b: "1970-01-01T00:00:00.000Z", c: { d: 2n } }]);
  });

  it("normalizeParams: undefined to null, Date to ISO, objects and arrays refused loudly", () => {
    expect(normalizeParams(undefined)).toEqual([]);
    expect(normalizeParams([undefined, null, 1, "a", true, new Date(0), 5n])).toEqual([null, null, 1, "a", true, "1970-01-01T00:00:00.000Z", 5n]);
    expect(() => normalizeParams([{ a: 1 }])).toThrowError(/\$1 is an object or array/);
    expect(() => normalizeParams(["ok", ["a", "b"]])).toThrowError(/\$2 is an object or array/);
    const bytes = new Uint8Array([1, 2]);
    expect(normalizeParams([bytes])[0]).toBe(bytes);
  });
});

describe.each(LANES)("executor [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  const db = () => ctx.db;

  it("reports its kind and a credential-free identity", () => {
    expect(db().kind).toBe(lane.name);
    expect(db().identity).toMatch(lane.name === "pglite" ? /^pglite:\/\// : /^postgres:\/\/[^@]+\/[^@]+$/);
    expect(db().identity).not.toMatch(/zenith_dev_only|password|:.*@/);
  });

  it("returns identical row shapes: ISO strings, numbers, parsed jsonb, string numerics, nulls", async () => {
    const [row] = await db().query(SHAPE_SQL);
    expect(row).toEqual(EXPECTED_SHAPE);
    expect(typeof (row as Record<string, unknown>).safe_big).toBe("number");
    expect(typeof (row as Record<string, unknown>).counted).toBe("number");
  });

  it("throws rather than rounding a bigint beyond 2^53", async () => {
    await expectCode(db().query("select 9007199254740993::bigint as big"), "value_out_of_range");
    await expectCode(db().query("select 'infinity'::timestamptz as t"), "value_out_of_range");
  });

  it("binds parameters positionally with the types the schema expects", async () => {
    const at = new Date("2026-03-04T05:06:07.890Z");
    const [row] = await db().query<Record<string, unknown>>(
      `select $1::text as t, $2::bigint as n, $3::boolean as b, $4::timestamptz as ts, $5::text::jsonb as j, $6::text is null as was_null,
              $7::bytea as bytes, $8::bigint as big, $9::text[] as arr`,
      ["it's \"quoted\" \\ é😀", 12345, false, at, JSON.stringify({ nested: { list: [1, "two", null], quote: 'a"b', slash: "c\\d" } }), undefined, new Uint8Array([0, 1, 254, 255]), 9007199254740000n, '{"a","b c"}']
    );
    expect(row).toMatchObject({
      t: "it's \"quoted\" \\ é😀",
      n: 12345,
      b: false,
      ts: "2026-03-04T05:06:07.890Z",
      j: { nested: { list: [1, "two", null], quote: 'a"b', slash: "c\\d" } },
      was_null: true,
      big: 9007199254740000,
      arr: ["a", "b c"],
    });
    expect(Array.from(row.bytes as Uint8Array)).toEqual([0, 1, 254, 255]);
  });

  it("refuses object and array parameters before they can be encoded differently by the two engines", async () => {
    await expectCode(db().query("select $1::jsonb", [{ a: 1 }] as never), "invalid_input");
    await expectCode(db().query("select $1::text[]", [["a"]] as never), "invalid_input");
  });

  it("stores JSON through text::jsonb identically, including a JSON string scalar and nested unicode", async () => {
    const id = uid("json");
    await db().query("insert into platform.workspace_policy (workspace_id, params, updated_by) values ($1, $2::text::jsonb, 'test')", [id, JSON.stringify({ s: "just a string", u: "日本語", n: [1, 2, { z: null }] })]);
    const [row] = await db().query<{ params: unknown }>("select params from platform.workspace_policy where workspace_id = $1", [id]);
    expect(row.params).toEqual({ s: "just a string", u: "日本語", n: [1, 2, { z: null }] });
    const [scalar] = await db().query<{ v: unknown }>("select $1::text::jsonb as v", [JSON.stringify("hello")]);
    expect(scalar.v).toBe("hello");
  });

  it("exec runs a multi-statement script", async () => {
    const t = `zt_${uid("x").replace(/-/g, "").slice(0, 12)}`;
    await db().exec(`create temp table ${t} (a int); insert into ${t} values (1), (2); insert into ${t} values (3);`);
    const rows = await db().query<{ a: number }>(`select a from ${t} order by a`).catch(() => undefined);
    // temp tables are per-connection on Postgres (pooled), so only assert where visible
    if (rows) expect(rows.map((r) => r.a)).toEqual([1, 2, 3]);
  });

  describe("transactions", () => {
    const insert = (sql: { query: (t: string, p?: unknown[]) => Promise<unknown[]> }, agent: string, nonce: string) =>
      sql.query("insert into platform.agent_nonces (agent_id, nonce) values ($1, $2)", [agent, nonce]);
    const count = async (agent: string): Promise<number> => (await db().query<{ n: number }>("select count(*)::int as n from platform.agent_nonces where agent_id = $1", [agent]))[0].n;

    it("commits on success and rolls back everything on failure", async () => {
      const a = uid("agent");
      expect(await db().tx(async (tx) => (await insert(tx, a, "n1"), "value"))).toBe("value");
      expect(await count(a)).toBe(1);
      await expect(
        db().tx(async (tx) => {
          await insert(tx, a, "n2");
          throw new Error("boom");
        })
      ).rejects.toThrowError("boom");
      expect(await count(a)).toBe(1);
    });

    it("a nested tx is a savepoint: an inner failure rolls back only the inner work", async () => {
      const a = uid("agent");
      await db().tx(async (tx) => {
        await insert(tx, a, "outer-1");
        await expect(
          tx.tx(async (inner) => {
            await insert(inner, a, "inner-1");
            await inner.tx(async (deeper) => {
              await insert(deeper, a, "deeper-1");
              throw new Error("deeper failed");
            });
          })
        ).rejects.toThrowError("deeper failed");
        await insert(tx, a, "outer-2");
        await tx.tx(async (inner) => insert(inner, a, "inner-ok"));
      });
      const rows = await db().query<{ nonce: string }>("select nonce from platform.agent_nonces where agent_id = $1 order by nonce", [a]);
      expect(rows.map((r) => r.nonce)).toEqual(["inner-ok", "outer-1", "outer-2"]);
    });

    it("recovers from a database error inside a savepoint: the outer transaction keeps working", async () => {
      const a = uid("agent");
      await db().tx(async (tx) => {
        await insert(tx, a, "dup");
        const err = await tx.tx((inner) => insert(inner, a, "dup")).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PlatformDbError);
        expect((err as PlatformDbError).sqlstate).toBe("23505");
        await insert(tx, a, "after");
      });
      expect(await count(a)).toBe(2);
    });

    it("routes the top-level handle used inside tx() to that transaction (no deadlock, rolls back together)", async () => {
      const a = uid("agent");
      await expect(
        db().tx(async () => {
          await insert(db(), a, "via-handle"); // NOT the tx argument
          await db().tx(async () => insert(db(), a, "nested-via-handle"));
          throw new Error("rollback");
        })
      ).rejects.toThrowError("rollback");
      expect(await count(a)).toBe(0);
    });

    it("replays the whole transaction on serialization failure and deadlock, bounded to five attempts", async () => {
      const failing = (code: string) => Object.assign(new Error("could not serialize access"), { code, severity: "ERROR", routine: "x" });
      for (const code of ["40001", "40P01"]) {
        let calls = 0;
        const value = await db().tx(async () => {
          calls++;
          if (calls < 4) throw failing(code);
          return "ok";
        });
        expect(value).toBe("ok");
        expect(calls).toBe(4);
      }
      let attempts = 0;
      const err = await db()
        .tx(async () => {
          attempts++;
          throw failing("40001");
        })
        .catch((e: unknown) => e);
      expect(attempts).toBe(5);
      expect(err).toBeInstanceOf(PlatformDbError);
      expect((err as PlatformDbError).retryable).toBe(true);
    }, 20_000);

    it("does not replay other errors: fn runs once for a plain error, a constraint violation or a domain error", async () => {
      let calls = 0;
      await expect(db().tx(async () => { calls++; throw new Error("plain"); })).rejects.toThrowError("plain");
      expect(calls).toBe(1);
      const domain = new ControlStoreError("conflict", "domain");
      await expect(db().tx(async () => { calls++; throw domain; })).rejects.toBe(domain);
      expect(calls).toBe(2);
      const a = uid("agent");
      calls = 0;
      await insert(db(), a, "x");
      await expect(db().tx(async (tx) => { calls++; await insert(tx, a, "x"); })).rejects.toMatchObject({ sqlstate: "23505" });
      expect(calls).toBe(1);
    });

    it("concurrent transactions do not interleave their statements' effects incorrectly", async () => {
      const a = uid("agent");
      await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? ctx.db : ctx.db2).tx(async (tx) => { await insert(tx, a, `c${i}`); await insert(tx, a, `d${i}`); })));
      expect(await count(a)).toBe(24);
    });
  });

  describe("error hygiene", () => {
    it("a constraint violation carries the SQLSTATE and constraint, never the parameters or row values", async () => {
      const secret = `SUPER-SECRET-${uid("v")}`;
      await db().query("insert into platform.agent_nonces (agent_id, nonce) values ($1, $2)", [secret, secret]);
      const err = await db().query("insert into platform.agent_nonces (agent_id, nonce) values ($1, $2)", [secret, secret]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformDbError);
      const e = err as PlatformDbError;
      expect(e.sqlstate).toBe("23505");
      expect(e.isUniqueViolation).toBe(true);
      expect(e.constraint).toBe("agent_nonces_pkey");
      expect(e.table).toBe("agent_nonces");
      const rendered = `${e.message} ${e.stack} ${JSON.stringify(e)} ${inspect(e, { depth: 8, showHidden: true })}`;
      expect(rendered).not.toContain(secret);
      expect(e.cause).toBeUndefined();
    });

    it("a data exception does not echo the offending literal", async () => {
      const secret = `hunter2-${uid("v")}`;
      const err = await db().query("select $1::int as n", [secret]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformDbError);
      expect((err as PlatformDbError).sqlstate).toBe("22P02");
      expect(inspect(err, { depth: 8, showHidden: true })).not.toContain(secret);
    });

    it("a check-constraint failure and a foreign-key failure are typed with their SQLSTATE", async () => {
      const bad = await db().query("insert into platform.environment_settings (environment_id, workspace_id, autonomy_level, updated_by) values ($1, $2, 9, 'x')", [uid("e"), uid("w")]).catch((e: unknown) => e);
      expect((bad as PlatformDbError).sqlstate).toBe("23514");
      const fk = await db().query("insert into platform.approvals (id, operation_id, workspace_id, proposal_digest, decision, approver, approver_id, approver_role, policy_version, expires_at) values ($1, 'nope', 'nope', $2, 'approve', '{}'::jsonb, 'x', 'editor', 'v', clock_timestamp())", [uid("a"), "0".repeat(64)]).catch((e: unknown) => e);
      expect((fk as PlatformDbError).sqlstate).toBe("23503");
    });
  });
});

describe.skipIf(!PG_URL)("cross-engine shape identity", () => {
  it("PGlite and PostgreSQL return deeply equal rows for the same statement", async () => {
    const pglite: PlatformDbHandle = await openPlatformDb({ kind: "pglite", migrate: false });
    const pg: PlatformDbHandle = await openPlatformDb({ kind: "postgres", url: PG_URL as string, migrate: false, max: 1 });
    try {
      const [a] = await pglite.query(SHAPE_SQL);
      const [b] = await pg.query(SHAPE_SQL);
      expect(a).toEqual(b);
      expect(a).toEqual(EXPECTED_SHAPE);
      const withParams = "select $1::text::jsonb as j, $2::timestamptz as ts, $3::bigint as n";
      const params = [JSON.stringify({ x: [1, { y: "z" }] }), "2026-05-06T07:08:09.123Z", 77];
      expect(await pglite.query(withParams, params)).toEqual(await pg.query(withParams, params));
    } finally {
      await pglite.close();
      await pg.close();
    }
  }, 60_000);
});
