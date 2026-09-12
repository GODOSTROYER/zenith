import { describe, it, expect } from 'vitest';
import { Journal, type Principal, type Proposal } from '../src/lib/agent-access/control/journal';
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
  it('does not give an unauthenticated caller approval through input',async()=>{
    const f=fixture();try{const op=await f.coordinator.prepare(who,{approved:true});await expect(f.coordinator.execute(async()=>who,op.id)).rejects.toThrow('approve');expect(f.count().executions).toBe(0);}finally{f.close();}
  });
  it('mutation gate is reentrant and releases on throw',async()=>{
    await expect(withMutationGate(()=>withMutationGate(async()=>{throw Error('expected');}))).rejects.toThrow('expected');
    expect(await withMutationGate(async()=>42)).toBe(42);
  });
});
