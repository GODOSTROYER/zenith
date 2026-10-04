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
const businessSave = { fail: false, calls: 0 };
const SAVE_CANARY = "private-save-exception-canary";

vi.mock("@/lib/db/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/store")>();
  return {
    ...actual,
    isPostgres: () => commit.deferred,
    save: (projectId?: string) => {
      businessSave.calls++;
      if (businessSave.fail) throw new Error(SAVE_CANARY);
      actual.save(projectId);
    },
    flushPendingAsync: async () => {
      commit.calls++;
      if (commit.fail) throw new Error(SAVE_CANARY);
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
const { defineAction, runAction, withActionOutcomes, actionPersistenceUnconfirmed } = await import("@/lib/actions/core");
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
  businessSave.fail = false;
  businessSave.calls = 0;
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

  it("holds an unconfirmed mutation when the commit fails and refuses to execute the retry", async () => {
    commit.deferred = true;
    commit.fail = true;

    const failed = await exec({ tag: "one" }, "key-deferred-fail");
    expect(failed.result?.ok).toBe(false);
    expect(failed.result?.error).toMatch(/^persistence_unconfirmed:/);
    expect(failed.result?.data).toEqual({ tag: "one" });
    expect(JSON.stringify(failed)).not.toContain(SAVE_CANARY);
    expect(audit.calls).toBe(1);
    expect(failed.idempotency).toMatchObject({ applied: true, replayed: false });
    expect(executions).toBe(1);

    const stillFailing = await exec({ tag: "one" }, "key-deferred-fail");
    expect(stillFailing.result?.error).toMatch(/^persistence_unconfirmed:/);
    expect(executions).toBe(1); expect(commit.calls).toBe(1);

    // A product write failure cannot prove that an already returned native
    // effect rolled back. Restoring the store does not authorize execution.
    commit.fail = false;
    const retry = await exec({ tag: "one" }, "key-deferred-fail");
    expect(retry.result?.ok).toBe(false);
    expect(retry.result?.error).toMatch(/^persistence_unconfirmed:/);
    expect(retry.idempotency).toMatchObject({ replayed: false });
    expect(executions).toBe(1);
    expect(commit.calls).toBe(1);
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


describe("returned mutations whose persistence is unconfirmed", () => {
  it("keeps only the produced outcome and attempts audit through a persistent final save failure", async () => {
    businessSave.fail = true;
    const first = await exec({ tag: "one" }, "save-uncertain");
    expect(first.result).toMatchObject({ ok: false, data: { tag: "one" }, error: expect.stringMatching(/^persistence_unconfirmed:/) });
    expect(JSON.stringify(first)).not.toContain(SAVE_CANARY);
    expect(first.idempotency).toMatchObject({ replayed: false });
    expect(businessSave.calls).toBe(1); expect(audit.calls).toBe(1); expect(executions).toBe(1);
    const blocked = await exec({ tag: "one" }, "save-uncertain");
    expect(blocked.result).toBe(first.result); expect(blocked.idempotency?.replayed).toBe(false);
    expect(businessSave.calls).toBe(1); expect(audit.calls).toBe(1); expect(executions).toBe(1);
    businessSave.fail = false;
    expect((await exec({ tag: "one" }, "save-uncertain")).result).toBe(first.result);
    expect(executions).toBe(1);
  });

  it("keeps uncertainty scoped by actor and key and refuses changed input or environment under the same key", async () => {
    businessSave.fail = true;
    await exec({ tag: "one" }, "uncertain-scope");
    expect((await exec({ tag: "two" }, "uncertain-scope")).result?.error).toMatch(/^idempotency_conflict:/);
    expect((await exec({ tag: "one" }, "uncertain-scope", { environmentId: "other-environment" })).result?.error).toMatch(/^idempotency_conflict:/);
    businessSave.fail = false;
    expect((await exec({ tag: "one" }, "uncertain-scope", { actor: { type: "user", id: "u-bob", name: "Bob" } })).result?.ok).toBe(true);
    expect((await exec({ tag: "one" }, "different-key")).result?.ok).toBe(true);
    expect(executions).toBe(3);
  });

  it("never promotes a final save failure when a surrounding request scope commits", async () => {
    commit.deferred = true; businessSave.fail = true;
    const first = await withActionOutcomes(async scope => {
      const result = await exec({ tag: "one" }, "uncertain-final-save"); scope.commit(); return result;
    });
    businessSave.fail = false;
    const retry = await exec({ tag: "one" }, "uncertain-final-save");
    expect(retry.result).toBe(first.result); expect(retry.result?.ok).toBe(false);
    expect(retry.idempotency?.replayed).toBe(false); expect(executions).toBe(1); expect(commit.calls).toBe(0);
  });

  it("abandoned request settlement refuses re-execution and exposes no successful replay", async () => {
    commit.deferred = true;
    await withActionOutcomes(async scope => {
      const first = await exec({ tag: "one" }, "abandoned"); expect(first.result?.ok).toBe(true);
      const waiting = await exec({ tag: "one" }, "abandoned"); expect(waiting.result?.error).toMatch(/^idempotency_in_flight:/);
      scope.abandon(); scope.commit();
    });
    const retry = await exec({ tag: "one" }, "abandoned");
    expect(retry.result).toMatchObject({ ok: false, data: { tag: "one" }, error: expect.stringMatching(/^persistence_unconfirmed:/) });
    expect(retry.idempotency?.replayed).toBe(false); expect(executions).toBe(1); expect(commit.calls).toBe(0);
  });

  it("copied outcomes and caller-like error strings cannot originate the private uncertainty state", async () => {
    for (const kind of ["genuine", "copied", "unbranded"] as const) {
      let calls = 0;
      const actionId = `test.uncertain-origin-${kind}`;
      defineAction({ id: actionId, title: "Modeled outcome", category: "system", risk: "low", requiredRole: "admin", mutates: true,
        input: z.object({}), plan: () => ({ summary: "origin", details: [], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false }),
        execute: () => {
          calls++;
          const genuine = actionPersistenceUnconfirmed({ ok: true, summary: SAVE_CANARY, error: SAVE_CANARY, data: { owningId: "modeled-owning-id" } });
          return kind === "genuine" ? genuine : kind === "copied" ? { ...genuine }
            : { ok: false, summary: "Modeled refusal.", error: "persistence_unconfirmed", data: { owningId: "modeled-owning-id" } };
        } });
      const first = await runAction(actionId, ctx, {}, { mode: "execute", idempotencyKey: "origin-key" });
      const retry = await runAction(actionId, ctx, {}, { mode: "execute", idempotencyKey: "origin-key" });
      expect(first.result?.ok).toBe(false); expect(first.result?.data).toEqual({ owningId: "modeled-owning-id" });
      expect(JSON.stringify(first)).not.toContain(SAVE_CANARY); expect(calls).toBe(1);
      expect(retry.result).toBe(first.result); expect(retry.idempotency?.replayed).toBe(kind !== "genuine");
    }
  });

  it("confirmed request settlement preserves the clean retained success path", async () => {
    commit.deferred = true;
    const first = await withActionOutcomes(async scope => {
      const result = await exec({ tag: "one" }, "settled"); scope.commit(); return result;
    });
    const retry = await exec({ tag: "one" }, "settled");
    expect(retry.result).toBe(first.result); expect(retry.result?.ok).toBe(true);
    expect(retry.idempotency?.replayed).toBe(true); expect(executions).toBe(1);
  });

  it("pins unconfirmed outcomes beyond the ordinary replay TTL and refuses bounded capacity before another effect", async () => {
    businessSave.fail = true;
    for (let index = 0; index < 499; index++) {
      expect((await exec({ tag: "one" }, `uncertain-${index}`)).result?.error).toMatch(/^persistence_unconfirmed:/);
    }
    expect(executions).toBe(499);
    let outerExecutions = 0;
    defineAction({ id: "test.reentrant", title: "Nested mutation", category: "system", risk: "low", requiredRole: "admin", mutates: true,
      input: z.object({}), plan: () => ({ summary: "nested", details: [], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false }),
      execute: async () => {
        outerExecutions++;
        const nested = await exec({ tag: "nested" }, "nested-at-capacity");
        expect(nested.result?.error).toMatch(/^idempotency_capacity:/);
        return { ok: false, summary: "Nested admission refused." };
      } });
    const outer = await runAction("test.reentrant", ctx, {}, { mode: "execute", idempotencyKey: "outer-slot" });
    expect(outer.result?.error).toMatch(/^persistence_unconfirmed:/);
    expect(outerExecutions).toBe(1); expect(executions).toBe(499);
    businessSave.fail = false;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
    try {
      expect((await exec({ tag: "one" }, "uncertain-0")).result?.error).toMatch(/^persistence_unconfirmed:/);
      expect((await exec({ tag: "one" }, "new-after-capacity")).result?.error).toMatch(/^idempotency_capacity:/);
      expect(executions).toBe(499);
    } finally { clock.mockRestore(); }
  });
});
