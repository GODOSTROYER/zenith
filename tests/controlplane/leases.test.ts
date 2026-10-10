/**
 * Leases and fence tokens: contention, expiry takeover, stale renewal, and the
 * fenced-write check — on PGlite and, when configured, real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { LeaseLostError } from "@/lib/controlplane/types";
import { LANES, backdate, expectCode, newWorkspace, openLane, sleep, uid } from "./_support/harness";

describe.each(LANES)("leases [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  const scope = (): string => `env:${uid("env")}`;
  const initialFence = async (): Promise<number> => {
    const [state] = await ctx.db.query<{ epoch: number | string }>("select platform.current_recovery_epoch() as epoch");
    const fence = Number(state!.epoch) * 1_000_000_000 + 1;
    expect(Number.isSafeInteger(fence)).toBe(true);
    return fence;
  };

  it("acquire succeeds for one holder and a second holder is refused while it is live", async () => {
    const s = scope();
    const floor = await initialFence();
    const first = await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 30_000 });
    expect(first).not.toBeNull();
    expect(first!.fenceToken).toBe(floor);
    expect(typeof first!.fenceToken).toBe("number");
    expect(first!.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Date.parse(first!.expiresAt)).toBeGreaterThan(Date.parse(first!.acquiredAt));

    expect(await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-b", ttlMs: 30_000 })).toBeNull();
    expect((await repos.leases.current(ctx.db, s))?.holder).toBe("worker-a");
  });

  it("the same holder re-acquiring an active lease gets a NEW, higher fence (the old one is stale)", async () => {
    const s = scope();
    const a1 = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 30_000 }))!;
    const a2 = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 30_000 }))!;
    expect(a2.fenceToken).toBe(a1.fenceToken + 1);
    await expect(ctx.db.tx((tx) => repos.leases.assertFence(tx, s, a1.fenceToken))).rejects.toBeInstanceOf(LeaseLostError);
    await ctx.db.tx((tx) => repos.leases.assertFence(tx, s, a2.fenceToken));
  });

  it("takes over an expired lease, increments the fence, and the previous holder is fenced out", async () => {
    const s = scope();
    const a = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 30_000 }))!;
    await backdate(ctx.db, "leases", "expires_at", s, "scope");
    expect(await repos.leases.current(ctx.db, s)).toBeNull();

    const b = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-b", ttlMs: 30_000 }))!;
    expect(b.holder).toBe("worker-b");
    expect(b.fenceToken).toBe(a.fenceToken + 1);

    // worker-a wakes up: renew fails, release does nothing, its fenced write is refused
    expect(await repos.leases.renew(ctx.db, a, 30_000)).toBeNull();
    expect(await repos.leases.release(ctx.db, a)).toBe(false);
    expect((await repos.leases.current(ctx.db, s))?.holder).toBe("worker-b");
    const err = await ctx.db.tx((tx) => repos.leases.assertFence(tx, s, a.fenceToken)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).scope).toBe(s);
    expect((err as LeaseLostError).fenceToken).toBe(a.fenceToken);
    expect((err as LeaseLostError).code).toBe("lease_lost");
  });

  it("uses the database clock: a 60 ms lease really lapses and can be taken", async () => {
    const s = scope();
    const first = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 60 }))!;
    expect(await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-b", ttlMs: 30_000 })).toBeNull();
    await sleep(150);
    const b = await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-b", ttlMs: 30_000 });
    expect(b?.holder).toBe("worker-b");
    expect(b?.fenceToken).toBe(first.fenceToken + 1);
  });

  it("renew extends a live lease for the same holder+fence and never shortens it", async () => {
    const s = scope();
    const lease = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 60_000 }))!;
    const renewed = (await repos.leases.renew(ctx.db, lease, 120_000))!;
    expect(renewed.fenceToken).toBe(lease.fenceToken);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt) + 30_000);
    const shorter = (await repos.leases.renew(ctx.db, lease, 1_000))!;
    expect(Date.parse(shorter.expiresAt)).toBeGreaterThanOrEqual(Date.parse(renewed.expiresAt));
  });

  it("renew by a stale fence, wrong holder, or after expiry returns null", async () => {
    const s = scope();
    const lease = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 30_000 }))!;
    expect(await repos.leases.renew(ctx.db, { ...lease, fenceToken: lease.fenceToken + 1 }, 30_000)).toBeNull();
    expect(await repos.leases.renew(ctx.db, { ...lease, fenceToken: lease.fenceToken - 1 }, 30_000)).toBeNull();
    expect(await repos.leases.renew(ctx.db, { ...lease, holder: "worker-b" }, 30_000)).toBeNull();
    await backdate(ctx.db, "leases", "expires_at", s, "scope");
    expect(await repos.leases.renew(ctx.db, lease, 30_000)).toBeNull();
  });

  it("release frees the scope immediately but the fence keeps increasing (never resets)", async () => {
    const s = scope();
    const a = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-a", ttlMs: 30_000 }))!;
    expect(await repos.leases.release(ctx.db, a)).toBe(true);
    expect(await repos.leases.release(ctx.db, a)).toBe(false); // idempotent
    expect(await repos.leases.current(ctx.db, s)).toBeNull();
    await expect(ctx.db.tx((tx) => repos.leases.assertFence(tx, s, a.fenceToken))).rejects.toBeInstanceOf(LeaseLostError);
    const b = (await repos.leases.acquire(ctx.db, { scope: s, holder: "worker-b", ttlMs: 30_000 }))!;
    expect(b.fenceToken).toBe(a.fenceToken + 1);
  });

  it("many concurrent acquires of one scope: exactly one winner", async () => {
    const s = scope();
    const floor = await initialFence();
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? ctx.db : ctx.db2).tx((tx) => repos.leases.acquire(tx, { scope: s, holder: `worker-${i}`, ttlMs: 30_000 })))
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.fenceToken).toBe(floor);
    expect((await repos.leases.current(ctx.db, s))?.holder).toBe(winners[0]!.holder);
  });

  it("concurrent takeover of one expired lease: exactly one new holder and one fence increment", async () => {
    const s = scope();
    const first = (await repos.leases.acquire(ctx.db, { scope: s, holder: "old", ttlMs: 30_000 }))!;
    await backdate(ctx.db, "leases", "expires_at", s, "scope");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? ctx.db : ctx.db2).tx((tx) => repos.leases.acquire(tx, { scope: s, holder: `taker-${i}`, ttlMs: 30_000 })))
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.fenceToken).toBe(first.fenceToken + 1);
  });

  it("assertFence locks the lease row FOR SHARE: a concurrent writer of that row waits for the fenced transaction", async () => {
    if (!lane.independent) return; // needs two real connections; PGlite serialises everything
    const live = (await repos.leases.acquire(ctx.db, { scope: scope(), holder: "worker-a", ttlMs: 30_000 }))!;
    let writerDone = false;
    let pending: Promise<unknown> | undefined;
    await ctx.db.tx(async (tx) => {
      await repos.leases.assertFence(tx, live.scope, live.fenceToken);
      // a renewal (or a takeover) from another connection must queue behind our lock
      pending = repos.leases.renew(ctx.db2, live, 60_000).then((r) => {
        writerDone = true;
        return r;
      });
      await sleep(300);
      expect(writerDone).toBe(false);
    });
    await pending;
    expect(writerDone).toBe(true);
  });

  it("listActive returns only this workspace's live, workspace-tagged leases", async () => {
    const w1 = newWorkspace();
    const w2 = newWorkspace();
    const s1 = scope();
    await repos.leases.acquire(ctx.db, { scope: s1, holder: "a", ttlMs: 30_000, workspaceId: w1 });
    await repos.leases.acquire(ctx.db, { scope: scope(), holder: "a", ttlMs: 30_000, workspaceId: w2 });
    const mine = await repos.leases.listActive(ctx.db, w1);
    expect(mine.map((l) => l.scope)).toEqual([s1]);
    expect(await repos.leases.listActive(ctx.db, newWorkspace())).toEqual([]);
  });

  it("a lease tagged with one workspace cannot be taken by another workspace, even after expiry", async () => {
    const w1 = newWorkspace();
    const w2 = newWorkspace();
    const s = scope();
    await repos.leases.acquire(ctx.db, { scope: s, holder: "a", ttlMs: 30_000, workspaceId: w1 });
    await backdate(ctx.db, "leases", "expires_at", s, "scope");
    expect(await repos.leases.acquire(ctx.db, { scope: s, holder: "intruder", ttlMs: 30_000, workspaceId: w2 })).toBeNull();
    expect(await repos.leases.acquire(ctx.db, { scope: s, holder: "b", ttlMs: 30_000, workspaceId: w1 })).not.toBeNull();
  });

  it("rejects invalid input before touching the database", async () => {
    await expectCode(repos.leases.acquire(ctx.db, { scope: "", holder: "a", ttlMs: 1000 }), "invalid_input");
    await expectCode(repos.leases.acquire(ctx.db, { scope: "s", holder: "a", ttlMs: 0 }), "invalid_input");
    await expectCode(repos.leases.acquire(ctx.db, { scope: "s", holder: "a", ttlMs: Number.NaN }), "invalid_input");
  });
});
