/** Default C3 access: workspace authority is checked even without App configuration. */
import { platformDb } from "@/lib/controlplane/db/open";
import type { Sql } from "@/lib/controlplane/types";
import { createGithubApp, githubAppConfig } from "./app";
import { createGithubSourceStore } from "./store";
import { GithubSourceError, repository, type GithubAccessScope } from "./types";

export function createGithubAccess(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }) {
  return async function withGithubAccess<T>(input: GithubAccessScope, fn: (token?: string) => Promise<T>): Promise<T> {
    if (!input.workspaceId) return fn();
    const requested = repository(input.owner, input.repo);
    try {
      const store = createGithubSourceStore(await deps.db());
      const binding = await store.getBinding(input.workspaceId);
      if (!binding) return await fn();
      const config = githubAppConfig(deps.env);
      if (!config || binding.appId !== config.appId || binding.owner !== requested.owner || binding.repo !== requested.repo) throw new GithubSourceError("refused");
      return await createGithubApp(config, { fetchImpl: deps.fetchImpl }).withRepositoryAccess(binding, async (token) => {
        // Token acquisition can race a browser revocation or a replacement binding.
        await store.assertCurrent(binding);
        return fn(token);
      }, input.signal);
    } catch { throw new GithubSourceError("unavailable"); }
  };
}
export const defaultGithubAccess = createGithubAccess({ db: platformDb });

/** Immutable source reads: fixed REST endpoints, bounded data, no provider URLs. */
export function createGithubImmutableSourceAccess(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string,string|undefined>> }) {
  return async <T>(input: import("./types").GithubImmutableSourceRequest, read: (source: import("./types").GithubImmutableSource, token?: string) => Promise<T>): Promise<T> => {
    const location=repository(input.owner,input.repo);
    if(!input.workspaceId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.workspaceId) || typeof input.ref!=="string" || input.ref.length>250
      || !input.ref || input.ref.split("/").some(p=>! /^[A-Za-z0-9._+@~-]{1,100}$/.test(p) || [".",".."].includes(p))) throw new GithubSourceError("invalid");
    const signal=AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(60_000)]);
    const check=()=>{if(signal.aborted)throw new GithubSourceError("unavailable");};
    // Race dependency/transport promises too; a late completion never supplies authority.
    const bounded=<V>(pending:Promise<V>):Promise<V>=>new Promise((resolve,reject)=>{
      const stop=()=>{signal.removeEventListener("abort",stop);reject(new GithubSourceError("unavailable"));};
      signal.addEventListener("abort",stop,{once:true});pending.then(v=>{signal.removeEventListener("abort",stop);if(signal.aborted)stop();else resolve(v);},()=>stop());if(signal.aborted)stop();
    });
    try {
      const store=createGithubSourceStore(await bounded(deps.db())),binding=await bounded(store.getBinding(input.workspaceId));
      const retained=input.expected;
      const authority=binding?{appId:binding.appId,installationId:binding.installationId,repositoryId:binding.repositoryId,version:binding.version}:null;
      if(retained && (retained.owner!==location.owner || retained.repo!==location.repo || JSON.stringify(retained.binding)!==JSON.stringify(authority))) throw new GithubSourceError("refused");
      const current=async()=>{check();if(binding)await bounded(store.assertCurrent(binding));else if(await bounded(store.getBinding(input.workspaceId)))throw new GithubSourceError("refused");check();};
      const fetchData=async(path:string,token:string|undefined,accept:string,cap:number):Promise<string>=>{
        check();const pending=(deps.fetchImpl??fetch)(`https://api.github.com/repos/${location.owner}/${location.repo}${path}`,{headers:{Accept:accept,"User-Agent":"zenith-approved-source","X-GitHub-Api-Version":"2026-03-10",...(token?{Authorization:`Bearer ${token}`}:{})},redirect:"error",signal});
        void pending.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>undefined);},()=>undefined);
        const response=await bounded(pending);
        if(!response.ok || Number(response.headers.get("content-length"))>cap || !response.body){void response.body?.cancel().catch(()=>undefined);throw new GithubSourceError("unavailable");}
        const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
        try{for(;;){const next=await bounded(reader.read());if(next.done)break;length+=next.value.length;if(length>cap)throw new GithubSourceError("unavailable");chunks.push(next.value);}check();return new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));}
        finally{void reader.cancel().catch(()=>undefined);reader.releaseLock();}
      };
      const run=async(token?:string):Promise<T>=>{
        await current();
        const info=JSON.parse(await fetchData("",token,"application/vnd.github+json",64*1024)) as {id?:unknown;private?:unknown;name?:unknown;owner?:{login?:unknown}};
        if(typeof info.id!=="number" || !Number.isSafeInteger(info.id) || info.id<1 || typeof info.name!=="string" || typeof info.owner?.login!=="string"
          || info.name.toLowerCase()!==location.repo || info.owner.login.toLowerCase()!==location.owner || typeof info.private!=="boolean"
          || (!binding && info.private!==false) || (binding && binding.repositoryId!==info.id) || (retained && retained.repositoryId!==info.id)) throw new GithubSourceError("refused");
        const commit=(await fetchData(`/commits/${encodeURIComponent(input.ref)}`,token,"application/vnd.github.sha",128)).trim();
        if(!/^[a-f0-9]{40}$/.test(commit) || (retained && commit!==retained.commitSha)) throw new GithubSourceError("refused");
        const source=Object.freeze({...location,repositoryId:info.id,commitSha:commit,binding:authority?Object.freeze(authority):null});
        await current();const result=await bounded(read(source,token));await current();return result;
      };
      if(!binding)return await run();
      const config=githubAppConfig(deps.env);
      if(!config || config.appId!==binding.appId || binding.owner!==location.owner || binding.repo!==location.repo)throw new GithubSourceError("refused");
      return await bounded(createGithubApp(config,{fetchImpl:deps.fetchImpl}).withRepositoryAccess(binding,run,signal));
    }catch{throw new GithubSourceError("unavailable");}
  };
}
export const defaultGithubImmutableSourceAccess=createGithubImmutableSourceAccess({db:platformDb});
