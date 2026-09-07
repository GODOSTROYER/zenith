/**
 * The role matrix, contract validation, and reading: create → get → list,
 * ordering, keyset pagination and filters.
 *
 * Workstream W3 (hosted R3).
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  HostedError,
  TRACKER_LIMITS,
  type EquipmentRequest,
  type EquipmentRequestInput,
} from "@/lib/hosted/contracts";
import { IDENTITIES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { badInput, ctx, input, nextMillisecond, strangerCtx } from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-data-store-");

const { closeAllAppData, openAppData } = await import("@/lib/hosted/data");

afterAll(() => {
  closeAllAppData();
  removeDir(DATA_DIR);
});

let appCounter = 0;
/** A brand-new app id, so each test owns its own database file. */
function freshApp(): string {
  appCounter += 1;
  return `store-app-${appCounter}`;
}

/** Runs `fn` and returns the HostedError it threw, failing the test if it threw anything else. */
async function refusal(fn: () => Promise<unknown>): Promise<HostedError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof HostedError) return error;
    throw error;
  }
  throw new Error("expected a HostedError, but the call succeeded");
}

describe("role matrix", () => {
  it("lets an owner and an editor create and update", async () => {
    const appId = freshApp();
    const { store } = openAppData(appId);

    const asOwner = ctx("owner", IDENTITIES.owner, appId);
    const created = await store.create(asOwner, { writeId: uuid(), record: input() });
    expect(created.record.version).toBe(1);
    expect(created.record.createdBy).toBe(IDENTITIES.owner.subject);

    const asEditor = ctx("editor", IDENTITIES.editor, appId);
    const updated = await store.update(asEditor, created.record.id, {
      writeId: uuid(),
      expectedVersion: 1,
      patch: { status: "approved" },
    });
    expect(updated.record.version).toBe(2);
    expect(updated.record.status).toBe("approved");
    expect(updated.record.updatedBy).toBe(IDENTITIES.editor.subject);
    expect(updated.record.createdBy).toBe(IDENTITIES.owner.subject);

    const editorCreated = await store.create(asEditor, { writeId: uuid(), record: input({ title: "Monitor" }) });
    expect(editorCreated.record.title).toBe("Monitor");
  });

  it("lets a viewer read but refuses every mutation, whatever the HTTP verb was", async () => {
    const appId = freshApp();
    const { store } = openAppData(appId);
    const asEditor = ctx("editor", IDENTITIES.editor, appId);
    const asViewer = ctx("viewer", IDENTITIES.viewer, appId);

    const seed = await store.create(asEditor, { writeId: uuid(), record: input() });

    await expect(store.get(asViewer, seed.record.id)).resolves.toMatchObject({ id: seed.record.id });
    await expect(store.list(asViewer, { limit: 25 })).resolves.toMatchObject({ items: [{ id: seed.record.id }] });

    const onCreate = await refusal(() => store.create(asViewer, { writeId: uuid(), record: input() }));
    expect(onCreate.code).toBe("forbidden");
    expect(onCreate.status).toBe(403);
    expect(onCreate.message).toContain("viewer");
    expect(onCreate.message).toContain("cannot create");

    const onUpdate = await refusal(() =>
      store.update(asViewer, seed.record.id, { writeId: uuid(), expectedVersion: 1, patch: { quantity: 2 } })
    );
    expect(onUpdate.code).toBe("forbidden");
    expect(onUpdate.message).toContain("cannot update");
  });

  it("writes nothing when a viewer is refused", async () => {
    const appId = freshApp();
    const { store } = openAppData(appId);
    const writeId = uuid();
    await refusal(() => store.create(ctx("viewer", IDENTITIES.viewer, appId), { writeId, record: input() }));

    expect((await store.list(ctx("viewer", IDENTITIES.viewer, appId), { limit: 25 })).items).toEqual([]);
    await expect(store.storageBytes(appId)).resolves.toBe(0);
  });

  it("refuses a role this app does not grant, though admission is the gateway's job", async () => {
    // The gateway admits on a live grant before the broker is reached, so a
    // stranger never gets this far in production (CONTRACTS-R3, admission
    // order). This is the store's own backstop, not the access control.
    const appId = freshApp();
    const { store } = openAppData(appId);
    const onRead = await refusal(() => store.list(strangerCtx(appId), { limit: 25 }));
    expect(onRead.code).toBe("forbidden");
    expect(onRead.message).toContain("not a role this app grants");

    const onWrite = await refusal(() => store.create(strangerCtx(appId), { writeId: uuid(), record: input() }));
    expect(onWrite.code).toBe("forbidden");
  });

  it("refuses a role that only exists on Object.prototype", async () => {
    // `APP_ROLE_RANK["constructor"]` is not undefined, so a plain bracket
    // lookup would read these as known roles.
    const appId = freshApp();
    const { store } = openAppData(appId);
    for (const role of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const context = { ...strangerCtx(appId), role: role as never };
      const onRead = await refusal(() => store.list(context, { limit: 25 }));
      expect(onRead.code).toBe("forbidden");
      const onWrite = await refusal(() => store.create(context, { writeId: uuid(), record: input() }));
      expect(onWrite.code).toBe("forbidden");
    }
    await expect(store.storageBytes(appId)).resolves.toBe(0);
  });

  it("refuses a context that names a different app", async () => {
    const appId = freshApp();
    const other = freshApp();
    const { store } = openAppData(appId);
    const wrong = await refusal(() => store.list(ctx("owner", IDENTITIES.owner, other), { limit: 25 }));
    expect(wrong.code).toBe("forbidden");
    expect(wrong.message).toContain(appId);
    expect(wrong.message).toContain(other);
  });
});

describe("validation", () => {
  const appId = freshApp();
  const store = openAppData(appId).store;
  const editor = ctx("editor", IDENTITIES.editor, appId);

  const bad: { name: string; record: EquipmentRequestInput; path: string }[] = [
    { name: "a title over the limit", record: input({ title: "x".repeat(TRACKER_LIMITS.title + 1) }), path: "record.title" },
    { name: "an empty title", record: input({ title: "   " }), path: "record.title" },
    { name: "details over the limit", record: input({ details: "y".repeat(TRACKER_LIMITS.details + 1) }), path: "record.details" },
    {
      name: "requestedFor over the limit",
      record: input({ requestedFor: "z".repeat(TRACKER_LIMITS.requestedFor + 1) }),
      path: "record.requestedFor",
    },
    { name: "quantity of zero", record: input({ quantity: 0 }), path: "record.quantity" },
    { name: "quantity over the maximum", record: input({ quantity: TRACKER_LIMITS.quantityMax + 1 }), path: "record.quantity" },
    { name: "a fractional quantity", record: input({ quantity: 1.5 }), path: "record.quantity" },
    { name: "an unknown category", record: badInput({ category: "spaceship" }), path: "record.category" },
    { name: "an unknown priority", record: badInput({ priority: "urgent" }), path: "record.priority" },
    { name: "an unknown status", record: badInput({ status: "pending" }), path: "record.status" },
    { name: "a malformed date", record: input({ neededBy: "01/10/2026" }), path: "record.neededBy" },
    { name: "a date that is not a real day", record: input({ neededBy: "2026-13-45" }), path: "record.neededBy" },
    { name: "an unknown key", record: badInput({ colour: "red" }), path: "record" },
  ];

  for (const { name, record, path } of bad) {
    it(`refuses ${name} and names the field in details`, async () => {
      const error = await refusal(() => store.create(editor, { writeId: uuid(), record }));
      expect(error.code).toBe("invalid_input");
      expect(error.status).toBe(400);
      const issues = (error.details?.issues ?? []) as { path: string }[];
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((issue) => issue.path.startsWith(path))).toBe(true);
    });
  }

  it("accepts the limits exactly at their boundary", async () => {
    const created = await store.create(editor, {
      writeId: uuid(),
      record: input({
        title: "t".repeat(TRACKER_LIMITS.title),
        details: "d".repeat(TRACKER_LIMITS.details),
        requestedFor: "r".repeat(TRACKER_LIMITS.requestedFor),
        quantity: TRACKER_LIMITS.quantityMax,
        neededBy: null,
      }),
    });
    expect(created.record.title.length).toBe(TRACKER_LIMITS.title);
    expect(created.record.quantity).toBe(TRACKER_LIMITS.quantityMax);
    expect(created.record.neededBy).toBeNull();
  });

  it("applies the contract defaults for omitted optional fields", async () => {
    const created = await store.create(editor, {
      writeId: uuid(),
      record: { title: "Mouse", category: "peripheral" },
    });
    expect(created.record).toMatchObject({
      details: "",
      quantity: 1,
      priority: "normal",
      status: "requested",
      requestedFor: "",
      neededBy: null,
    });
  });

  it("refuses an unknown key on the envelope itself", async () => {
    const error = await refusal(() =>
      store.create(editor, { writeId: uuid(), record: input(), source: "curl" } as never)
    );
    expect(error.code).toBe("invalid_input");
  });

  it("refuses a writeId that is not a uuid", async () => {
    const error = await refusal(() => store.create(editor, { writeId: "retry-1", record: input() } as never));
    expect(error.code).toBe("invalid_input");
    expect(((error.details?.issues ?? []) as { path: string }[])[0].path).toBe("writeId");
  });

  it("refuses an update whose patch names no field", async () => {
    const seed = await store.create(editor, { writeId: uuid(), record: input() });
    const error = await refusal(() =>
      store.update(editor, seed.record.id, { writeId: uuid(), expectedVersion: 1, patch: {} })
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("names no fields");
  });

  it("refuses an update to a record that does not exist", async () => {
    const error = await refusal(() =>
      store.update(editor, "no-such-record", { writeId: uuid(), expectedVersion: 1, patch: { quantity: 2 } })
    );
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
  });

  it("answers null rather than throwing for a get of a missing record", async () => {
    await expect(store.get(editor, "no-such-record")).resolves.toBeNull();
  });

  it("refuses a list limit over the contract maximum", async () => {
    const error = await refusal(() => store.list(editor, { limit: TRACKER_LIMITS.listMax + 1 }));
    expect(error.code).toBe("invalid_input");
  });
});

describe("reading: create, get, list, paginate", () => {
  const appId = freshApp();
  const store = openAppData(appId).store;
  const editor = ctx("editor", IDENTITIES.editor, appId);
  const created: EquipmentRequest[] = [];

  it("creates seven requests, each readable by id", async () => {
    const seeds: Partial<EquipmentRequestInput>[] = [
      { title: "One", category: "laptop", status: "requested" },
      { title: "Two", category: "monitor", status: "approved" },
      { title: "Three", category: "laptop", status: "approved" },
      { title: "Four", category: "software", status: "ordered" },
      { title: "Five", category: "laptop", status: "requested" },
      { title: "Six", category: "furniture", status: "delivered" },
      { title: "Seven", category: "laptop", status: "approved" },
    ];
    for (const seed of seeds) {
      nextMillisecond();
      const result = await store.create(editor, { writeId: uuid(), record: input(seed) });
      created.push(result.record);
      await expect(store.get(editor, result.record.id)).resolves.toEqual(result.record);
    }
    expect(new Set(created.map((r) => r.createdAt)).size).toBe(created.length);
  });

  it("lists newest first", async () => {
    const page = await store.list(editor, { limit: 25 });
    expect(page.items.map((r) => r.title)).toEqual(["Seven", "Six", "Five", "Four", "Three", "Two", "One"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("walks every row exactly once with limit=2", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.list(editor, cursor === undefined ? { limit: 2 } : { limit: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);

    expect(seen.length).toBe(created.length);
    expect(new Set(seen).size).toBe(created.length);
    expect(seen).toEqual([...created].reverse().map((r) => r.id));
  });

  it("filters by status and by category, and by both together", async () => {
    const approved = await store.list(editor, { limit: 25, status: "approved" });
    expect(approved.items.map((r) => r.title)).toEqual(["Seven", "Three", "Two"]);

    const laptops = await store.list(editor, { limit: 25, category: "laptop" });
    expect(laptops.items.map((r) => r.title)).toEqual(["Seven", "Five", "Three", "One"]);

    const both = await store.list(editor, { limit: 25, status: "approved", category: "laptop" });
    expect(both.items.map((r) => r.title)).toEqual(["Seven", "Three"]);

    const none = await store.list(editor, { limit: 25, status: "declined" });
    expect(none.items).toEqual([]);
    expect(none.nextCursor).toBeUndefined();
  });

  it("keeps the filter while paginating", async () => {
    const first = await store.list(editor, { limit: 2, category: "laptop" });
    expect(first.items.map((r) => r.title)).toEqual(["Seven", "Five"]);
    expect(first.nextCursor).toBeDefined();

    const second = await store.list(editor, { limit: 2, category: "laptop", cursor: first.nextCursor });
    expect(second.items.map((r) => r.title)).toEqual(["Three", "One"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("uses the contract's default limit when none is given", async () => {
    const page = await store.list(editor, {});
    expect(page.items.length).toBe(Math.min(created.length, TRACKER_LIMITS.listDefault));
  });

  const tampered = [
    "not-a-cursor",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 2, at: "2026-01-01T00:00:00.000Z", id: "x" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, at: "", id: "x" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", id: "x", extra: 1 }), "utf8").toString(
      "base64url"
    ),
  ];
  for (const cursor of tampered) {
    it(`refuses the tampered cursor ${JSON.stringify(cursor.slice(0, 24))}`, async () => {
      const error = await refusal(() => store.list(editor, { limit: 2, cursor }));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("cursor");
    });
  }
});
