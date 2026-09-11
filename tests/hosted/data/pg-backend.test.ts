/**
 * `PgDataBackend` and `PgTrackerStore` against a PostgREST double injected at
 * `fetch`.
 *
 * Mocked at the transport rather than at the client on purpose: the thing worth
 * pinning is the *request* — that the version guard really is in the PATCH's
 * query string, that the keyset predicate really is an `or=(…)` group, that
 * every single request is confined to one `app_id`. A mocked `SupabaseClient`
 * would let all three drift without a test noticing, because the assertion
 * would be about the call we made to our own double.
 *
 * What is not covered here is whether Postgres agrees. That is
 * `pg-contract.live.test.ts`, which needs migration 0003 applied.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateRequestBody,
  type DataContext,
  type EquipmentRequest,
  HostedError,
} from "@/lib/hosted/contracts";
import { IDENTITIES } from "../_fixtures";
import { RELEASE_ID, input } from "./_helpers";

const { PgDataBackend, PgTrackerStore, logicalBytes, writeIntentHash } = await import(
  "@/lib/hosted/data"
);

const APP = "pg-app-alpha";
const SUPABASE_URL = "https://project.supabase.test";

/* --------------------------------- harness -------------------------------- */

/** One recorded request: everything an assertion here cares about. */
interface Call {
  method: string;
  url: string;
  /** `app_records`, `app_writes`, `app_storage` or `rpc/<function>`. */
  key: string;
  body: unknown;
}

interface Reply {
  status?: number;
  body: unknown;
}

/**
 * A PostgREST double.
 *
 * `queue(key, body)` supplies the next answer for `GET app_records`,
 * `POST rpc/app_storage_add` and so on; anything not queued answers an empty
 * result, which is what "no such row" looks like over PostgREST.
 */
function harness() {
  const calls: Call[] = [];
  const replies = new Map<string, Reply[]>();

  const fetchDouble: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname.replace(/^\/rest\/v1\//, "");
    const key = `${method} ${path}`;
    const raw = init?.body;
    calls.push({
      method,
      url,
      key: path,
      body: typeof raw === "string" && raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
    });
    const next = replies.get(key)?.shift() ?? { body: [] };
    return new Response(JSON.stringify(next.body ?? []), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  const backend = new PgDataBackend({ appId: APP, fetch: fetchDouble });
  const store = new PgTrackerStore({ backend, appId: APP, limits: { storageBytes: 100_000 } });

  return {
    backend,
    store,
    calls,
    queue(key: string, body: unknown, status?: number) {
      const list = replies.get(key) ?? [];
      list.push({ body, status });
      replies.set(key, list);
    },
    /** Every call whose table/function matches, in the order they were made. */
    of(key: string): Call[] {
      return calls.filter((call) => call.key === key);
    },
  };
}

function ctx(role: DataContext["role"] = "editor"): DataContext {
  return {
    appId: APP,
    subject: IDENTITIES.editor.subject,
    email: IDENTITIES.editor.email,
    role,
    releaseId: RELEASE_ID,
  };
}

const STORED: EquipmentRequest = {
  id: "3f7c0f5e-1111-4111-8111-aaaaaaaaaaaa",
  title: "Standing desk",
  details: "Adjustable, 160cm",
  category: "furniture",
  quantity: 1,
  priority: "normal",
  status: "requested",
  requestedFor: "Sam Rivera",
  neededBy: "2026-10-01",
  version: 1,
  createdBy: IDENTITIES.editor.subject,
  createdByEmail: IDENTITIES.editor.email,
  createdAt: "2026-09-07T10:00:00.000Z",
  updatedBy: IDENTITIES.editor.subject,
  updatedByEmail: IDENTITIES.editor.email,
  updatedAt: "2026-09-07T10:00:00.000Z",
};

/** One `hosted.app_records` row as PostgREST would return it. */
function pgRow(record: EquipmentRequest) {
  return {
    record_id: record.id,
    subject: record.createdBy,
    version: record.version,
    logical_bytes: logicalBytes(record),
    body: record,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
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

/**
 * Fake credentials, set for the whole file. The client is built from the
 * environment exactly as it is in production — only the transport is replaced —
 * so these have to be present, and they deliberately are not the real ones: no
 * request from this file leaves the process.
 */
const realEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-not-a-real-one";
});

afterAll(() => {
  if (realEnv.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = realEnv.url;
  if (realEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = realEnv.key;
});

/* ---------------------------------- scope --------------------------------- */

describe("every request PgDataBackend makes", () => {
  it("is confined to the one app the backend was built for", async () => {
    const h = harness();
    h.queue("GET app_records", [pgRow(STORED)]);
    await h.store.get(ctx("viewer"), STORED.id);
    await h.store.storageBytes(APP);

    expect(h.calls.length).toBeGreaterThan(0);
    for (const call of h.calls) {
      expect(decodeURIComponent(call.url)).toContain(`app_id=eq.${APP}`);
    }
  });

  it("refuses a statement it has no mapping for instead of answering an empty result", async () => {
    const h = harness();
    const error = await refusal(() => h.backend.all("SELECT 1"));
    expect(error.code).toBe("internal");
    expect(error.message).toContain("no mapping");
    expect(h.calls).toHaveLength(0);
  });
});

/* ----------------------------- compare and swap ---------------------------- */

describe("the version check", () => {
  it("rides in the PATCH, so the guard cannot be lost between the read and the write", async () => {
    const h = harness();
    h.queue("GET app_writes", []); // the write id is new
    h.queue("GET app_records", [pgRow(STORED)]); // the store's read
    h.queue("GET app_records", [pgRow(STORED)]); // the backend's read, to merge the jsonb
    h.queue("PATCH app_records", [{ record_id: STORED.id }]); // one row changed

    const result = await h.store.update(ctx(), STORED.id, {
      writeId: "11111111-2222-4222-8222-333333333333",
      expectedVersion: 1,
      patch: { status: "approved" },
    });

    expect(result.replayed).toBe(false);
    expect(result.record.version).toBe(2);
    expect(result.record.status).toBe("approved");
    // untouched fields survive the read-merge-write
    expect(result.record.title).toBe(STORED.title);
    expect(result.record.createdAt).toBe(STORED.createdAt);

    const patch = h.of("app_records").find((call) => call.method === "PATCH");
    expect(patch).toBeDefined();
    expect(decodeURIComponent(patch!.url)).toContain("version=eq.1");
    expect(decodeURIComponent(patch!.url)).toContain(`record_id=eq.${STORED.id}`);
    expect((patch!.body as { version: number }).version).toBe(2);
  });

  it("answers stale_version with what is stored now when the PATCH changes no row", async () => {
    const h = harness();
    const moved: EquipmentRequest = { ...STORED, version: 2, status: "ordered" };
    h.queue("GET app_writes", []);
    h.queue("GET app_records", [pgRow(STORED)]); // the store read version 1
    h.queue("GET app_records", [pgRow(moved)]); // the backend's merge read
    h.queue("PATCH app_records", []); // …and another writer had already moved it
    h.queue("GET app_records", [pgRow(moved)]); // the store re-reads to report

    const error = await refusal(() =>
      h.store.update(ctx(), STORED.id, {
        writeId: "11111111-2222-4222-8222-444444444444",
        expectedVersion: 1,
        patch: { status: "approved" },
      })
    );

    expect(error.code).toBe("stale_version");
    expect((error.details as { current: EquipmentRequest }).current.version).toBe(2);
    expect((error.details as { current: EquipmentRequest }).current.status).toBe("ordered");
    // Nothing was recorded: the caller has to re-base under a NEW write id, and
    // reserving this one would refuse that retry.
    expect(h.of("app_writes").filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

/* ---------------------------------- quota --------------------------------- */

describe("quota admission", () => {
  it("is the one round trip the function answers, and a refusal writes nothing", async () => {
    const h = harness();
    h.queue("GET app_writes", []);
    h.queue("POST rpc/app_record_insert_within_quota", 0); // refused: it would not fit
    h.queue("GET app_records", []); // the refusal reports current usage
    h.queue("GET app_storage", [{ logical_bytes: 99_950 }]);

    const error = await refusal(() =>
      h.store.create(ctx(), { writeId: "55555555-2222-4222-8222-333333333333", record: input() })
    );

    expect(error.code).toBe("quota_exceeded");
    expect(error.message).toContain("99950 of its 100000 logical bytes");
    expect(error.message).toContain("logical bytes: the UTF-8 JSON size");
    expect((error.details as { limitLogicalBytes: number }).limitLogicalBytes).toBe(100_000);

    // No row and no ledger entry: the comparison is inside the insert.
    expect(h.of("app_records").filter((call) => call.method === "POST")).toHaveLength(0);
    expect(h.of("app_writes").filter((call) => call.method === "POST")).toHaveLength(0);
    expect(h.of("rpc/app_storage_add")).toHaveLength(0);
  });

  it("sends the same logical-byte figure the SQLite path would have measured", async () => {
    const h = harness();
    h.queue("GET app_writes", []);
    h.queue("POST rpc/app_record_insert_within_quota", 1);

    const result = await h.store.create(ctx(), {
      writeId: "55555555-2222-4222-8222-666666666666",
      record: input(),
    });

    const rpc = h.of("rpc/app_record_insert_within_quota")[0];
    const sent = rpc.body as { p_logical_bytes: number; p_limit_bytes: number; p_body: EquipmentRequest };
    expect(sent.p_logical_bytes).toBe(logicalBytes(result.record));
    expect(sent.p_limit_bytes).toBe(100_000);
    expect(sent.p_body.id).toBe(result.record.id);

    // …and the counter is NOT moved again afterwards: the admission function
    // already did it, under the same row lock as the comparison.
    expect(h.of("rpc/app_storage_add")).toHaveLength(0);
  });
});

/* ------------------------------- idempotency ------------------------------ */

describe("a retried write id", () => {
  it("replays the recorded result without touching a record again", async () => {
    const h = harness();
    const body = { writeId: "77777777-2222-4222-8222-333333333333", record: input() };
    const parsed = CreateRequestBody.parse(body);
    const hash = writeIntentHash("create", APP, IDENTITIES.editor.subject, null, parsed);

    h.queue("GET app_writes", [
      {
        write_id: body.writeId,
        subject: IDENTITIES.editor.subject,
        op: "create",
        record_id: STORED.id,
        intent_hash: hash,
        status_code: 201,
        result: STORED, // jsonb, not the TEXT the SQLite ledger holds
        at: STORED.createdAt,
      },
    ]);

    const result = await h.store.create(ctx(), body);

    expect(result.replayed).toBe(true);
    expect(result.record).toEqual(STORED);
    expect(h.of("rpc/app_record_insert_within_quota")).toHaveLength(0);
    expect(h.of("app_records")).toHaveLength(0);
  });

  it("is refused when it carries a different change", async () => {
    const h = harness();
    h.queue("GET app_writes", [
      {
        write_id: "77777777-2222-4222-8222-999999999999",
        subject: IDENTITIES.editor.subject,
        op: "create",
        record_id: STORED.id,
        intent_hash: "a-hash-of-some-other-intent",
        status_code: 201,
        result: STORED,
        at: STORED.createdAt,
      },
    ]);

    const error = await refusal(() =>
      h.store.create(ctx(), {
        writeId: "77777777-2222-4222-8222-999999999999",
        record: input({ title: "Something else entirely" }),
      })
    );

    expect(error.code).toBe("idempotency_conflict");
    expect(h.of("rpc/app_record_insert_within_quota")).toHaveLength(0);
  });
});

/* ------------------------------ cursor paging ----------------------------- */

describe("cursor paging", () => {
  it("asks for one row more than the page, and hands back a cursor only when there is one", async () => {
    const h = harness();
    const rows = [0, 1, 2].map((n) =>
      pgRow({
        ...STORED,
        id: `3f7c0f5e-1111-4111-8111-00000000000${n}`,
        createdAt: `2026-09-07T10:00:0${n}.000Z`,
      })
    );
    // newest first, and one extra so "there is another page" is visible
    h.queue("GET app_records", [rows[2], rows[1], rows[0]]);

    const page = await h.store.list(ctx("viewer"), { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
    const url = decodeURIComponent(h.of("app_records")[0].url);
    expect(url).toContain("limit=3");
    expect(url).toContain("order=created_at.desc,record_id.desc");
  });

  it("turns the cursor back into the keyset predicate, not an OFFSET", async () => {
    const h = harness();
    const last = { ...STORED, createdAt: "2026-09-07T10:00:02.000Z" };
    const older = {
      ...STORED,
      id: "3f7c0f5e-1111-4111-8111-bbbbbbbbbbbb",
      createdAt: "2026-09-07T10:00:01.000Z",
    };
    // limit + 1 rows come back, so the first page knows there is a second one
    h.queue("GET app_records", [pgRow(last), pgRow(older)]);
    const first = await h.store.list(ctx("viewer"), { limit: 1 });
    expect(first.nextCursor).toBeDefined();

    h.queue("GET app_records", []);
    await h.store.list(ctx("viewer"), { limit: 1, cursor: first.nextCursor ?? "" });

    const url = decodeURIComponent(h.of("app_records")[1].url);
    expect(url).not.toContain("offset");
    expect(url).toContain('created_at.lt."2026-09-07T10:00:02.000Z"');
    expect(url).toContain(`record_id.lt."${last.id}"`);
  });

  it("carries the tracker's two filters as jsonb predicates", async () => {
    const h = harness();
    h.queue("GET app_records", []);
    await h.store.list(ctx("viewer"), { status: "approved", category: "laptop", limit: 5 });

    const url = decodeURIComponent(h.of("app_records")[0].url);
    expect(url).toContain("body->>status=eq.approved");
    expect(url).toContain("body->>category=eq.laptop");
  });
});

/* -------------------------------- refusals -------------------------------- */

describe("when the hosted schema is not reachable", () => {
  it("says to apply 0003 and expose the schema, rather than reporting an empty app", async () => {
    const h = harness();
    h.queue(
      "GET app_records",
      { code: "PGRST106", message: "The schema must be one of the following: public" },
      406
    );

    const error = await refusal(() => h.store.get(ctx("viewer"), STORED.id));
    expect(error.code).toBe("runtime_unavailable");
    expect(error.message).toContain("not reachable");
    expect(error.fix).toContain("0003_hosted_app_data.sql");
    expect(error.fix).toContain("exposed schemas");
  });
});
