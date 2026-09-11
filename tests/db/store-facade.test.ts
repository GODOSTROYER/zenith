/**
 * The façade: `src/lib/db/store.ts` selects an implementation and re-exports
 * it under the historical names. Two things are worth pinning down — that the
 * `ZENITH_STORE` flag reaches the selection end to end, and that the exported
 * functions are the selected store's and not a second copy of its state.
 *
 * The flag test only asks what the *selector* would answer (`isPostgres()`);
 * it must not call `db()` under the postgres flag, because the selection is
 * cached on `globalThis` the first time it runs and would strand this file's
 * remaining tests on a store pointed at nothing. The Postgres store's own
 * behaviour is covered by tests/api/postgres-request-boundary.test.ts and by
 * the contract suite.
 */
import { describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-store-facade-");

const store = await import("@/lib/db/store");
const { FileStore } = await import("@/lib/db/file-store");
const { env } = await import("@/lib/env");

/** Run `fn` with ZENITH_STORE set, then put the environment back. */
function withStoreFlag<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.ZENITH_STORE;
  if (value === undefined) delete process.env.ZENITH_STORE;
  else process.env.ZENITH_STORE = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.ZENITH_STORE;
    else process.env.ZENITH_STORE = before;
  }
}

describe("ZENITH_STORE", () => {
  it("selects the Postgres store on the flag, and says so", () => {
    withStoreFlag("postgres", () => {
      expect(store.isPostgres()).toBe(true);
    });
    // …and the default is still the file store, with no Supabase anything.
    expect(withStoreFlag(undefined, () => store.isPostgres())).toBe(false);
  });

  it("defaults to file and rejects anything else", () => {
    expect(withStoreFlag(undefined, () => env().ZENITH_STORE)).toBe("file");
    expect(withStoreFlag("", () => env().ZENITH_STORE)).toBe("file");
    expect(withStoreFlag("file", () => env().ZENITH_STORE)).toBe("file");
    expect(withStoreFlag("postgres", () => env().ZENITH_STORE)).toBe("postgres");
    expect(() => withStoreFlag("sqlite", () => env())).toThrow(/ZENITH_STORE/);
  });
});

describe("delegation", () => {
  it("hands every named export to the selected store", () => {
    store.resetDb();
    expect(store.db()).toBe(FileStore.db());

    store.db().workspaces.push({
      id: "ws-facade",
      name: "Facade",
      slug: "facade",
      createdAt: new Date().toISOString(),
    });
    store.save();
    expect(store.flushPending()).toBe(true);

    // Read back through the implementation, not the façade.
    expect(FileStore.db().workspaces.map((w) => w.id)).toEqual(["ws-facade"]);
    expect(store.q.workspace("facade")?.id).toBe("ws-facade");
    expect(store.inWorkspace("ws-facade", "nope")).toBe(false);

    const seen: string[][] = [];
    const off = FileStore.onChange((c) => seen.push(c.projectIds));
    try {
      store.save("proj-facade");
      store.flush();
    } finally {
      off();
    }
    expect(seen).toEqual([["proj-facade"]]);
    expect(store.changed({ projectIds: [] }, "anything")).toBe(true);

    store.resetDb();
  });
});
