/**
 * The client, against a fetch that answers whatever the case under test needs.
 *
 * The behaviours worth pinning down are the ones a person would otherwise only
 * discover from corrupted data: a write id that survives a retry, a conflict
 * that carries the record it lost to, a 401 that leaves rather than loops, and
 * an error envelope decoded rather than guessed.
 *
 * Workstream W4 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  configureApi,
  createRequest,
  getRequest,
  getSession,
  listRequests,
  resetApi,
  signOut,
  staleVersionDetails,
  updateRequest,
  type EquipmentRequest,
  type EquipmentRequestInput,
} from "../../../fixtures/tracker-app/src/api";

interface Call {
  path: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let minted = 0;

function record(overrides: Partial<EquipmentRequest> = {}): EquipmentRequest {
  return {
    id: "req-1",
    version: 1,
    title: "Standing desk",
    details: "",
    category: "furniture",
    quantity: 1,
    priority: "normal",
    status: "requested",
    requestedFor: "Sam",
    neededBy: null,
    createdBy: "sub-1",
    createdByEmail: "owner@example.test",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedBy: "sub-1",
    updatedByEmail: "owner@example.test",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

const input: EquipmentRequestInput = {
  title: "Standing desk",
  details: "",
  category: "furniture",
  quantity: 1,
  priority: "normal",
  status: "requested",
  requestedFor: "Sam",
  neededBy: null,
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const refusal = (
  status: number,
  code: string,
  message: string,
  extra: { fix?: string; details?: Record<string, unknown> } = {}
): Response => json(status, { error: { code, message, ...extra } });

/** Answers each call from the queue; a function may throw to model a dropped connection. */
function stub(answers: (Response | (() => Response))[]): void {
  let index = 0;
  configureApi({
    fetch: async (path, init) => {
      const raw = typeof init.body === "string" ? init.body : null;
      calls.push({ path, init, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return typeof answer === "function" ? answer() : answer;
    },
  });
}

beforeEach(() => {
  calls = [];
  minted = 0;
  resetApi();
  configureApi({
    sleep: async () => {},
    newWriteId: () => {
      minted += 1;
      return `write-${minted}`;
    },
  });
});

afterEach(resetApi);

describe("write ids", () => {
  it("reuses one write id when a dropped connection is retried", async () => {
    const drop = () => {
      throw new TypeError("fetch failed");
    };
    stub([drop, json(201, { record: record() })]);

    const created = await createRequest(input);

    expect(created.id).toBe("req-1");
    expect(calls).toHaveLength(2);
    expect(minted, "the id is minted once per operation, not once per attempt").toBe(1);
    expect(calls[0].body?.writeId).toBe("write-1");
    expect(calls[1].body?.writeId).toBe("write-1");
    expect(calls[0].body).toEqual(calls[1].body);
  });

  it("honours a write id the caller already holds", async () => {
    stub([json(201, { record: record() })]);
    await createRequest(input, { writeId: "held-by-the-screen" });
    expect(calls[0].body?.writeId).toBe("held-by-the-screen");
    expect(minted).toBe(0);
  });

  it("sends mutations as JSON with the session cookie and nothing else", async () => {
    stub([json(200, { record: record({ version: 2 }) })]);
    await updateRequest("req-1", { expectedVersion: 1, patch: { status: "approved" } });

    const [call] = calls;
    expect(call.path).toBe("/_zenith/data/v1/requests/req-1");
    expect(call.init.method).toBe("PATCH");
    expect(call.init.credentials).toBe("same-origin");
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(call.body).toEqual({
      writeId: "write-1",
      expectedVersion: 1,
      patch: { status: "approved" },
    });
  });
});

describe("retries", () => {
  it("gives up after three attempts and reports the last failure", async () => {
    stub([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(createRequest(input)).rejects.toMatchObject({ code: "network" });
    expect(calls).toHaveLength(3);
    expect(minted).toBe(1);
  });

  it("retries a 503 with the same write id", async () => {
    stub([
      refusal(503, "runtime_unavailable", "The app service is not answering."),
      json(201, { record: record() }),
    ]);
    await createRequest(input);
    expect(calls).toHaveLength(2);
    expect(calls[0].body?.writeId).toBe(calls[1].body?.writeId);
  });

  it("does not retry a decided refusal", async () => {
    stub([refusal(429, "quota_exceeded", "This app has reached its limit for today.")]);
    await expect(listRequests()).rejects.toMatchObject({ code: "quota_exceeded", status: 429 });
    expect(calls).toHaveLength(1);
  });
});

describe("refusals", () => {
  it("decodes the error envelope whole", async () => {
    stub([
      refusal(400, "invalid_input", "Title is required.", {
        fix: "Give the request a title, then send it again.",
        details: { field: "title" },
      }),
    ]);
    const err = await createRequest(input).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.code).toBe("invalid_input");
    expect(api.status).toBe(400);
    expect(api.message).toBe("Title is required.");
    expect(api.fix).toBe("Give the request a title, then send it again.");
    expect(api.details).toEqual({ field: "title" });
  });

  it("keeps the host's words when the code is one this version never heard of", async () => {
    stub([refusal(409, "some_future_rule", "That is not allowed yet.")]);
    const err = (await createRequest(input).catch((caught: unknown) => caught)) as ApiError;
    expect(err.code).toBe("unsupported");
    expect(err.rawCode).toBe("some_future_rule");
    expect(err.message).toBe("That is not allowed yet.");
  });

  it("falls back to a readable message when the body is not an envelope", async () => {
    stub([new Response("<html>gateway</html>", { status: 503 })]);
    const err = (await listRequests().catch((caught: unknown) => caught)) as ApiError;
    expect(err.code).toBe("runtime_unavailable");
    expect(err.message).toBe("The app service is not answering.");
  });

  it("exposes the current record a 409 carries", async () => {
    const current = record({ version: 4, status: "approved", updatedByEmail: "ed@example.test" });
    stub([
      refusal(409, "stale_version", "Someone changed this first.", {
        details: { expectedVersion: 1, current },
      }),
    ]);
    const err = await updateRequest("req-1", {
      expectedVersion: 1,
      patch: { title: "Standing desk, electric" },
    }).catch((caught: unknown) => caught);

    const stale = staleVersionDetails(err);
    expect(stale?.expectedVersion).toBe(1);
    expect(stale?.current.version).toBe(4);
    expect(stale?.current.status).toBe("approved");
  });

  it("leaves for the sign-in page on a 401 instead of retrying", async () => {
    const went: string[] = [];
    configureApi({ navigate: (url) => went.push(url) });
    stub([refusal(401, "sign_in_required", "Your session has ended.")]);

    await expect(getSession()).rejects.toMatchObject({ code: "sign_in_required" });
    expect(went).toEqual(["/_zenith/auth/signin"]);
    expect(calls).toHaveLength(1);
  });

  it("reports a denial as forbidden and navigates nowhere", async () => {
    const went: string[] = [];
    configureApi({ navigate: (url) => went.push(url) });
    stub([refusal(403, "forbidden", "Viewers cannot change requests.")]);

    await expect(
      updateRequest("req-1", { expectedVersion: 1, patch: { status: "approved" } })
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(went).toEqual([]);
  });
});

describe("reads", () => {
  it("builds the list query from the filters it was given", async () => {
    stub([json(200, { items: [record()], nextCursor: "c2" })]);
    const page = await listRequests({ limit: 25, status: "approved", category: "laptop" });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("c2");
    const url = new URL(calls[0].path, "https://app.example.test");
    expect(url.pathname).toBe("/_zenith/data/v1/requests");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("status")).toBe("approved");
    expect(url.searchParams.get("category")).toBe("laptop");
    expect(url.searchParams.get("cursor")).toBeNull();
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("reads one request whether or not the host wraps it", async () => {
    stub([json(200, { record: record() })]);
    expect((await getRequest("req-1")).id).toBe("req-1");
    stub([json(200, record({ id: "req-9" }))]);
    expect((await getRequest("req-9")).id).toBe("req-9");
  });

  it("refuses a body it cannot read rather than pretending", async () => {
    stub([json(200, { items: "not a list" })]);
    await expect(listRequests()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("signs out with a POST the gateway can check the origin of", async () => {
    stub([new Response(null, { status: 204 })]);
    await signOut();
    expect(calls[0].path).toBe("/_zenith/auth/signout");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json"
    );
  });
});
