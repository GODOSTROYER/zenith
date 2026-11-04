/** PROD-MIX-04: validation refuses before durable writes and binds retained scope. */
import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { MemoryMixedRunStore, platformMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import type { MixedRunState } from "@/lib/execution/mixed-orchestration/run";
import { PG_URL, seedApprovedOperation, withScratchDatabase } from "../controlplane/_support/harness";
import { world } from "./fakes/mixed-fixture";

const corruptions = [
  { name: "state version", corrupt: (state: MixedRunState) => ({ ...state, version: 2 } as unknown as MixedRunState) },
  { name: "child attempts", corrupt: (state: MixedRunState) => {
    const bad = structuredClone(state);
    bad.children[bad.order[0]].attempts = -1;
    return bad;
  } },
];

function tracedSql(sql: Sql, activity: { queries: number; transactions: number }): Sql {
  return {
    query: <T>(text: string, params?: readonly unknown[]) => { activity.queries++; return sql.query<T>(text, params); },
    tx: <T>(body: (tx: Sql) => Promise<T>) => {
      activity.transactions++;
      return sql.tx(tx => body(tracedSql(tx, activity)));
    },
  };
}

async function withOwnedDb(kind: "pglite" | "postgres", body: (db: PlatformDbHandle) => Promise<void>) {
  const run = async (url?: string) => {
    const db = await openPlatformDb(url ? { kind: "postgres", url, migrate: true, max: 1 } : { kind: "pglite", migrate: true });
    try { await body(db); } finally { await db.close(); }
  };
  if (kind === "postgres") await withScratchDatabase(url => run(url));
  else await run();
}

async function stateFor(db: PlatformDbHandle): Promise<MixedRunState> {
  const { workspaceId, operation } = await seedApprovedOperation(db);
  return { ...structuredClone(world().state), workspaceId, parentOperationId: operation.id,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
}

async function retained(db: PlatformDbHandle, state: MixedRunState) {
  return {
    rows: await db.query("select * from platform.mixed_runs where workspace_id=$1 and parent_operation_id=$2", [state.workspaceId, state.parentOperationId]),
    ledger: await db.query("select * from platform.mixed_run_events where workspace_id=$1 and parent_operation_id=$2 order by seq", [state.workspaceId, state.parentOperationId]),
  };
}

for (const kind of ["pglite", "postgres"] as const) {
  describe.skipIf(kind === "postgres" && !PG_URL)(`mixed run store validation [${kind}]`, () => {
    it.each(corruptions)("refuses malformed $name before create or save touches SQL", async ({ corrupt }) => {
      await withOwnedDb(kind, async db => {
        const state = await stateFor(db);
        const activity = { queries: 0, transactions: 0 };
        const store = platformMixedRunStore(tracedSql(db, activity));
        const beforeCreate = await retained(db, state);
        await expect(store.create(corrupt(state), { kind: "run_created", data: {} })).rejects.toMatchObject({ code: "invalid_input" });
        expect(activity).toEqual({ queries: 0, transactions: 0 });
        expect(await retained(db, state)).toEqual(beforeCreate);
        await platformMixedRunStore(db).create(state, { kind: "run_created", data: {} });
        const beforeSave = await retained(db, state);
        const next = corrupt({ ...structuredClone(state), seq: state.seq + 1 });
        await expect(store.save(state.workspaceId, state.parentOperationId, 1, next, { kind: "tick", data: {} })).rejects.toMatchObject({ code: "invalid_input" });
        expect(activity).toEqual({ queries: 0, transactions: 0 });
        expect(await retained(db, state)).toEqual(beforeSave);
      });
    }, 60_000);

    it.each(["environmentId", "desiredDigest"] as const)("refuses legacy logical %s mismatch without changing the retained row or ledger", async field => {
      await withOwnedDb(kind, async db => {
        const state = await stateFor(db);
        const store = platformMixedRunStore(db);
        await store.create(state, { kind: "run_created", data: {} });
        const foreign = { ...structuredClone(state), [field]: field === "environmentId" ? "foreign-environment" : digest("foreign desired state") };
        // Deliberate legacy corruption fixture: migration41's NULL-sensitive
        // CHECK admits a JSONB string. This proves the application read boundary;
        // it does not claim the separate strict database constraint gap is fixed.
        await db.query("update platform.mixed_runs set state=$3::text::jsonb,state_digest=$4,version=version+1 where workspace_id=$1 and parent_operation_id=$2",
          [state.workspaceId, state.parentOperationId, JSON.stringify(JSON.stringify(foreign)), digest(foreign)]);
        expect(await db.query("select jsonb_typeof(state) as shape,environment_id,desired_digest,version from platform.mixed_runs where workspace_id=$1 and parent_operation_id=$2", [state.workspaceId, state.parentOperationId]))
          .toEqual([{ shape: "string", environment_id: state.environmentId, desired_digest: state.desiredDigest, version: 2 }]);
        const before = await retained(db, state);
        await expect(store.get(state.workspaceId, state.parentOperationId)).rejects.toMatchObject({ code: "invalid_input" });
        expect(await retained(db, state)).toEqual(before);
      });
    }, 60_000);

    it("preserves valid writes, ordered ledger and stale-version refusal", async () => {
      await withOwnedDb(kind, async db => {
        const state = await stateFor(db);
        const store = platformMixedRunStore(db);
        expect(await store.create(state, { kind: "run_created", data: {} })).toEqual({ state, version: 1 });
        const next = { ...structuredClone(state), seq: 1 };
        expect(await store.save(state.workspaceId, state.parentOperationId, 1, next, { kind: "tick", data: {} })).toEqual({ state: next, version: 2 });
        const before = await retained(db, state);
        await expect(store.save(state.workspaceId, state.parentOperationId, 1, { ...next, seq: 2 }, { kind: "tick", data: {} })).rejects.toMatchObject({ code: "conflict" });
        expect(await retained(db, state)).toEqual(before);
        expect((await store.events(state.workspaceId, state.parentOperationId)).map(event => [event.seq, event.kind])).toEqual([[0, "run_created"], [1, "tick"]]);
      });
    }, 60_000);
  });
}

it.each(corruptions)("memory parity refuses malformed $name without changing state or ledger", async ({ corrupt }) => {
  const state = structuredClone(world().state);
  const store = new MemoryMixedRunStore();
  await expect(store.create(corrupt(state), { kind: "run_created", data: {} })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await store.get(state.workspaceId, state.parentOperationId)).toBeNull();
  expect(await store.events(state.workspaceId, state.parentOperationId)).toEqual([]);
  await store.create(state, { kind: "run_created", data: {} });
  await expect(store.save(state.workspaceId, state.parentOperationId, 1, corrupt({ ...state, seq: 1 }), { kind: "tick", data: {} })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await store.get(state.workspaceId, state.parentOperationId)).toEqual({ state, version: 1 });
  expect(await store.events(state.workspaceId, state.parentOperationId)).toEqual([{ seq: 0, kind: "run_created", data: {} }]);
});
