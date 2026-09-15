/**
 * The action runner's idempotency contract, and what it promises about audit.
 *
 * Two rules, the same ones the durable implementations keep
 * (`agent-access/control/journal.ts:119`, `hosted/authority/jobs.ts`):
 * same key + same request returns the retained outcome, and same key +
 * *different* request is a conflict rather than the first request's answer.
 * A third rule is about honesty rather than replay: the window is process-local
 * and best-effort, and every execute response says so.
 *
 * The audit test pins the ordering fix: an audit write that fails must not
 * leave a mutation applied in memory but unsaved (which an unrelated later
 * save() would flush behind a request that was told it failed), and must not
 * report success either.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-idempotency-", { fast: true });

/** What is actually on disk — the only way to tell "saved" from "in memory". */
const savedWorkspaceName = (id: string): string | undefined => {
  const state = JSON.parse(fs.readFileSync(path.join(DATA, "state.json"), "utf8")) as {
    workspaces?: { id: string; name: string }[];
  };
  return state.workspaces?.find((w) => w.id === id)?.name;
};

/** Flipped by the audit test; everything else writes audit rows for real. */
const audit = { fail: false, calls: 0 };

/**
 * Whether the store defers its durable write past `runAction` (Postgres) and
 * whether that write lands. The file store is the default here, so everything
 * except the two "deferred commit" cases runs the real, unchanged path.
 */
const commit = { deferred: false, fail: false, calls: 0 };

vi.mock("@/lib/db/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/store")>();
  return {
    ...actual,
    isPostgres: () => commit.deferred,
    flushPendingAsync: async () => {
      commit.calls++;
      if (commit.fail) throw new Error("postgrest unreachable");
      return actual.flushPendingAsync();
    },
    appendAuditAsync: async (
      event: Parameters<typeof actual.appendAuditAsync>[0],
      options?: Parameters<typeof actual.appendAuditAsync>[1]
    ) => {
      audit.calls++;
      if (audit.fail) throw new Error("audit store offline");
      return actual.appendAuditAsync(event, options);
    },
  };
});

type ActionContext = import("@/lib/actions/core").ActionContext;
const { defineAction, runAction } = await import("@/lib/actions/core");
const { db, flush, resetDb, save } = await import("@/lib/db/store");

const WS = "ws-idempotency";
const ctx: ActionContext = {
  workspaceId: WS,
  actor: { type: "user", id: "u-alice", name: "Alice" },
};

/**
 * A mutating action with a visible effect: it appends a tag to a workspace's
 * name, so "did the mutation apply" and "was it persisted" are two different,
 * observable questions.
 */
let executions = 0;
defineAction({
  id: "test.tag",
  title: "Tag the workspace",
  category: "system",
  risk: "low",
  requiredRole: "admin",
  mutates: true,
  input: z.object({ tag: z.string() }),
  plan: () => ({
    summary: "tag",
    details: [],
    costDeltaUsd: 0,
    risk: "low" as const,
    warnings: [],
    requiresApproval: false,
  }),
  execute: (_ctx, input) => {
    executions++;
    const workspace = db().workspaces.find((w) => w.id === WS)!;
    workspace.name = `${workspace.name}|${input.tag}`;
    return { ok: true, summary: `tagged ${input.tag}`, data: { tag: input.tag } };
  },
});

const exec = (input: unknown, idempotencyKey?: string, scope: Partial<ActionContext> = {}) =>
  runAction("test.tag", { ...ctx, ...scope }, input, { mode: "execute", idempotencyKey });

const workspaceName = (): string => db().workspaces.find((w) => w.id === WS)!.name;

beforeEach(() => {
  resetDb({
    workspaces: [{ id: WS, slug: "idem", name: "base", createdAt: new Date().toISOString() }],
    members: [
      { id: "u-alice", workspaceId: WS, name: "Alice", email: "a@test", role: "admin" },
      { id: "u-bob", workspaceId: WS, name: "Bob", email: "b@test", role: "admin" },
      { id: "u-alice", workspaceId: "ws-other", name: "Alice", email: "a@test", role: "admin" },
    ],
  });
  executions = 0;
  audit.fail = false;
  audit.calls = 0;
  commit.deferred = false;
  commit.fail = false;
  commit.calls = 0;
  (globalThis as { __zenithIdem?: Map<string, unknown> }).__zenithIdem = new Map();
});

describe("the replay window is bound to the request, not only the key", () => {
  it("runs once for the same key and the same payload", async () => {
    const first = await exec({ tag: "one" }, "key-same");
    const second = await exec({ tag: "one" }, "key-same");

    expect(first.result?.ok).toBe(true);
    expect(second.result).toBe(first.result); // the retained outcome, not a second run
    expect(executions).toBe(1);
    expect(workspaceName()).toBe("base|one");
    expect(first.idempotency).toMatchObject({ applied: true, replayed: false });
    expect(second.idempotency).toMatchObject({ applied: true, replayed: true });
  });

  it("refuses the same key with a different payload instead of replaying it", async () => {
    await exec({ tag: "one" }, "key-differs");
    const conflicting = await exec({ tag: "two" }, "key-differs");

    expect(conflicting.result?.ok).toBe(false);
    expect(conflicting.result?.error).toMatch(/^idempotency_conflict:/);
    expect(conflicting.result?.error).toMatch(/new idempotency key/);
    expect(executions).toBe(1); // the second request was never executed
    expect(workspaceName()).toBe("base|one");
    expect(conflicting.idempotency).toMatchObject({ replayed: false });
  });

  it("scopes the key by workspace, actor and action, not by key alone", async () => {
    const key = "shared-key";
    await exec({ tag: "one" }, key);

    // Another principal in the same workspace: their own request, executed.
    const bob = await exec({ tag: "one" }, key, {
      actor: { type: "user", id: "u-bob", name: "Bob" },
    });
    expect(bob.result).not.toBe(undefined);
    expect(executions).toBe(2);

    // Another tenant: also its own request, even for the same actor.
    await exec({ tag: "one" }, key, { workspaceId: "ws-other" });
    expect(executions).toBe(3);
  });

  it("states that the window is process-local and best-effort", async () => {
    const { idempotency } = await exec({ tag: "one" }, "key-note");
    expect(idempotency).toMatchObject({ scope: "process", bestEffort: true, windowMs: 600_000 });
    expect(idempotency?.note).toMatch(/this server process/);
    expect(idempotency?.note).toMatch(/idempotency_conflict/);

    // No key supplied: the response still says what protection was applied.
    const none = await exec({ tag: "two" });
    expect(none.idempotency).toMatchObject({ applied: false, replayed: false });
  });

  it("says a replay is the outcome of a request that committed", async () => {
    const { idempotency } = await exec({ tag: "one" }, "key-commit-note");
    expect(idempotency?.note).toMatch(/retained only once that request's own durable write/);
    expect(idempotency?.note).toMatch(/idempotency_in_flight/);
  });

  it("keeps the file store's path exactly as it was: retain, no flush", async () => {
    await exec({ tag: "one" }, "key-file-store");
    const replay = await exec({ tag: "one" }, "key-file-store");

    expect(replay.idempotency).toMatchObject({ replayed: true });
    expect(executions).toBe(1);
    // The file store's own timer and exit hook own that write; `runAction` does
    // not reach for a flush it was never responsible for.
    expect(commit.calls).toBe(0);
  });
});

/**
 * A caller with no `route()` around it — a server action (`navigator/run.ts`
 * drives every step through one), the agent-control gateway, a background pass.
 * Nothing else will ever close the window for them, so the runner owns the
 * commit itself rather than retaining an outcome nobody confirmed.
 */
describe("a deferred commit with no request scope to settle it", () => {
  it("flushes before it retains, and then replays", async () => {
    commit.deferred = true;

    const first = await exec({ tag: "one" }, "key-deferred-ok");
    expect(first.result?.ok).toBe(true);
    expect(commit.calls).toBe(1); // the write was awaited, not left scheduled
    expect(first.idempotency).toMatchObject({ replayed: false });

    const replay = await exec({ tag: "one" }, "key-deferred-ok");
    expect(replay.result).toBe(first.result);
    expect(replay.idempotency).toMatchObject({ replayed: true });
    expect(executions).toBe(1);
  });

  it("retains nothing when the commit fails, and the retry re-executes", async () => {
    commit.deferred = true;
    commit.fail = true;

    const failed = await exec({ tag: "one" }, "key-deferred-fail");
    expect(failed.result?.ok).toBe(false);
    expect(failed.result?.error).toMatch(/^commit_failed:/);
    expect(failed.idempotency).toMatchObject({ applied: true, replayed: false });
    expect(executions).toBe(1);

    // Nothing was retained, so the identical request runs again instead of
    // being answered with the success that never reached the store.
    commit.fail = false;
    const retry = await exec({ tag: "one" }, "key-deferred-fail");
    expect(retry.result?.ok).toBe(true);
    expect(retry.idempotency).toMatchObject({ replayed: false });
    expect(executions).toBe(2);
  });
});

describe("an audit write that fails", () => {
  it("leaves no half-applied mutation and does not report success", async () => {
    audit.fail = true;
    const run = await exec({ tag: "unaudited" }, "key-audit");

    // Reported honestly: the effect happened, the required record did not.
    expect(run.result?.ok).toBe(false);
    expect(run.result?.error).toMatch(/^audit_write_failed:/);
    expect(run.result?.summary).toMatch(/audit record could not be written/);
    expect(executions).toBe(1);

    // And the mutation is *persisted*, not left in memory for an unrelated
    // later save() to flush behind this failure. Re-reading the store from
    // disk is what tells the two apart.
    flush();
    expect(savedWorkspaceName(WS)).toBe("base|unaudited");

    // A retry under the same key does not apply it a second time.
    const retry = await exec({ tag: "unaudited" }, "key-audit");
    expect(retry.result).toBe(run.result);
    expect(executions).toBe(1);
  });

  it("still returns the action's own failure when the failure audit cannot be written", async () => {
    // A throwing execute keeps the pre-existing contract: an error result, and
    // no claim that anything succeeded.
    defineAction({
      id: "test.throws",
      title: "Throw",
      category: "system",
      risk: "low",
      requiredRole: "admin",
      mutates: true,
      input: z.object({}),
      plan: () => ({
        summary: "throw",
        details: [],
        costDeltaUsd: 0,
        risk: "low" as const,
        warnings: [],
        requiresApproval: false,
      }),
      execute: () => {
        throw new Error("provider refused");
      },
    });
    audit.fail = true;
    const run = await runAction("test.throws", ctx, {}, { mode: "execute" });
    expect(run.result?.ok).toBe(false);
    expect(run.result?.error).toBe("provider refused");
    save();
    flush();
  });
});
