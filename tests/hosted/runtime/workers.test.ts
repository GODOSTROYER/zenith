/**
 * The two Cloudflare edge sources, driven with fake `env` objects.
 *
 * A green run here says the workers' logic agrees with the control service's.
 * It says nothing about Cloudflare: nothing in `workers/` has been deployed,
 * and `workers/README.md` lists what remains unproven.
 *
 * Two invariants are worth more than the behaviour tests: the response guard
 * constants and the broker's SQL are copies, and a copy that drifts is worse
 * than no copy at all — so both are compared against their originals here.
 */
import { describe, expect, it } from "vitest";
import { isolatedDataDir } from "../_fixtures";

isolatedDataDir("zenith-runtime-workers-");

const { GATEWAY_CSP, GATEWAY_SECURITY_HEADERS, isHashedAssetPath } = await import("@/lib/hosted/gateway");
const { trackerSql } = await import("@/lib/hosted/data");
const gatewayWorker = await import("../../../workers/gateway-worker");
const brokerWorker = await import("../../../workers/broker-worker");

/* ------------------------------- invariants ------------------------------- */

describe("the copies stay copies", () => {
  it("uses the same content policy and security headers as the control service", async () => {
    expect(gatewayWorker.WORKER_CSP).toBe(GATEWAY_CSP);
    expect(gatewayWorker.WORKER_SECURITY_HEADERS).toEqual(GATEWAY_SECURITY_HEADERS);
    expect(gatewayWorker.WORKER_CACHE_CONTROL["no-store"]).toBe("private, no-store");
    expect(gatewayWorker.WORKER_CACHE_CONTROL.immutable).toBe("private, max-age=300, immutable");
  });

  it("decides the cache policy for the same paths the gateway does", async () => {
    for (const p of ["assets/app-abc123.js", "index.html", "assets/logo.svg", "assets/index-4f2a9c1b.css"])
      expect(gatewayWorker.HASHED_ASSET_RE.test(p), p).toBe(isHashedAssetPath(p));
  });

  it("issues the identical SQL the local broker issues", async () => {
    const shared: Record<keyof typeof brokerWorker.BROKER_SQL, string> = {
      SELECT_REQUEST_BY_ID: trackerSql.SELECT_REQUEST_BY_ID,
      SELECT_REQUESTS_PAGE: trackerSql.SELECT_REQUESTS_PAGE,
      INSERT_REQUEST_WITHIN_QUOTA: trackerSql.INSERT_REQUEST_WITHIN_QUOTA,
      UPDATE_REQUEST_CAS: trackerSql.UPDATE_REQUEST_CAS,
      SELECT_STORAGE_BYTES: trackerSql.SELECT_STORAGE_BYTES,
      UPDATE_STORAGE_ADD: trackerSql.UPDATE_STORAGE_ADD,
      SELECT_WRITE_BY_ID: trackerSql.SELECT_WRITE_BY_ID,
      INSERT_WRITE: trackerSql.INSERT_WRITE,
    };
    for (const [name, statement] of Object.entries(shared))
      expect(brokerWorker.BROKER_SQL[name as keyof typeof shared], name).toBe(statement);
  });

  it("keeps its one D1-only statement clearly outside that set", async () => {
    expect(brokerWorker.D1_DELETE_WRITE).toBe("DELETE FROM writes WHERE write_id = ?");
    expect(Object.values(trackerSql)).not.toContain(brokerWorker.D1_DELETE_WRITE);
  });
});

/* ----------------------------- the edge gateway --------------------------- */

interface DispatchLog {
  asked: string[];
  received: Request[];
}

function fakeDispatch(log: DispatchLog, answer: () => Response) {
  return {
    get(name: string) {
      log.asked.push(name);
      return {
        async fetch(request: Request) {
          log.received.push(request);
          return answer();
        },
      };
    },
  };
}

function policyFetch(decision: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(decision), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

const SERVE = {
  decision: "serve",
  status: 200,
  release: { id: "rel-1", digest: "d".repeat(64), number: 3, script: "zenith-alpha-r3-dddddddddddd" },
  session: { subject: "sub-1", email: "owner@example.test", role: "owner" },
};

const edgeRequest = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://alpha.apps.example.com${path}`, {
    headers: { host: "alpha.apps.example.com", ...((init.headers ?? {}) as Record<string, string>) },
    ...init,
  });

describe("the dispatch worker", () => {
  const env = (fetchImpl: typeof globalThis.fetch, log: DispatchLog, answer = () => new Response("page")) => {
    globalThis.fetch = fetchImpl;
    return {
      DISPATCH: fakeDispatch(log, answer) as unknown as DispatchNamespace,
      POLICY_URL: "https://control.example/api/hosted/policy/admit",
      POLICY_SECRET: "shared-secret",
    };
  };

  it("never invokes a script for a denied request", async () => {
    const log: DispatchLog = { asked: [], received: [] };
    const original = globalThis.fetch;
    try {
      const res = await gatewayWorker.default.fetch(
        edgeRequest("/"),
        env(policyFetch({ decision: "deny", status: 401, code: "sign_in_required" }), log),
        {} as ExecutionContext
      );
      expect(res.status).toBe(401);
      expect(log.asked).toEqual([]);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("sign_in_required");
      expect(res.headers.get("content-security-policy")).toBe(GATEWAY_CSP);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats an unreachable policy as a denial, not as a pass", async () => {
    const log: DispatchLog = { asked: [], received: [] };
    const original = globalThis.fetch;
    try {
      const failing = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof globalThis.fetch;
      const res = await gatewayWorker.default.fetch(edgeRequest("/"), env(failing, log), {} as ExecutionContext);
      expect(res.status).toBe(503);
      expect(log.asked).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("dispatches the named script and strips every platform credential first", async () => {
    const log: DispatchLog = { asked: [], received: [] };
    const original = globalThis.fetch;
    try {
      const res = await gatewayWorker.default.fetch(
        edgeRequest("/assets/app-abc123.js", {
          headers: {
            cookie: "__Host-zenith_app=opaque; sb-access-token=platform",
            authorization: "Bearer something",
            "x-zenith-role": "owner",
          },
        }),
        env(policyFetch(SERVE), log, () => new Response("body", { headers: { "set-cookie": "evil=1" } })),
        {} as ExecutionContext
      );

      expect(log.asked).toEqual([SERVE.release.script]);
      const forwarded = log.received[0];
      expect(forwarded.headers.get("cookie")).toBeNull();
      expect(forwarded.headers.get("authorization")).toBeNull();
      expect(forwarded.headers.get("x-zenith-subject")).toBe("sub-1");
      expect(forwarded.headers.get("x-zenith-role")).toBe("owner");
      expect(forwarded.headers.get("x-zenith-release")).toBe("rel-1");

      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("x-zenith-release")).toBe("rel-1");
      expect(res.headers.get("cache-control")).toBe("private, max-age=300, immutable");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends a data path to the broker script the policy named", async () => {
    const log: DispatchLog = { asked: [], received: [] };
    const original = globalThis.fetch;
    try {
      await gatewayWorker.default.fetch(
        edgeRequest("/_zenith/data/v1/requests"),
        env(
          policyFetch({
            ...SERVE,
            reserved: "data.requests",
            release: { ...SERVE.release, script: "zenith-alpha-broker" },
          }),
          log
        ),
        {} as ExecutionContext
      );
      expect(log.asked).toEqual(["zenith-alpha-broker"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses to invent the control-service reserved pages, and says what to route", async () => {
    const log: DispatchLog = { asked: [], received: [] };
    const original = globalThis.fetch;
    try {
      const res = await gatewayWorker.default.fetch(
        edgeRequest("/_zenith/auth/signin"),
        env(policyFetch({ decision: "serve", status: 200, reserved: "auth.signin" }), log),
        {} as ExecutionContext
      );
      expect(res.status).toBe(503);
      expect(log.asked).toEqual([]);
      const body = (await res.json()) as { error: { fix: string } };
      expect(body.error.fix).toContain("control service");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reads only its own cookie out of the header it forwards to the policy", async () => {
    expect(gatewayWorker.readSessionCookie("a=1; __Host-zenith_app=opaque; b=2")).toBe("opaque");
    expect(gatewayWorker.readSessionCookie("sb-access-token=platform")).toBeUndefined();
    expect(gatewayWorker.readSessionCookie(null)).toBeUndefined();
  });
});

/* ------------------------------- the broker ------------------------------- */

interface D1Call {
  sql: string;
  values: unknown[];
}

/** A D1 double: records every statement, answers from a table of canned rows. */
async function fakeD1(rows: Record<string, unknown[]>, changes: Record<string, number> = {}) {
  const calls: D1Call[] = [];
  const make = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => make(sql, next),
    first: async <T,>() => {
      calls.push({ sql, values });
      return ((rows[sql] ?? [])[0] ?? null) as T | null;
    },
    all: async <T,>() => {
      calls.push({ sql, values });
      return { results: (rows[sql] ?? []) as T[], success: true, meta: { changes: 0, last_row_id: 0 } };
    },
    run: async () => {
      calls.push({ sql, values });
      return { results: [], success: true, meta: { changes: changes[sql] ?? 1, last_row_id: 0 } };
    },
  });
  const db: D1Database = {
    prepare: (sql: string) => make(sql),
    batch: async <T,>(statements: D1PreparedStatement[]) => {
      const out: D1Result<T>[] = [];
      for (const statement of statements) out.push((await statement.run()) as unknown as D1Result<T>);
      return out;
    },
  };
  return { db, calls };
}

const brokerRequest = (path: string, init: RequestInit & { role?: string } = {}): Request =>
  new Request(`https://alpha.apps.example.com${path}`, {
    ...init,
    headers: {
      "x-zenith-subject": "sub-1",
      "x-zenith-email": "ed@example.test",
      "x-zenith-role": init.role ?? "editor",
      "x-zenith-release": "rel-1",
      ...((init.headers ?? {}) as Record<string, string>),
    },
  });

const REQUESTS = "/_zenith/data/v1/requests";

const storedRow = {
  id: "rec-1",
  title: "Standing desk",
  details: "",
  category: "furniture",
  quantity: 1,
  priority: "normal",
  status: "requested",
  requested_for: "",
  needed_by: null,
  version: 1,
  created_by: "sub-1",
  created_by_email: "ed@example.test",
  created_at: "2026-09-07T09:00:00.000Z",
  updated_by: "sub-1",
  updated_by_email: "ed@example.test",
  updated_at: "2026-09-07T09:00:00.000Z",
  logical_bytes: 300,
};

describe("the broker worker", () => {
  it("refuses a request that did not arrive through the dispatch worker", async () => {
    const { db, calls } = await fakeD1({});
    const res = await brokerWorker.default.fetch(
      new Request(`https://alpha.apps.example.com${REQUESTS}`),
      { DB: db }
    );
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a viewer's write before it touches the database", async () => {
    const { db, calls } = await fakeD1({});
    const res = await brokerWorker.default.fetch(
      brokerRequest(REQUESTS, {
        method: "POST",
        role: "viewer",
        body: JSON.stringify({ writeId: crypto.randomUUID(), record: { title: "x", category: "other" } }),
      }),
      { DB: db }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect(calls).toEqual([]);
  });

  it("creates through the same conditional insert the local runtime uses", async () => {
    const { db, calls } = await fakeD1({});
    const res = await brokerWorker.default.fetch(
      brokerRequest(REQUESTS, {
        method: "POST",
        body: JSON.stringify({
          writeId: "11111111-1111-4111-8111-111111111111",
          record: { title: "Standing desk", category: "furniture" },
        }),
      }),
      { DB: db }
    );
    expect(res.status).toBe(201);
    const record = ((await res.json()) as { record: { title: string; version: number } }).record;
    expect(record.title).toBe("Standing desk");
    expect(record.version).toBe(1);

    const issued = calls.map((c) => c.sql);
    expect(issued).toContain(brokerWorker.BROKER_SQL.SELECT_WRITE_BY_ID);
    expect(issued).toContain(brokerWorker.BROKER_SQL.INSERT_REQUEST_WITHIN_QUOTA);
    expect(issued).toContain(brokerWorker.BROKER_SQL.UPDATE_STORAGE_ADD);
    expect(issued).toContain(brokerWorker.BROKER_SQL.INSERT_WRITE);
  });

  it("compensates the write ledger when the quota refuses the row", async () => {
    const { db, calls } = await fakeD1(
      { [brokerWorker.BROKER_SQL.SELECT_STORAGE_BYTES]: [{ logical_bytes: 104857600 }] },
      { [brokerWorker.BROKER_SQL.INSERT_REQUEST_WITHIN_QUOTA]: 0 }
    );
    const res = await brokerWorker.default.fetch(
      brokerRequest(REQUESTS, {
        method: "POST",
        body: JSON.stringify({
          writeId: "22222222-2222-4222-8222-222222222222",
          record: { title: "Standing desk", category: "furniture" },
        }),
      }),
      { DB: db }
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("quota_exceeded");
    expect(calls.map((c) => c.sql)).toContain(brokerWorker.D1_DELETE_WRITE);
    const undone = calls.find(
      (c) => c.sql === brokerWorker.BROKER_SQL.UPDATE_STORAGE_ADD && Number(c.values[0]) < 0
    );
    expect(undone).toBeTruthy();
  });

  it("answers a stale update with 409 and the record as it stands", async () => {
    const { db } = await fakeD1({ [brokerWorker.BROKER_SQL.SELECT_REQUEST_BY_ID]: [{ ...storedRow, version: 4 }] });
    const res = await brokerWorker.default.fetch(
      brokerRequest(`${REQUESTS}/rec-1`, {
        method: "PATCH",
        body: JSON.stringify({
          writeId: "33333333-3333-4333-8333-333333333333",
          expectedVersion: 1,
          patch: { status: "approved" },
        }),
      }),
      { DB: db }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: { current: { version: number } } } };
    expect(body.error.code).toBe("stale_version");
    expect(body.error.details.current.version).toBe(4);
  });

  it("replays a write id rather than writing twice", async () => {
    const writeId = "44444444-4444-4444-8444-444444444444";
    const record = { ...storedRow, requestedFor: "" };
    const hash = await brokerWorker.writeIntentHash("create", "alpha.apps.example.com", "sub-1", null, {
      writeId,
      record: {
        title: "Standing desk",
        details: "",
        category: "furniture",
        quantity: 1,
        priority: "normal",
        status: "requested",
        requestedFor: "",
        neededBy: null,
      },
    });
    const { db } = await fakeD1({
      [brokerWorker.BROKER_SQL.SELECT_WRITE_BY_ID]: [
        { write_id: writeId, intent_hash: hash, result: JSON.stringify(record), op: "create", created_at: "" },
      ],
    });
    const res = await brokerWorker.default.fetch(
      brokerRequest(REQUESTS, {
        method: "POST",
        body: JSON.stringify({ writeId, record: { title: "Standing desk", category: "furniture" } }),
      }),
      { DB: db }
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-zenith-replayed")).toBe("true");
  });

  it("refuses a write id reused for different content", async () => {
    const writeId = "55555555-5555-4555-8555-555555555555";
    const { db } = await fakeD1({
      [brokerWorker.BROKER_SQL.SELECT_WRITE_BY_ID]: [
        { write_id: writeId, intent_hash: "0".repeat(64), result: "{}", op: "create", created_at: "" },
      ],
    });
    const res = await brokerWorker.default.fetch(
      brokerRequest(REQUESTS, {
        method: "POST",
        body: JSON.stringify({ writeId, record: { title: "Something else", category: "other" } }),
      }),
      { DB: db }
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });

  it("answers 405 with allow, and 404 for a path outside its prefix", async () => {
    const { db } = await fakeD1({});
    const wrongMethod = await brokerWorker.default.fetch(
      brokerRequest(REQUESTS, { method: "PATCH", body: "{}" }),
      { DB: db }
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, POST");

    const elsewhere = await brokerWorker.default.fetch(brokerRequest("/_zenith/session"), { DB: db });
    expect(elsewhere.status).toBe(404);
  });

  it("bounds the body it will read", async () => {
    const { db, calls } = await fakeD1({});
    const res = await brokerWorker.default.fetch(
      brokerRequest(REQUESTS, {
        method: "POST",
        body: JSON.stringify({ writeId: crypto.randomUUID(), record: { title: "x".repeat(2_000_000) } }),
      }),
      { DB: db }
    );
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });
});
