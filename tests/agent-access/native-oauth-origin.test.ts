/** Actual PostgreSQL/default factories. Configuration and principals model already authenticated inputs. No tokens, consent, JWKS or provider calls. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, json, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Principal } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import { pgAuthorityClient, closePgAuthorityClient } from "@/lib/hosted/authority/pg/client";
import { PgAgentJournal, pgAgentJournal, resetPgAgentJournal, isDefaultPgAgentJournal, isDefaultPgAgentJournalFor, readDefaultNativeOAuthGrant } from "@/lib/agent-access/control/journal-pg";
import { agentJournal, isDefaultAgentJournalSelection } from "@/lib/agent-access/control/runtime";
import { currentIntegrationGrant, readCurrentNativeOAuthGrant, isCurrentNativeOAuthGrantFor } from "@/lib/capabilities/current-integration-grants";
const url = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim();
const required = process.env.ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED === "1";
const explicit = () => { try { return !!url && !!new URL(url).port; } catch { return false; } };
if (required && (!explicit() || PLATFORM_SCHEMA_VERSION < 13)) throw new Error("Native OAuth dispatch requires owning PostgreSQL, explicit port and canonical platform/agent migrations.");
const issuer = "https://issuer.example.test";
function restoreProperty(target: object, key: PropertyKey, replacement: PropertyDescriptor) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...replacement });
  return () => { if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key); };
}
function forget() { resetPgAgentJournal(); Reflect.deleteProperty(globalThis, "__zenithAgentJournal"); Reflect.deleteProperty(globalThis, "__zenithPgCredentialAuthority"); }
describe.skipIf(!url)("native OAuth journal current origin [postgres]", () => {
  let owner: PlatformDbHandle, peer: PlatformDbHandle;
  const created: string[] = [];
  beforeAll(async () => {
    owner = await openPlatformDb({ kind: "postgres", url: url!, migrate: true, max: 1 });
    peer = await openPlatformDb({ kind: "postgres", url: url!, max: 1 });
    const migrations = await owner.query<{ version: number; name: string }>("select version,name from agent.schema_migrations order by version");
    for (const [version, name] of [[1,"agent-link-v1"],[2,"agent-control-v1"],[3,"agent-oauth-grants-v1"]] as const)
      expect(migrations).toContainEqual({ version, name });
    expect((await owner.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='agent' and table_name='agent_oauth_grants'"))).toHaveLength(1);
  }, 60000);
  beforeEach(async () => {
    await closePgAuthorityClient(); forget(); vi.stubEnv("ZENITH_STORE", "postgres"); vi.stubEnv("SUPABASE_DB_URL", url!);
    vi.stubEnv("ZENITH_AGENT_CONTROL", "1"); vi.stubEnv("ZENITH_AGENT_ORIGIN", "https://zenith.example.test");
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", issuer); vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", `${issuer}/jwks`);
    vi.stubEnv("ZENITH_AGENT_OAUTH_CLIENT_CLAIM", "client_id"); vi.stubEnv("ZENITH_AGENT_OAUTH_SUBJECT_CLAIM", "sub");
  });
  afterEach(async () => { await closePgAuthorityClient(); forget(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    try { for (const id of created) { await owner.query("delete from agent.agent_credentials where id=$1", [id]); await owner.query("delete from agent.agent_oauth_grants where integration_id=$1", [id]); } }
    finally { await peer?.close(); await owner?.close(); }
  });
  async function seed(appIds: string[] | null = null) {
    const id = `integration_${randomUUID()}`, workspaceId = `ws_${randomUUID()}`, projectId = `proj_${randomUUID()}`, environmentId = `env_${randomUUID()}`;
    created.push(id);
    const principal: Principal = { kind: "integration", id, integrationId: id, onBehalfOf: "oauth_subject", name: "Native OAuth origin fixture" };
    await owner.query(`insert into agent.agent_oauth_grants(integration_id,subject,client_id,workspace_id,oauth_issuer,expires_at,revoked,project_ids,environment_ids,app_ids,scopes)
      values($1,'oauth_subject','explicit-client',$2,$3,$4,false,$5::text::jsonb,$6::text::jsonb,$7::text::jsonb,'["read","plan","write"]'::jsonb)`,
      [id,workspaceId,issuer,new Date(Date.now()+120000).toISOString(),json([projectId]),json([environmentId]),appIds === null ? null : json(appIds)]);
    return { principal, workspaceId, projectId, environmentId };
  }
  it("genuine default journal and selector capture the exact nonsecret owning OAuth tuple", async () => {
    const f = await seed(), journal = await agentJournal();
    expect(journal).toBe(pgAgentJournal()); expect(isDefaultAgentJournalSelection(journal)).toBe(true);
    expect(isDefaultPgAgentJournalFor(journal, owner)).toBe(true); expect(isDefaultPgAgentJournalFor(journal, peer)).toBe(true);
    const direct = await readDefaultNativeOAuthGrant(journal, f.principal, f.workspaceId);
    expect(Object.keys(direct!).sort()).toEqual(["integration_id","subject","client_id","workspace_id","oauth_issuer","expires_at","revoked","project_ids","environment_ids","app_ids","scopes"].sort());
    expect(await currentIntegrationGrant(f.principal, f.workspaceId)).toEqual({ scopes:["read","plan","write"],projectIds:[f.projectId],environmentIds:[f.environmentId] });
    const tuple = readCurrentNativeOAuthGrant(f.principal, f.workspaceId, owner)!;
    expect(Object.isFrozen(tuple)).toBe(true); expect(Object.isFrozen(tuple.scopes)).toBe(true);
    expect(isCurrentNativeOAuthGrantFor(tuple, peer, f.workspaceId, f.principal.id, "oauth_subject")).toBe(true);
    expect(isCurrentNativeOAuthGrantFor({...tuple}, peer, f.workspaceId, f.principal.id, "oauth_subject")).toBe(false);
    expect(readCurrentNativeOAuthGrant({...f.principal}, f.workspaceId, owner)).toBeUndefined();
  });
  it.each(["copied journal","constructed journal","foreign owning handle"] as const)("native OAuth origin refuses %s", async change => {
    const journal = await agentJournal();
    if (change === "copied journal") expect(isDefaultPgAgentJournal({...journal})).toBe(false);
    if (change === "constructed journal") expect(isDefaultPgAgentJournal(new PgAgentJournal({client:pgAuthorityClient()}))).toBe(false);
    if (change === "foreign owning handle") {
      const target = new URL(url!); target.username = `${target.username}.foreignRealm`;
      const foreign = await openPlatformDb({kind:"postgres",url:target.toString(),max:1});
      try { expect(isDefaultPgAgentJournalFor(journal, foreign)).toBe(false); } finally { await foreign.close(); }
    }
  });
  it.each(["journal method","journal accessor","journal client getter","journal checked getter","journal cache replaced","journal prototype","native selector getter","runtime selector getter","runtime selector setter","client method","boolean parser"] as const)("native OAuth provenance refuses %s with zero hostile getter effects", async change => {
    const f=await seed(), journal=await agentJournal(); await currentIntegrationGrant(f.principal,f.workspaceId);
    let getters=0, setters=0; const client=pgAuthorityClient(), prototype=Object.getPrototypeOf(journal);
    if(change==="journal prototype") {
      Object.setPrototypeOf(journal,{}); try { expect(isDefaultPgAgentJournal(journal)).toBe(false); expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeUndefined(); }
      finally {Object.setPrototypeOf(journal,prototype);} return;
    }
    const target=change.includes("selector")?globalThis:(change.startsWith("journal client")||change.startsWith("journal checked")||change==="journal cache replaced")?journal:change.startsWith("journal")?prototype:change==="boolean parser"?client.options.parsers:client;
    const key=change.startsWith("native selector")?"__zenithAgentPgJournal":change.startsWith("runtime selector")?"__zenithAgentJournal":change==="journal client getter"?"client":change==="journal checked getter"||change==="journal cache replaced"?"checked":change.startsWith("journal")?"grants":change==="boolean parser"?"16":"unsafe";
    const accessor=change.includes("getter")||change.includes("accessor")||change.includes("setter");
    const restore=restoreProperty(target,key,accessor?{get:()=>{getters++;return journal;},set:()=>{setters++;}}:{value:change==="journal cache replaced"?Promise.resolve():async()=>[],writable:true});
    try { expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeUndefined();
      if(change==="journal cache replaced"||change==="journal checked getter")await expect(pgAgentJournal().ready()).rejects.toMatchObject({code:"grant_unavailable"});
      expect(getters).toBe(0); expect(setters).toBe(0); }
    finally {restore();}
    expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeDefined();
  });
  it.each(["getter","setter","foreign value"] as const)("runtime lazy journal selection refuses an awaited %s replacement", async change => {
    let getters=0,setters=0; const pending=agentJournal();
    const restore=restoreProperty(globalThis,"__zenithAgentJournal",change==="foreign value"?{value:{},writable:true}:{get:()=>{getters++;return undefined;},set:()=>{setters++;}});
    try { await expect(pending).rejects.toMatchObject({code:"grant_unavailable"}); expect(getters).toBe(0); expect(setters).toBe(0); }
    finally {restore();}
    expect(isDefaultAgentJournalSelection(await agentJournal())).toBe(true);
  });
  it.each(["revoked","expired","foreign workspace","foreign subject"] as const)("a known linked OAuth-shaped %s identity never falls back to its live OAuth row", async change => {
    const f=await seed();
    await owner.query(`insert into agent.agent_credentials(id,token_hash,subject,workspace_id,project_ids,scopes,client_name,issued_at,expires_at,created_by,revoked_at)
      values($1,$2,$3,$4,$5::text::jsonb,'["read","plan","write"]'::jsonb,'explicit collision fixture',$6,$7,'oauth_subject',$8)`,
      [f.principal.id,digest(randomUUID()),change==="foreign subject"?"foreign":"oauth_subject",change==="foreign workspace"?"foreign":f.workspaceId,json([f.projectId]),
        new Date(Date.now()-1000).toISOString(),new Date(Date.now()+(change==="expired"?-1000:120000)).toISOString(),change==="revoked"?new Date().toISOString():null]);
    await expect(currentIntegrationGrant(f.principal,f.workspaceId)).rejects.toMatchObject({code:"current_integration_grant_unconfirmed"});
    expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeUndefined();
  });
  it.each(["issuer","jwks","client claim","subject claim","origin"] as const)("native OAuth tuple provenance refuses changed configured %s", async change => {
    const f=await seed(); await currentIntegrationGrant(f.principal,f.workspaceId);
    const key=change==="issuer"?"ZENITH_AGENT_OAUTH_ISSUER":change==="jwks"?"ZENITH_AGENT_OAUTH_JWKS":change==="client claim"?"ZENITH_AGENT_OAUTH_CLIENT_CLAIM":change==="subject claim"?"ZENITH_AGENT_OAUTH_SUBJECT_CLAIM":"ZENITH_AGENT_ORIGIN";
    const before=process.env[key]!;vi.stubEnv(key,change==="client claim"?"azp":change==="subject claim"?"user_id":"https://changed.example.test");
    expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeUndefined();vi.stubEnv(key,before);
    expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeDefined();
  });
  it.each(["null","empty","nonempty"] as const)("native OAuth product provenance preserves exact %s app metadata", async shape => {
    const f=await seed(shape==="null"?null:shape==="empty"?[]:["app_owned"]); await currentIntegrationGrant(f.principal,f.workspaceId);
    const tuple=readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner);
    if(shape==="nonempty")expect(tuple).toBeUndefined();else expect(tuple?.app_ids).toEqual(shape==="null"?null:[]);
  });
  it("native OAuth provenance refuses default target drift and restores the genuine current target", async () => {
    const f=await seed(); await currentIntegrationGrant(f.principal,f.workspaceId);
    const target=new URL(url!);target.username=`${target.username}.otherRealm`;vi.stubEnv("SUPABASE_DB_URL",target.toString());
    expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeUndefined();vi.stubEnv("SUPABASE_DB_URL",url!);
    expect(readCurrentNativeOAuthGrant(f.principal,f.workspaceId,owner)).toBeDefined();
  });
  it("default native OAuth readiness refuses an owning scratch database without agent migration three", async () => {
    const name=`zo_origin_${randomUUID().replaceAll('-', '')}`, target=new URL(url!);target.pathname=`/${name}`;
    let createdDatabase=false;
    try {
      await owner.exec(`create database "${name}"`);createdDatabase=true;
      await closePgAuthorityClient();forget();vi.stubEnv("SUPABASE_DB_URL",target.toString());
      const principal:Principal={kind:"integration",id:`integration_${randomUUID()}`,name:"Unavailable native OAuth fixture",onBehalfOf:"oauth_subject"};principal.integrationId=principal.id;
      const journal=await agentJournal();expect(isDefaultPgAgentJournal(journal)).toBe(true);
      await expect(readDefaultNativeOAuthGrant(journal,principal,"workspace")).rejects.toMatchObject({code:"grant_unavailable"});
    } finally {
      await closePgAuthorityClient();forget();vi.stubEnv("SUPABASE_DB_URL",url!);
      if(createdDatabase)await owner.exec(`drop database "${name}"`);
    }
  });

  it.each(["unknown identity","foreign subject","foreign workspace","expired grant","revoked grant","wrong issuer","malformed issuer"] as const)("current native OAuth read refuses %s without dispatch provenance", async change => {
    const f=await seed();let principal=f.principal,workspace=f.workspaceId;
    if(change==="unknown identity") {principal={...principal,id:`integration_${randomUUID()}`};principal.integrationId=principal.id;}
    if(change==="foreign subject")principal={...principal,onBehalfOf:"foreign"};
    if(change==="foreign workspace")workspace="foreign";
    if(change==="expired grant")await peer.query("update agent.agent_oauth_grants set expires_at=$2 where integration_id=$1",[principal.id,new Date(Date.now()-1000).toISOString()]);
    if(change==="revoked grant")await peer.query("update agent.agent_oauth_grants set revoked=true where integration_id=$1",[principal.id]);
    if(change==="wrong issuer"||change==="malformed issuer")await peer.query("update agent.agent_oauth_grants set oauth_issuer=$2 where integration_id=$1",[principal.id,change==="wrong issuer"?"https://foreign.example.test":"https://untrusted@issuer.example.test"]);
    const result=await currentIntegrationGrant(principal,workspace).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    expect(result.value).toBeFalsy();expect(readCurrentNativeOAuthGrant(principal,workspace,owner)).toBeUndefined();
    if(["foreign subject","foreign workspace","wrong issuer","malformed issuer"].includes(change))expect(result.error).toMatchObject({code:"current_integration_grant_unconfirmed"});
  });

  it.each(["before selection","during lazy import"] as const)("default runtime journal refuses client selector getters %s with zero effects", async window => {
    let getters=0,setters=0;let pending:Promise<unknown>|undefined;
    if(window==="during lazy import")pending=agentJournal();
    const restore=restoreProperty(globalThis,"__zenithHostedPg",{get:()=>{getters++;return undefined;},set:()=>{setters++;}});
    try {await expect(pending??agentJournal()).rejects.toMatchObject({code:"grant_unavailable"});expect(getters).toBe(0);expect(setters).toBe(0);}
    finally {restore();}
    expect(isDefaultAgentJournalSelection(await agentJournal())).toBe(true);
  });

  it.each(["ready accessor","ready method","grants accessor","grants method","getGrant accessor","getGrant method"] as const)("default OAuth preselection refuses canonical journal %s with zero callbacks", async change => {
    const f = await seed();
    const key = change.startsWith("ready") ? "ready" : change.startsWith("grants") ? "grants" : "getGrant";
    let getters = 0, setters = 0, callbacks = 0;
    const hostile = async () => { callbacks++; return []; };
    const restore = restoreProperty(PgAgentJournal.prototype, key, change.endsWith("accessor")
      ? { get: () => { getters++; return hostile; }, set: () => { setters++; } }
      : { value: hostile, writable: true });
    try {
      let directError: unknown;
      try { pgAgentJournal(); } catch (error) { directError = error; }
      expect(directError).toMatchObject({ code: "grant_unavailable" });
      await expect(agentJournal()).rejects.toMatchObject({ code: "grant_unavailable" });
      expect(Object.getOwnPropertyDescriptor(globalThis, "__zenithAgentPgJournal")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(globalThis, "__zenithAgentJournal")).toBeUndefined();
      expect(getters).toBe(0); expect(setters).toBe(0); expect(callbacks).toBe(0);
    } finally { restore(); forget(); }
    const journal = await agentJournal();
    expect(isDefaultAgentJournalSelection(journal)).toBe(true);
    expect(isDefaultPgAgentJournalFor(journal, owner)).toBe(true);
    expect((await readDefaultNativeOAuthGrant(journal, f.principal, f.workspaceId))?.integration_id).toBe(f.principal.id);
    expect(await currentIntegrationGrant(f.principal, f.workspaceId)).toEqual({ scopes: ["read", "plan", "write"], projectIds: [f.projectId], environmentIds: [f.environmentId] });
  });

  it("default OAuth preselection refuses a changed canonical journal prototype parent with zero callbacks", async () => {
    const f = await seed(), prototype = PgAgentJournal.prototype, before = Object.getPrototypeOf(prototype);
    let callbacks = 0;
    Object.setPrototypeOf(prototype, { ready: async () => { callbacks++; } });
    try {
      await expect(agentJournal()).rejects.toMatchObject({ code: "grant_unavailable" });
      expect(Object.getOwnPropertyDescriptor(globalThis, "__zenithAgentPgJournal")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(globalThis, "__zenithAgentJournal")).toBeUndefined();
      expect(callbacks).toBe(0);
    } finally { Object.setPrototypeOf(prototype, before); forget(); }
    const journal = await agentJournal();
    expect(isDefaultPgAgentJournalFor(journal, owner)).toBe(true);
    expect((await readDefaultNativeOAuthGrant(journal, f.principal, f.workspaceId))?.integration_id).toBe(f.principal.id);
  });

  it("default OAuth preselection refuses an extra canonical journal method with zero callbacks", async () => {
    const f = await seed();
    let callbacks = 0;
    const restore = restoreProperty(PgAgentJournal.prototype, "unreviewedMethod", { value: () => { callbacks++; }, writable: true });
    try {
      await expect(agentJournal()).rejects.toMatchObject({ code: "grant_unavailable" });
      expect(Object.getOwnPropertyDescriptor(globalThis, "__zenithAgentPgJournal")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(globalThis, "__zenithAgentJournal")).toBeUndefined();
      expect(callbacks).toBe(0);
    } finally { restore(); forget(); }
    const journal = await agentJournal();
    expect(isDefaultPgAgentJournalFor(journal, owner)).toBe(true);
    expect((await readDefaultNativeOAuthGrant(journal, f.principal, f.workspaceId))?.integration_id).toBe(f.principal.id);
  });

});
