'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
interface Operation {id:string;digest:string;action:string;subject:string;phase:string;expiresAt:string;target:{projectId:string;environmentId?:string};plan:{summary?:string;details?:string[];warnings?:string[];blocked?:string;costDeltaUsd?:number;approvalRole?:string};source?:{repository:string;commit:string;pullRequest?:number}}
interface Grant {clientId:string;projectIds:string[];environmentIds?:string[];appIds:string[];scopes:string[];expiresAt:string;revoked?:boolean}
interface State {workspaceId:string;subject:string;role:string;resource:string;oauthConfigured:boolean;projects:{id:string;name:string}[];grants:Grant[];operations:Operation[]}
async function request<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
  const data=await response.json();if(!response.ok)throw Error(data?.error?.message??'Request failed.');return data;
}
export default function IntegrationControl(){
  const [state,setState]=useState<State>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [clientId,setClientId]=useState(''),[projectIds,setProjectIds]=useState<string[]>([]),[appIds,setAppIds]=useState(''),[days,setDays]=useState(1),[scopes,setScopes]=useState(['read']);
  const load=useCallback(async(signal?:AbortSignal)=>{try{setState(await request<State>('/api/integrations/agent',undefined,signal));setError('');}catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'Could not load integrations.');}},[]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);const query=new URLSearchParams(window.location.search);setClientId((query.get('client')??'').slice(0,200));return()=>controller.abort();},[load]);
  async function act(url:string,body:unknown,success:string){setBusy(true);setError('');setNotice('');try{await request(url,body);setNotice(success);await load();}catch(e){setError(e instanceof Error?e.message:'Request refused.');}finally{setBusy(false);}}
  function grant(event:FormEvent){event.preventDefault();void act('/api/integrations/agent/grants',{clientId,projectIds,appIds:appIds.split(',').map(s=>s.trim()).filter(Boolean),scopes,days,revoked:false},'Integration grant saved. This does not deploy anything.');}
  return <main className="mx-auto max-w-5xl space-y-8 p-6">
    <header><p className="text-sm text-muted-foreground">Workspace control</p><h1 className="text-3xl font-semibold">Agent integrations</h1><p className="mt-2 text-muted-foreground">Authorize narrowly scoped clients and review exact proposals. An agent cannot approve its own request.</p></header>
    {error&&<p role="alert" className="rounded-lg border p-4">{error}</p>}{notice&&<p role="status" className="rounded-lg border p-4">{notice}</p>}
    <button type="button" className="rounded border px-4 py-2" disabled={busy} onClick={()=>void load()}>Refresh status</button>
    {state&&<>
      <section className="space-y-4 rounded-xl border p-5"><h2 className="text-xl font-semibold">Connect an OAuth client</h2><p className="text-sm">Resource: <code className="break-all">{state.resource}</code>. Verify the client ID against your authorization provider. Local development credentials are issued by the operator, not this screen.</p>
        {!state.oauthConfigured?<p>Remote OAuth is not configured on this instance.</p>:<form onSubmit={grant} className="space-y-4">
          <label className="block">OAuth client ID<input className="mt-1 w-full rounded border bg-transparent p-2" value={clientId} onChange={e=>setClientId(e.target.value)} maxLength={200} required autoComplete="off"/></label>
          <fieldset><legend>Projects</legend><div className="flex flex-wrap gap-4">{state.projects.map(p=><label key={p.id}><input type="checkbox" checked={projectIds.includes(p.id)} onChange={e=>setProjectIds(ids=>e.target.checked?[...ids,p.id]:ids.filter(id=>id!==p.id))}/> {p.name}</label>)}</div></fieldset>
          <fieldset><legend>Permitted operations</legend><div className="flex flex-wrap gap-4">{['read','plan','export','write','publish','logs'].map(s=><label key={s}><input type="checkbox" disabled={s==='read'||state.role==='viewer'&&['write','publish'].includes(s)} checked={scopes.includes(s)} onChange={e=>setScopes(values=>e.target.checked?[...values,s]:values.filter(v=>v!==s))}/> {s}</label>)}</div></fieldset>
          <label className="block">Owned app IDs for publishing (comma separated)<input className="mt-1 w-full rounded border bg-transparent p-2" value={appIds} onChange={e=>setAppIds(e.target.value)} maxLength={10000}/></label>
          <label className="block">Expiry in days<input className="ml-3 w-20 rounded border bg-transparent p-2" type="number" min={1} max={30} value={days} onChange={e=>setDays(Number(e.target.value))}/></label>
          <button className="rounded border px-4 py-2" disabled={busy||!projectIds.length}>Authorize selected access</button>
        </form>}
        <ul className="space-y-3">{state.grants.map(g=><li key={g.clientId} className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"><div><strong className="break-all">{g.clientId}</strong><p className="text-sm">{g.revoked?'Revoked':g.scopes.join(', ')} · expires {g.expiresAt}</p></div><button className="rounded border px-3 py-2" disabled={busy||g.revoked} onClick={()=>void act('/api/integrations/agent/grants',{clientId:g.clientId,projectIds:g.projectIds,environmentIds:g.environmentIds,appIds:g.appIds??[],scopes:g.scopes,days:1,revoked:true},'Access revoked for subsequent requests.')}>Revoke</button></li>)}</ul>
      </section>
      <section className="space-y-4"><h2 className="text-xl font-semibold">Proposals awaiting review</h2><p className="text-sm text-muted-foreground">Approval authorizes exactly this digest until expiry. It does not execute the proposal. The authorized client must dispatch it separately.</p>
        {!state.operations.length&&<p>No pending proposals in this workspace.</p>}
        {state.operations.map(op=><article key={op.id} id={op.id} className="space-y-3 rounded-xl border p-5">
          <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{op.plan.summary??op.action}</h3><span>{op.phase}</span></div>
          <p className="text-sm">Project {op.target.projectId} {op.target.environmentId&&`· environment ${op.target.environmentId}`} · requested by {op.subject}</p>
          <p className="text-sm">Estimated monthly change: ${op.plan.costDeltaUsd??0} · approval role: {op.plan.approvalRole} · expires {op.expiresAt}</p>
          <ul className="list-disc space-y-1 pl-5">{op.plan.details?.map((line,index)=><li key={index}>{line}</li>)}</ul>
          {op.source&&<p className="break-all text-sm">Source: {op.source.repository} @ {op.source.commit}{op.source.pullRequest&&` · PR #${op.source.pullRequest}`}</p>}
          {op.plan.warnings?.map((line,index)=><p key={index} className="text-sm">Warning: {line}</p>)}
          {op.plan.blocked&&<p role="alert">Blocked: {op.plan.blocked}</p>}
          <details><summary className="cursor-pointer text-sm">Exact proposal identity</summary><p className="break-all font-mono text-xs">{op.id}<br/>{op.digest}</p></details>
          {op.phase==='prepared'&&<div className="flex gap-3"><button className="rounded border px-4 py-2" disabled={busy||!!op.plan.blocked||Date.parse(op.expiresAt)<=Date.now()||op.plan.approvalRole==='admin'&&state.role!=='admin'} onClick={()=>void act('/api/integrations/agent/review',{operationId:op.id,digest:op.digest,approve:true},'Exact proposal approved. No execution was requested by this screen.')}>Approve exact proposal</button><button className="rounded border px-4 py-2" disabled={busy} onClick={()=>void act('/api/integrations/agent/review',{operationId:op.id,digest:op.digest,approve:false},'Proposal rejected.')}>Reject</button></div>}
        </article>)}
      </section>
    </>}
  </main>;
}
