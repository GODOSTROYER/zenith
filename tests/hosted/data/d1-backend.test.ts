/**
 * `D1HttpBackend` against an injected fetch double: the exact request it makes,
 * where the token does and does not appear, how a batch is sent, and how a D1
 * refusal reaches the caller.
 *
 * No Cloudflare credentials exist on this machine and no live D1 database was
 * contacted (decision R3-03). This proves the request the adapter builds and
 * the way it reads a reply — it does not prove D1 accepts either.
 *
 * Workstream W3 (hosted R3).
 */
import { afterAll, describe, expect, it } from "vitest";
import { HostedError } from "@/lib/hosted/contracts";
import { isolatedDataDir, removeDir } from "../_fixtures";

const DATA_DIR = isolatedDataDir("zenith-data-d1-");

const { D1HttpBackend, trackerSql } = await import("@/lib/hosted/data");

afterAll(() => {
  removeDir(DATA_DIR);
});

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const DATABASE = "11111111-2222-3333-4444-555555555555";
const TOKEN = "cf-token-do-not-log";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch double that records every call and answers with the queued replies. */
function harness(replies: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  let index = 0;
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers,
      body: String(init?.body ?? ""),
    });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return reply();
  }) as typeof globalThis.fetch;
  return { calls, doFetch };
}

/** Cloudflare's success envelope for `n` statements. */
function ok(results: { rows?: Record<string, unknown>[]; changes?: number; lastRowId?: number }[]): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: results.map((r) => ({
          results: r.rows ?? [],
          success: true,
          meta: { changes: r.changes ?? 0, last_row_id: r.lastRowId ?? 0 },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
}

function backendWith(replies: (() => Response | Promise<Response>)[]) {
  const { calls, doFetch } = harness(replies);
  const backend = new D1HttpBackend({
    accountId: ACCOUNT,
    databaseId: DATABASE,
    token: TOKEN,
    fetch: doFetch,
  });
  return { backend, calls };
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

describe("the request D1HttpBackend builds", () => {
  it("posts { sql, params } to the documented query endpoint", async () => {
    const { backend, calls } = backendWith([ok([{ changes: 1, lastRowId: 7 }])]);
    const result = await backend.run(trackerSql.UPDATE_STORAGE_ADD, [128]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`
    );
    expect(backend.endpoint).toBe(calls[0].url);
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toEqual({ sql: trackerSql.UPDATE_STORAGE_ADD, params: [128] });
    expect(Object.keys(JSON.parse(calls[0].body)).sort()).toEqual(["params", "sql"]);
    expect(result).toEqual({ changes: 1, lastInsertRowid: 7 });
  });

  it("sends the token as Authorization: Bearer and nowhere else", async () => {
    const { backend, calls } = backendWith([ok([{ rows: [] }])]);
    await backend.all(trackerSql.COUNT_REQUESTS);

    const call = calls[0];
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(Object.keys(call.headers).sort()).toEqual(["authorization", "content-type"]);
    expect(call.url).not.toContain(TOKEN);
    expect(call.body).not.toContain(TOKEN);
    // The only place the token appears at all is the one header.
    const everythingElse = JSON.stringify({ ...call, headers: { ...call.headers, authorization: "" } });
    expect(everythingElse).not.toContain(TOKEN);
  });

  it("honours a base URL override without changing the path shape", async () => {
    const { doFetch } = harness([ok([{ rows: [] }])]);
    const backend = new D1HttpBackend({
      accountId: ACCOUNT,
      databaseId: DATABASE,
      token: TOKEN,
      fetch: doFetch,
      baseUrl: "https://d1.internal.test/v4/",
    });
    expect(backend.endpoint).toBe(`https://d1.internal.test/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`);
  });

  it("reads rows out of the first statement's results", async () => {
    const { backend } = backendWith([ok([{ rows: [{ id: "a" }, { id: "b" }] }])]);
    await expect(backend.all<{ id: string }>(trackerSql.SELECT_REQUESTS_PAGE, [null])).resolves.toEqual([
      { id: "a" },
      { id: "b" },
    ]);

    const single = backendWith([ok([{ rows: [{ logical_bytes: 42 }] }])]);
    await expect(single.backend.get<{ logical_bytes: number }>(trackerSql.SELECT_STORAGE_BYTES)).resolves.toEqual({
      logical_bytes: 42,
    });

    const empty = backendWith([ok([{ rows: [] }])]);
    await expect(empty.backend.get(trackerSql.SELECT_STORAGE_BYTES)).resolves.toBeUndefined();
  });
});

describe("transaction batching", () => {
  it("sends one request for every queued statement, in order", async () => {
    const { backend, calls } = backendWith([ok([{ changes: 1 }, { changes: 1 }, { changes: 1 }])]);

    const outcome = await backend.transaction((tx) => {
      tx.run(trackerSql.INSERT_REQUEST_WITHIN_QUOTA, ["id-1", "Laptop"]);
      tx.run(trackerSql.UPDATE_STORAGE_ADD, [200]);
      tx.run(trackerSql.INSERT_WRITE, ["write-1", "sub-1"]);
      return "planned";
    });

    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0].body) as { sql: string; params: unknown[] };
    expect(sent.sql).toBe(
      [trackerSql.INSERT_REQUEST_WITHIN_QUOTA, trackerSql.UPDATE_STORAGE_ADD, trackerSql.INSERT_WRITE].join(";\n")
    );
    expect(sent.params).toEqual(["id-1", "Laptop", 200, "write-1", "sub-1"]);

    expect(outcome.value).toBe("planned");
    expect(outcome.results).toEqual([
      { changes: 1, lastInsertRowid: 0 },
      { changes: 1, lastInsertRowid: 0 },
      { changes: 1, lastInsertRowid: 0 },
    ]);
  });

  it("reports each statement's changes, so a conditional write can be judged", async () => {
    // What a quota refusal looks like on D1: the conditional INSERT matched no
    // row, so it changed nothing.
    const { backend } = backendWith([ok([{ changes: 0 }, { changes: 1 }])]);
    const outcome = await backend.transaction((tx) => {
      tx.run(trackerSql.INSERT_REQUEST_WITHIN_QUOTA, []);
      tx.run(trackerSql.UPDATE_STORAGE_ADD, [10]);
    });
    expect(outcome.results[0].changes).toBe(0);
    expect(outcome.results[1].changes).toBe(1);
  });

  it("sends nothing at all when the callback queues nothing", async () => {
    const { backend, calls } = backendWith([ok([])]);
    const outcome = await backend.transaction(() => "nothing to do");
    expect(calls).toHaveLength(0);
    expect(outcome).toEqual({ value: "nothing to do", results: [] });
  });
});

describe("refusals", () => {
  it("surfaces a D1 error message as runtime_unavailable", async () => {
    const { backend } = backendWith([
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 7500, message: "no such table: equipment_requests" }],
            result: null,
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        ),
    ]);

    const error = await refusal(() => backend.run(trackerSql.COUNT_REQUESTS));
    expect(error.code).toBe("runtime_unavailable");
    expect(error.status).toBe(503);
    expect(error.message).toContain("no such table: equipment_requests");
    expect(error.message).toContain("7500");
    expect(error.fix).toContain("No data was written.");
  });

  it("surfaces a success:false body even on HTTP 200", async () => {
    const { backend } = backendWith([
      () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: "D1_ERROR: quota" }], result: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const error = await refusal(() => backend.all(trackerSql.COUNT_REQUESTS));
    expect(error.code).toBe("runtime_unavailable");
    expect(error.message).toContain("D1_ERROR: quota");
  });

  it("surfaces a transport failure without inventing a result", async () => {
    const { backend } = backendWith([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const error = await refusal(() => backend.run(trackerSql.COUNT_REQUESTS));
    expect(error.code).toBe("runtime_unavailable");
    expect(error.message).toContain("fetch failed");
  });

  it("surfaces a non-JSON reply rather than parsing garbage", async () => {
    const { backend } = backendWith([
      () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    ]);
    const error = await refusal(() => backend.run(trackerSql.COUNT_REQUESTS));
    expect(error.code).toBe("runtime_unavailable");
    expect(error.message).toContain("502");
    expect(error.message).toContain("not JSON");
  });

  it("fails the whole batch when D1 refuses it", async () => {
    const { backend, calls } = backendWith([
      () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: "CHECK constraint failed" }] }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const error = await refusal(() =>
      backend.transaction((tx) => {
        tx.run(trackerSql.INSERT_REQUEST_WITHIN_QUOTA, ["bad"]);
      })
    );
    expect(error.code).toBe("runtime_unavailable");
    expect(error.message).toContain("CHECK constraint failed");
    expect(calls).toHaveLength(1);
  });

  it("closes without holding anything open", () => {
    const { backend, calls } = backendWith([ok([])]);
    expect(() => backend.close()).not.toThrow();
    expect(() => backend.close()).not.toThrow();
    expect(calls).toHaveLength(0);
  });
});
