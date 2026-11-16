/**
 * The operations ledger: idempotent create, tenancy, conditional transitions,
 * the single-use execution claim, fencing and the uncertain/expiry reconcilers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import * as repos from "@/lib/controlplane/db/repos";
import { IdempotencyConflictError } from "@/lib/controlplane/db";
import { LeaseLostError, type OperationRecord, type Sql } from "@/lib/controlplane/types";
import { proposeOperation } from "@/lib/controlplane/operations";
import {
  LANES,
  agent,
  approve,
  backdate,
  expectCode,
  newWorkspace,
  openLane,
  proposalFor,
  seedApprovedOperation,
  seedAwaitingApproval,
  uid,
  user,
} from "./_support/harness";

describe.each(LANES)("operations [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  const db = () => ctx.db;

  describe("create and read", () => {
    it("stores a proposal with server-computed digests and round-trips it canonically", async () => {
      const ws = newWorkspace();
      const proposal = proposalFor(ws, { planDigest: "c".repeat(64), costDeltaUsd: 12.5 });
      const { operation: op, created } = await repos.operations.create(db(), { workspaceId: ws, principal: user("u1"), proposal });
      expect(created).toBe(true);
      expect(op.status).toBe("proposed");
      expect(op.proposalDigest).toBe(digest(proposal));
      expect(op.inputDigest).toBe(digest(proposal.input));
      expect(op.planDigest).toBe("c".repeat(64));
      // jsonb round trip must not change the canonical form (the digest is over it)
      expect(digest(op.proposal)).toBe(op.proposalDigest);
      expect(op.principal).toEqual({ kind: "user", id: "u1", name: "Alice Admin" });
      expect(op.approvalRequired).toBe(false);
      expect(op.environmentId).toBe(proposal.scope.environmentId);
      expect(op.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(op.expiresAt)).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
      expect(op.fenceToken).toBeUndefined();
      expect(op.result).toBeUndefined();
      expect(await repos.operations.get(db(), ws, op.id)).toEqual(op);
    });

    it("refuses a proposal whose scope names another workspace, and secret material in the proposal", async () => {
      const ws = newWorkspace();
      await expectCode(
        repos.operations.create(db(), { workspaceId: ws, principal: user(), proposal: proposalFor(newWorkspace()) }),
        "tenant_mismatch"
      );
      await expectCode(
        repos.operations.create(db(), {
          workspaceId: ws,
          principal: user(),
          proposal: proposalFor(ws, { input: { key: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----" } }),
        }),
        "secret_material"
      );
      await expectCode(repos.operations.create(db(), { workspaceId: ws, principal: user(), proposal: proposalFor(ws), status: "approved", approvalRequired: true }), "invalid_state");
    });

    it("a wrong-workspace get, list and claim see nothing", async () => {
      const seeded = await seedApprovedOperation(db());
      const other = newWorkspace();
      expect(await repos.operations.get(db(), other, seeded.operation.id)).toBeNull();
      expect((await repos.operations.list(db(), other)).items).toEqual([]);
      await expectCode(
        repos.operations.claimForExecution(db(), { workspaceId: other, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "w" }),
        "operation_not_found"
      );
      expect(
        await repos.operations.transition(db(), { workspaceId: other, id: seeded.operation.id, from: ["approved"], to: "cancelled" })
      ).toBeNull();
      // and the real workspace's row is untouched
      expect((await repos.operations.get(db(), seeded.workspaceId, seeded.operation.id))?.status).toBe("approved");
    });
  });

  describe("idempotency", () => {
    it("the same key and request returns the same operation; a different request conflicts", async () => {
      const ws = newWorkspace();
      const p = user("u-idem");
      const proposal = proposalFor(ws);
      const first = await repos.operations.create(db(), { workspaceId: ws, principal: p, proposal, idempotencyKey: "key-1" });
      const again = await repos.operations.create(db(), { workspaceId: ws, principal: p, proposal, idempotencyKey: "key-1" });
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.operation.id).toBe(first.operation.id);
      expect(again.operation).toEqual(first.operation);

      const changed = proposalFor(ws, { input: { service: "web", replicas: 9 }, scope: proposal.scope });
      const err = await repos.operations.create(db(), { workspaceId: ws, principal: p, proposal: changed, idempotencyKey: "key-1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdempotencyConflictError);
      expect((err as IdempotencyConflictError).code).toBe("idempotency_conflict");
      expect((await repos.operations.list(db(), ws)).items).toHaveLength(1);
    });

    it("a key is scoped to its workspace and to the requesting principal", async () => {
      const wsA = newWorkspace();
      const wsB = newWorkspace();
      const a = await repos.operations.create(db(), { workspaceId: wsA, principal: user("u1"), proposal: proposalFor(wsA), idempotencyKey: "shared" });
      const b = await repos.operations.create(db(), { workspaceId: wsB, principal: user("u1"), proposal: proposalFor(wsB), idempotencyKey: "shared" });
      expect(b.created).toBe(true);
      expect(b.operation.id).not.toBe(a.operation.id);
      // another principal reusing the key with the same body gets a conflict, not the first principal's operation
      await expectCode(
        repos.operations.create(db(), { workspaceId: wsA, principal: agent(), proposal: a.operation.proposal, idempotencyKey: "shared" }),
        "idempotency_conflict"
      );
    });

    it("racing creates with one key produce exactly one operation", async () => {
      const ws = newWorkspace();
      const p = user("u-race");
      const proposal = proposalFor(ws);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? ctx.db : ctx.db2).tx((tx) => repos.operations.create(tx, { workspaceId: ws, principal: p, proposal, idempotencyKey: "race-key" }))
        )
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.operation.id)).size).toBe(1);
      expect((await repos.operations.list(db(), ws)).items).toHaveLength(1);
    });

    it("an expired key is reclaimed by the next request", async () => {
      const ws = newWorkspace();
      const p = user();
      const first = await repos.operations.create(db(), { workspaceId: ws, principal: p, proposal: proposalFor(ws), idempotencyKey: "expiring" });
      await db().query("update platform.idempotency_keys set expires_at = clock_timestamp() - interval '1 second' where workspace_id = $1 and key = 'expiring'", [ws]);
      const second = await repos.operations.create(db(), { workspaceId: ws, principal: p, proposal: proposalFor(ws), idempotencyKey: "expiring" });
      expect(second.created).toBe(true);
      expect(second.operation.id).not.toBe(first.operation.id);
    });
  });

  describe("list", () => {
    it("pages newest-first with a cursor, filters, and never crosses workspaces", async () => {
      const ws = newWorkspace();
      const env = uid("env");
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const proposal = proposalFor(ws, { capability: i % 2 ? "deployment.restart" : "infrastructure.apply", scope: { workspaceId: ws, environmentId: env }, input: { i } });
        ids.push((await repos.operations.create(db(), { workspaceId: ws, principal: user(i < 3 ? "u-a" : "u-b"), proposal })).operation.id);
      }
      await seedApprovedOperation(db(), newWorkspace()); // noise in another workspace

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await repos.operations.list(db(), ws, {}, { limit: 2, cursor });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((o) => o.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());

      expect((await repos.operations.list(db(), ws, { capability: "deployment.restart" })).items).toHaveLength(2);
      expect((await repos.operations.list(db(), ws, { principalId: "u-a" })).items).toHaveLength(3);
      expect((await repos.operations.list(db(), ws, { environmentId: env, status: ["proposed", "approved"] })).items).toHaveLength(5);
      expect((await repos.operations.list(db(), ws, { status: "succeeded" })).items).toEqual([]);
      await expectCode(repos.operations.list(db(), ws, {}, { cursor: "!!!" }), "invalid_input");
    });
  });

  describe("transitions", () => {
    it("moves along legal edges and returns null when the current status is not in `from`", async () => {
      const seeded = await seedApprovedOperation(db());
      const { workspaceId: ws, operation } = seeded;
      expect(await repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["proposed"], to: "cancelled" })).toBeNull();
      const queued = await repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["approved"], to: "queued", patch: { workflowId: "wf_1" } });
      expect(queued?.status).toBe("queued");
      expect(queued?.workflowId).toBe("wf_1");
      const cancelled = await repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["queued"], to: "cancelled", patch: { error: "user cancelled" } });
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.finishedAt).toBeDefined();
      expect(cancelled?.error).toBe("user cancelled");
    });

    it("refuses illegal edges, leaving a terminal status, and the two guarded targets", async () => {
      const { workspaceId: ws, operation } = await seedApprovedOperation(db());
      await expectCode(repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["approved"], to: "succeeded" }), "invalid_state");
      await expectCode(repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["succeeded"], to: "failed" }), "invalid_state");
      await expectCode(repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["uncertain"], to: "queued" }), "invalid_state");
      await expectCode(repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["approved"], to: "running" }), "invalid_state");
      await expectCode(repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["awaiting_approval"], to: "approved" }), "invalid_state");
      await expectCode(repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: [], to: "cancelled" }), "invalid_input");
      await expectCode(repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["approved"], to: "queued", patch: { policyDecisionId: "x" } }), "invalid_input");
    });

    it("the database refuses to approve an operation that requires approval, even via a legal-looking edge", async () => {
      const ws = newWorkspace();
      const { operation } = await repos.operations.create(db(), { workspaceId: ws, principal: user(), proposal: proposalFor(ws), status: "proposed", approvalRequired: true });
      expect(operation.approvalRequired).toBe(true);
      expect(await repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["proposed"], to: "approved" })).toBeNull();
      expect((await repos.operations.get(db(), ws, operation.id))?.status).toBe("proposed");
    });

    it("of two racing transitions from `approved`, exactly one wins", async () => {
      const { workspaceId: ws, operation } = await seedApprovedOperation(db());
      const results = await Promise.all([
        ctx.db.tx((tx) => repos.operations.transition(tx, { workspaceId: ws, id: operation.id, from: ["approved"], to: "queued" })),
        ctx.db2.tx((tx) => repos.operations.transition(tx, { workspaceId: ws, id: operation.id, from: ["approved"], to: "cancelled" })),
        ctx.db.tx((tx) => repos.operations.transition(tx, { workspaceId: ws, id: operation.id, from: ["approved"], to: "queued" })),
        ctx.db2.tx((tx) => repos.operations.transition(tx, { workspaceId: ws, id: operation.id, from: ["approved"], to: "expired" })),
      ]);
      const winners = results.filter((r): r is OperationRecord => r !== null);
      expect(winners).toHaveLength(1);
      expect((await repos.operations.get(db(), ws, operation.id))?.status).toBe(winners[0].status);
    });

    it("an expired operation can still be finished/cancelled but never moved forward", async () => {
      const { workspaceId: ws, operation } = await seedApprovedOperation(db());
      await backdate(db(), "operations", "expires_at", operation.id);
      expect(await repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["approved"], to: "queued" })).toBeNull();
      expect((await repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["approved"], to: "cancelled" }))?.status).toBe("cancelled");
    });

    it("sets planDigest once and never replaces it; rejects secret-shaped results and oversized errors", async () => {
      const ws = newWorkspace();
      const { operation } = await repos.operations.create(db(), { workspaceId: ws, principal: user(), proposal: proposalFor(ws, { planDigest: "d".repeat(64) }) });
      const moved = await repos.operations.transition(db(), { workspaceId: ws, id: operation.id, from: ["proposed"], to: "cancelled", patch: { planDigest: "e".repeat(64) } });
      expect(moved?.planDigest).toBe("d".repeat(64));
      const seeded = await seedApprovedOperation(db());
      const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlLWJ5dGVz";
      await expectCode(
        repos.operations.transition(db(), { workspaceId: seeded.workspaceId, id: seeded.operation.id, from: ["approved"], to: "cancelled", patch: { result: { token: jwt } } }),
        "secret_material"
      );
      await expectCode(
        repos.operations.transition(db(), { workspaceId: seeded.workspaceId, id: seeded.operation.id, from: ["approved"], to: "cancelled", patch: { error: "x".repeat(4001) } }),
        "invalid_input"
      );
    });
  });

  describe("claimForExecution", () => {
    const claim = (ws: string, op: OperationRecord, extra: Record<string, unknown> = {}, handle = ctx.db) =>
      repos.operations.claimForExecution(handle, { workspaceId: ws, id: op.id, expectedDigest: op.proposalDigest, holder: "worker-1", ...extra });

    it("runs an approved operation that needs no approval, recording holder, start time and lease", async () => {
      const { workspaceId: ws, operation } = await seedApprovedOperation(db());
      const running = await claim(ws, operation, { leaseMs: 45_000 });
      expect(running.status).toBe("running");
      expect(running.startedAt).toBeDefined();
      expect(running.finishedAt).toBeUndefined();
      // a second claim finds it running
      await expectCode(claim(ws, operation), "invalid_state");
    });

    it("consumes the approval exactly once and refuses a second claim and a second consume", async () => {
      const seeded = await seedAwaitingApproval(db());
      const { workspaceId: ws } = seeded;
      const decided = await approve(db(), seeded, user("approver-1"));
      expect(decided.operation.status).toBe("approved");
      expect(decided.approval.consumedAt).toBeUndefined();

      const running = await claim(ws, decided.operation);
      expect(running.status).toBe("running");
      const approvals = await repos.approvals.listForOperation(db(), ws, running.id);
      expect(approvals).toHaveLength(1);
      expect(approvals[0].consumedAt).toBeDefined();

      await expectCode(claim(ws, decided.operation), "invalid_state");
      expect(await repos.approvals.consume(db(), { workspaceId: ws, operationId: running.id, proposalDigest: running.proposalDigest })).toEqual([]);
    });

    it("concurrent claimants: exactly one runs it, the other is told it is no longer claimable", async () => {
      const seeded = await seedAwaitingApproval(db());
      const decided = await approve(db(), seeded, user());
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => claim(seeded.workspaceId, decided.operation, { holder: `w-${i}` }, i % 2 ? ctx.db : ctx.db2))
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const failures = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
      expect(failures).toHaveLength(5);
      for (const f of failures) expect((f.reason as { code: string }).code).toBe("invalid_state");
      const approvals = await repos.approvals.listForOperation(db(), seeded.workspaceId, decided.operation.id);
      expect(approvals.filter((a) => a.consumedAt)).toHaveLength(1);
    });

    it("refuses a digest that is not the reviewed one and leaves the approval unconsumed", async () => {
      const seeded = await seedAwaitingApproval(db());
      const decided = await approve(db(), seeded, user());
      await expectCode(
        repos.operations.claimForExecution(db(), { workspaceId: seeded.workspaceId, id: decided.operation.id, expectedDigest: digest({ tampered: true }), holder: "w" }),
        "digest_mismatch"
      );
      const [a] = await repos.approvals.listForOperation(db(), seeded.workspaceId, decided.operation.id);
      expect(a.consumedAt).toBeUndefined();
      expect((await repos.operations.get(db(), seeded.workspaceId, decided.operation.id))?.status).toBe("approved");
      await expectCode(
        repos.operations.claimForExecution(db(), { workspaceId: seeded.workspaceId, id: decided.operation.id, expectedDigest: "not-a-digest", holder: "w" }),
        "invalid_input"
      );
    });

    it("refuses an expired operation, one not yet approved, and one whose approval expired", async () => {
      const expired = await seedApprovedOperation(db());
      await backdate(db(), "operations", "expires_at", expired.operation.id);
      await expectCode(claim(expired.workspaceId, expired.operation), "operation_expired");

      const awaiting = await seedAwaitingApproval(db());
      await expectCode(claim(awaiting.workspaceId, awaiting.operation), "invalid_state");

      const seeded = await seedAwaitingApproval(db());
      const decided = await approve(db(), seeded, user());
      await backdate(db(), "approvals", "expires_at", decided.approval.id);
      await expectCode(claim(seeded.workspaceId, decided.operation), "approval_required");
      expect((await repos.operations.get(db(), seeded.workspaceId, decided.operation.id))?.status).toBe("approved");
    });

    it("needs every required approver before it will run, and consumes all of them", async () => {
      const seeded = await seedAwaitingApproval(db(), { count: 2 });
      const first = await approve(db(), seeded, user("p1"));
      expect(first.operation.status).toBe("awaiting_approval");
      expect(first.approvals).toEqual({ have: 1, need: 2 });
      await expectCode(claim(seeded.workspaceId, first.operation), "invalid_state");
      const second = await approve(db(), seeded, user("p2"));
      expect(second.operation.status).toBe("approved");
      await claim(seeded.workspaceId, second.operation);
      const approvals = await repos.approvals.listForOperation(db(), seeded.workspaceId, second.operation.id);
      expect(approvals.filter((a) => a.consumedAt)).toHaveLength(2);
    });

    it("re-validates the policy bundle: an approval granted under another version is refused", async () => {
      const seeded = await seedAwaitingApproval(db(), { policyVersion: "a".repeat(64) });
      const decided = await approve(db(), seeded, user(), { policyVersion: "a".repeat(64) });
      await expectCode(claim(seeded.workspaceId, decided.operation, { expectedPolicyVersion: "f".repeat(64) }), "policy_changed");
      const [a] = await repos.approvals.listForOperation(db(), seeded.workspaceId, decided.operation.id);
      expect(a.consumedAt).toBeUndefined();
      await claim(seeded.workspaceId, decided.operation, { expectedPolicyVersion: "a".repeat(64) });
    });

    if (lane.independent) {
      it("a blocked environment fence is acquired before the operation row across independent PostgreSQL handles", async () => {
        const seeded=await seedApprovedOperation(db());
        const scope=`env:${seeded.operation.environmentId}`;
        const lease=(await repos.leases.acquire(db(),{scope,holder:"worker-order",workspaceId:seeded.workspaceId,ttlMs:60000}))!;
        let entered!:()=>void;const fenceEntered=new Promise<void>(resolve=>{entered=resolve;});
        const observed:Sql={query:(text,params)=>ctx.db2.query(text,params),tx:fn=>ctx.db2.tx(tx=>fn({
          query:(text,params)=>{if(text.includes("from platform.leases") && text.includes("for share"))entered();return tx.query(text,params);},
          tx:nested=>tx.tx(nested),
        }))};
        let claiming:Promise<OperationRecord>|undefined;
        try {
          await db().tx(async tx=>{
            await tx.query("select scope from platform.leases where scope=$1 for update",[scope]);
            claiming=repos.operations.claimForExecution(observed,{workspaceId:seeded.workspaceId,id:seeded.operation.id,expectedDigest:seeded.operation.proposalDigest,holder:"worker-order",lease:{scope,fenceToken:lease.fenceToken}});
            // Attach immediately so a failed lock-order assertion cannot leave an unhandled rejection.
            void claiming.catch(()=>undefined);
            await fenceEntered;
            const rows=await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update nowait",[seeded.workspaceId,seeded.operation.id]);
            expect(rows).toHaveLength(1);
          });
          expect((await claiming!)?.status).toBe("running");
        } finally {await claiming?.catch(()=>undefined);await repos.leases.release(db(),lease);}
      });
    }

    it("asserts the environment lease atomically: a stale fence changes nothing", async () => {
      const seeded = await seedAwaitingApproval(db());
      const decided = await approve(db(), seeded, user());
      const scope = `env:${decided.operation.environmentId}`;
      const stale = (await repos.leases.acquire(db(), { scope, holder: "worker-1", ttlMs: 30_000 }))!;
      await backdate(db(), "leases", "expires_at", scope, "scope");
      await repos.leases.acquire(db(), { scope, holder: "worker-2", ttlMs: 30_000 });

      await expect(claim(seeded.workspaceId, decided.operation, { lease: { scope, fenceToken: stale.fenceToken } })).rejects.toBeInstanceOf(LeaseLostError);
      expect((await repos.operations.get(db(), seeded.workspaceId, decided.operation.id))?.status).toBe("approved");
      const [a] = await repos.approvals.listForOperation(db(), seeded.workspaceId, decided.operation.id);
      expect(a.consumedAt).toBeUndefined();

      const live = (await repos.leases.current(db(), scope))!;
      const running = await claim(seeded.workspaceId, decided.operation, { holder: "worker-2", lease: { scope, fenceToken: live.fenceToken } });
      expect(running.leaseScope).toBe(scope);
      expect(running.fenceToken).toBe(live.fenceToken);
      expect(typeof running.fenceToken).toBe("number");
    });
  });

  describe("fenced completion and heartbeat", () => {
    async function running(fence = true) {
      const seeded = await seedApprovedOperation(db());
      const scope = `env:${seeded.operation.environmentId}`;
      const lease = (await repos.leases.acquire(db(), { scope, holder: "worker-1", ttlMs: 30_000 }))!;
      const op = await repos.operations.claimForExecution(db(), {
        workspaceId: seeded.workspaceId,
        id: seeded.operation.id,
        expectedDigest: seeded.operation.proposalDigest,
        holder: "worker-1",
        lease: fence ? { scope, fenceToken: lease.fenceToken } : undefined,
      });
      return { ws: seeded.workspaceId, op, scope, lease };
    }

    it("finishes with the matching fence; a lost lease throws and changes nothing; a mismatched fence returns null", async () => {
      const { ws, op, scope, lease } = await running();
      // a different (later) fence than the one the operation was claimed under cannot finish it
      await backdate(db(), "leases", "expires_at", scope, "scope");
      const taken = (await repos.leases.acquire(db(), { scope, holder: "worker-2", ttlMs: 30_000 }))!;
      await expect(
        repos.operations.transition(db(), { workspaceId: ws, id: op.id, from: ["running"], to: "succeeded", fence: { scope, fenceToken: lease.fenceToken } })
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(
        await repos.operations.transition(db(), { workspaceId: ws, id: op.id, from: ["running"], to: "succeeded", fence: { scope, fenceToken: taken.fenceToken } })
      ).toBeNull();
      expect((await repos.operations.get(db(), ws, op.id))?.status).toBe("running");
    });

    it("finishes successfully with result, clearing the execution lease", async () => {
      const { ws, op, scope, lease } = await running();
      const done = await repos.operations.transition(db(), {
        workspaceId: ws,
        id: op.id,
        from: ["running"],
        to: "succeeded",
        patch: { result: { applied: 3 } },
        fence: { scope, fenceToken: lease.fenceToken },
      });
      expect(done?.status).toBe("succeeded");
      expect(done?.result).toEqual({ applied: 3 });
      expect(done?.finishedAt).toBeDefined();
      expect(await repos.operations.heartbeat(db(), { workspaceId: ws, id: op.id, holder: "worker-1" })).toBe(false);
    });

    it("heartbeat extends only for the holder while running", async () => {
      const { ws, op } = await running(false);
      expect(await repos.operations.heartbeat(db(), { workspaceId: ws, id: op.id, holder: "worker-1", leaseMs: 60_000 })).toBe(true);
      expect(await repos.operations.heartbeat(db(), { workspaceId: ws, id: op.id, holder: "someone-else" })).toBe(false);
      expect(await repos.operations.heartbeat(db(), { workspaceId: newWorkspace(), id: op.id, holder: "worker-1" })).toBe(false);
    });
  });

  describe("reconcilers", () => {
    it("marks a running operation whose execution lease lapsed as uncertain — once, and never re-dispatchable", async () => {
      const seeded = await seedApprovedOperation(db());
      const op = await repos.operations.claimForExecution(db(), { workspaceId: seeded.workspaceId, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "w" });
      // still healthy: nothing to reconcile for this operation
      expect((await repos.operations.markUncertainExpired(db(), 1000)).map((o) => o.id)).not.toContain(op.id);

      await backdate(db(), "operations", "lease_until", op.id);
      // (assertions are on the final row, not on this call's return value: on the shared Postgres schema
      // another suite's reconciler pass may legitimately have resolved this row first)
      const first = await repos.operations.markUncertainExpired(db(), 1000);
      expect(first.every((o) => o.status === "uncertain" && o.workspaceId && o.finishedAt)).toBe(true);
      const mine = await repos.operations.get(db(), seeded.workspaceId, op.id);
      expect(mine?.status).toBe("uncertain");
      expect(mine?.finishedAt).toBeDefined();
      expect(mine?.error).toMatch(/unknown/);
      expect((await repos.operations.markUncertainExpired(db(), 1000)).map((o) => o.id)).not.toContain(op.id);

      await expectCode(
        repos.operations.claimForExecution(db(), { workspaceId: seeded.workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: "w2" }),
        "invalid_state"
      );
      expect(await repos.operations.transition(db(), { workspaceId: seeded.workspaceId, id: op.id, from: ["running"], to: "succeeded" })).toBeNull();
    });

    it("marks a running operation uncertain when its environment lease is lost or taken over", async () => {
      for (const how of ["expired", "taken over"] as const) {
        const seeded = await seedApprovedOperation(db());
        const scope = `env:${seeded.operation.environmentId}`;
        const lease = (await repos.leases.acquire(db(), { scope, holder: "w", ttlMs: 30_000 }))!;
        const op = await repos.operations.claimForExecution(db(), {
          workspaceId: seeded.workspaceId,
          id: seeded.operation.id,
          expectedDigest: seeded.operation.proposalDigest,
          holder: "w",
          lease: { scope, fenceToken: lease.fenceToken },
        });
        if (how === "expired") await backdate(db(), "leases", "expires_at", scope, "scope");
        else {
          await backdate(db(), "leases", "expires_at", scope, "scope");
          await repos.leases.acquire(db(), { scope, holder: "someone-else", ttlMs: 30_000 });
        }
        await repos.operations.markUncertainExpired(db(), 1000);
        expect((await repos.operations.get(db(), seeded.workspaceId, op.id))?.status, how).toBe("uncertain");
      }
    });

    it("expires pre-execution operations past their deadline and never touches a running one", async () => {
      const ws = newWorkspace();
      const proposed = (await repos.operations.create(db(), { workspaceId: ws, principal: user(), proposal: proposalFor(ws) })).operation;
      const approved = (await seedApprovedOperation(db(), ws)).operation;
      const runningSeed = await seedApprovedOperation(db(), ws);
      const running = await repos.operations.claimForExecution(db(), { workspaceId: ws, id: runningSeed.operation.id, expectedDigest: runningSeed.operation.proposalDigest, holder: "w" });
      for (const o of [proposed, approved, running]) await backdate(db(), "operations", "expires_at", o.id);
      const expired = await repos.operations.expireOverdue(db(), 1000);
      expect(expired.map((o) => o.id)).not.toContain(running.id);
      // final state, not the return value (another suite's reconciler may have expired them first on a shared schema)
      expect((await repos.operations.get(db(), ws, proposed.id))?.status).toBe("expired");
      expect((await repos.operations.get(db(), ws, approved.id))?.status).toBe("expired");
      expect((await repos.operations.get(db(), ws, running.id))?.status).toBe("running");
    });
  });

  it("the service commits the operation and its event together, and a replay appends no second event", async () => {
    const ws = newWorkspace();
    const proposal = proposalFor(ws);
    const p = user();
    const a = await proposeOperation(db(), { workspaceId: ws, principal: p, proposal, idempotencyKey: "svc-1" });
    const b = await proposeOperation(db(), { workspaceId: ws, principal: p, proposal, idempotencyKey: "svc-1" });
    expect(b.created).toBe(false);
    const events = await repos.events.list(db(), ws, { operationId: a.operation.id });
    expect(events.map((e) => e.type)).toEqual(["operation.proposed"]);
    expect(events[0].correlationId).toBe(a.operation.correlationId);
    expect(events[0].actor?.id).toBe(p.id);
  });
});
