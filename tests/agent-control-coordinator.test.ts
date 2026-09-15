import { describe, it, expect } from 'vitest';
import { ControlError, Journal, type Principal, type Proposal } from '../src/lib/agent-access/control/journal';
import { Coordinator, type ControlPort } from '../src/lib/agent-access/control/coordinator';
import { withMutationGate } from '../src/lib/actions/mutation-gate';
const who: Principal = { subject:'member', integrationId:'codex', workspaceId:'ws', projectIds:['p'], scopes:['read','plan','write'], expiresAt:'2099-01-01T00:00:00Z' };
const proposal: Proposal = { action:'deploy.apply', input:{}, target:{workspaceId:'ws',projectId:'p'}, fingerprint:'state', plan:{}, requestKey:'request_0001' };
function fixture(patch: Partial<ControlPort> = {}) {
  const journal = new Journal(':memory:'); let executions = 0, flushes = 0;
  const port: ControlPort = { gate:withMutationGate, scope:async(_,f)=>f(), proposal:async()=>proposal, fingerprint:async()=>proposal.fingerprint,
    authorize:async()=>{}, execute:async()=>{ executions++; return {ok:true, data:{deploymentId:'dep'}}; }, flush:async()=>{flushes++;}, ...patch };
  const coordinator = new Coordinator(journal, port);
  return { journal, coordinator, count:()=>({executions,flushes}), close:()=>journal.close() };
}
async function approved(f: ReturnType<typeof fixture>) { const op=await f.coordinator.prepare(who, {}); f.journal.review(op.id,who.subject,who.workspaceId,op.digest,true); return op; }
describe('integration coordinator',()=>{
  it('serializes simultaneous agents and flushes before durable completion', async()=>{
    const f=fixture(); try { const op=await approved(f);
      const results=await Promise.all([f.coordinator.execute(async()=>who,op.id),f.coordinator.execute(async()=>({...who,integrationId:'claude'}),op.id)]);
      expect(f.count()).toEqual({executions:1,flushes:1}); expect(results.map(r=>r.phase)).toEqual(['succeeded','succeeded']);
    } finally {f.close();}
  });
  it('failed flush is uncertain and never redispatched', async()=>{
    const f=fixture({flush:async()=>{throw Error('disk failure');}});try{ const op=await approved(f);
      await expect(f.coordinator.execute(async()=>who,op.id)).rejects.toThrow('may have been accepted');
      expect(f.journal.get(who,op.id).phase).toBe('uncertain');
      expect((await f.coordinator.execute(async()=>who,op.id)).phase).toBe('uncertain');expect(f.count().executions).toBe(1);
    }finally{f.close();}
  });
  it('rechecks authority and fingerprint before claiming',async()=>{
    let allowed=true;const f=fixture({authorize:async()=>{if(!allowed)throw Error('revoked');}});try{ const op=await approved(f);allowed=false;
      await expect(f.coordinator.execute(async()=>who,op.id)).rejects.toThrow('revoked');expect(f.count().executions).toBe(0);
    }finally{f.close();}
    const stale=fixture({fingerprint:async()=>'changed'});try{const op=await approved(stale);await expect(stale.coordinator.execute(async()=>who,op.id)).rejects.toThrow('State or permissions changed');expect(stale.count().executions).toBe(0);}finally{stale.close();}
  });
  it('does not finalize dispatch after authorization is revoked in flight',async()=>{
    let dispatched=false, identityCalls=0;
    const f=fixture({execute:async()=>{dispatched=true;return {ok:true};}});
    try {
      const op=await approved(f);
      await expect(f.coordinator.execute(async()=>{
        identityCalls++;
        if(identityCalls === 2) throw new ControlError('revoked','revoked');
        return who;
      },op.id)).rejects.toThrow('may have been accepted');
      expect(f.journal.get(who,op.id).phase).toBe('uncertain');
      expect(dispatched).toBe(true);
      expect(f.count().flushes).toBe(1);
    } finally { f.close(); }
  });
  it('does not finalize when application membership or role changes in flight',async()=>{
    let digestCalls = 0;
    const f=fixture({applicationAuthorizationDigest:async()=>digestCalls++ === 0 ? 'member-before' : 'member-after'});
    try {
      const op=await approved(f);
      await expect(f.coordinator.execute(async()=>who,op.id)).rejects.toThrow('may have been accepted');
      expect(f.journal.get(who,op.id).phase).toBe('uncertain');
      expect(f.count().executions).toBe(1);
    } finally { f.close(); }
  });
  /**
   * The authorization digest is compared before and after dispatch, so anything
   * in it that the operation itself writes turns a successful publish into
   * `outcome_uncertain`: `app.rollback` moves `activeReleaseId`, `activeFence`
   * and `updatedAt` during activation, and the in-process job runner can reach
   * that within the milliseconds between `execute()` returning and the digest
   * being recomputed. Intermittently, which is worse than deterministically.
   */
  it('reports a successful publish as success when only the app release state moved',async()=>{
    // What the application hands over: an app row that carries its release
    // pointers, and a member and grant that did not change at all.
    const before = { id:'app_1', workspaceId:'ws', state:'active', activeReleaseId:'rel_1', activeFence:1, updatedAt:'2026-09-15T10:00:00Z' };
    const after  = { id:'app_1', workspaceId:'ws', state:'active', activeReleaseId:'rel_2', activeFence:2, updatedAt:'2026-09-15T10:00:01Z' };
    let reads = 0;
    // The port hands the whole row over, release pointers and all: narrowing it
    // to the authorization-relevant fields is the coordinator's job, and that is
    // what this test is about.
    const f=fixture({applicationAuthority:async()=>({
      member:{id:'member',workspaceId:'ws',role:'admin'},
      app: reads++ === 0 ? before : after,
      grant:{id:'grant_1',subject:'member',role:'owner',revokedAt:null},
    })});
    try {
      const op=await approved(f);
      const finished=await f.coordinator.execute(async()=>who,op.id);
      expect(finished.phase).toBe('succeeded');
      expect(f.count()).toEqual({executions:1,flushes:1});
      expect(reads).toBe(2); // both digests were taken; they simply agree
    } finally { f.close(); }
  });
  it('is still uncertain when the authority itself changed in flight',async()=>{
    // Same shape, but the grant is revoked while the action is dispatching —
    // the case the digest exists for.
    let reads = 0;
    const f=fixture({applicationAuthority:async()=>({
      member:{id:'member',workspaceId:'ws',role:'admin'},
      app:{id:'app_1',workspaceId:'ws',state:'active'},
      grant:reads++ === 0 ? {id:'grant_1',subject:'member',role:'owner',revokedAt:null}
                          : {id:'grant_1',subject:'member',role:'owner',revokedAt:'2026-09-15T10:00:01Z'},
    })});
    try {
      const op=await approved(f);
      await expect(f.coordinator.execute(async()=>who,op.id)).rejects.toThrow('may have been accepted');
      expect(f.journal.get(who,op.id).phase).toBe('uncertain');
      expect(f.count().executions).toBe(1);
    } finally { f.close(); }
    // A demotion that keeps the role name but changes the workspace, and a role
    // change, are equally caught.
    for (const changed of [{id:'member',workspaceId:'ws-other',role:'admin'},{id:'member',workspaceId:'ws',role:'editor'}]) {
      let n = 0;
      const g=fixture({applicationAuthority:async()=>({ member:n++ === 0 ? {id:'member',workspaceId:'ws',role:'admin'} : changed })});
      try {
        const op=await approved(g);
        await expect(g.coordinator.execute(async()=>who,op.id)).rejects.toThrow('may have been accepted');
        expect(g.journal.get(who,op.id).phase).toBe('uncertain');
      } finally { g.close(); }
    }
  });
  it('does not give an unauthenticated caller approval through input',async()=>{
    const f=fixture();try{const op=await f.coordinator.prepare(who,{approved:true});await expect(f.coordinator.execute(async()=>who,op.id)).rejects.toThrow('approve');expect(f.count().executions).toBe(0);}finally{f.close();}
  });
  it('mutation gate is reentrant and releases on throw',async()=>{
    await expect(withMutationGate(()=>withMutationGate(async()=>{throw Error('expected');}))).rejects.toThrow('expected');
    expect(await withMutationGate(async()=>42)).toBe(42);
  });
});

/**
 * The wiring the Postgres journal is still waiting on.
 *
 * `AgentJournal` (F5) is all-promise, because a network round trip cannot be a
 * return value. `Coordinator` reads its journal synchronously — and so do
 * `browser.ts` (`control().journal.reviewQueue(...).map(...)`) and
 * `boundary.ts` (`bindGrant(identity, control().journal.getGrant(...))`). Those
 * three files have to gain `await` in one commit, and they belong to three
 * different packets, so none of them can do it alone.
 *
 * This pins the current state rather than asserting it is right: if the
 * coordinator is switched onto the asynchronous journal without the other two,
 * this fails here instead of in a browser that silently renders no review
 * queue.
 */
describe('coordinator journal surface',()=>{
  it('still reads the journal synchronously, which is why Postgres is not wired yet',async()=>{
    const f=fixture();
    try{
      const op=await approved(f);
      // Not a promise: `Coordinator.execute` does `const op = this.journal.get(...)`
      // and then reads `op.target` on the next line.
      const read=f.journal.get(who,op.id);
      expect(read).not.toBeInstanceOf(Promise);
      expect(read.target.workspaceId).toBe('ws');
      expect(f.journal.reviewQueue('ws',who.subject,true)).not.toBeInstanceOf(Promise);
      expect(f.journal.getGrant(who.subject,'client','ws')).not.toBeInstanceOf(Promise);
    } finally {f.close();}
  });
  it('keeps uncertain a terminal answer, never a retry',async()=>{
    let dispatches=0;
    const f=fixture({execute:async()=>{dispatches++;throw new ControlError('provider_failed','the provider did not answer');}});
    try{
      const op=await approved(f);
      await expect(f.coordinator.execute(async()=>who,op.id)).rejects.toThrow('may have been accepted');
      expect(f.journal.get(who,op.id).phase).toBe('uncertain');
      // A second attempt is handed the uncertainty, not a fresh dispatch: the
      // side effect may have happened and nothing here can find out.
      expect((await f.coordinator.execute(async()=>who,op.id)).phase).toBe('uncertain');
      expect(dispatches).toBe(1);
    } finally {f.close();}
  });
});
