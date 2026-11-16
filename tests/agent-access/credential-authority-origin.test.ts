/** Native PostgreSQL/default factories. No bearer issuance, REST, effective permissions or cloud proof. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, isOpenedPlatformDbHandle, json, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Principal } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import { pgAuthorityClient, createPgAuthorityClient, closePgAuthorityClient, isDefaultPgAuthorityClient, isDefaultPgAuthorityClientFor } from "@/lib/hosted/authority/pg/client";
import { pgCredentialAuthority, PgCredentialAuthority, isDefaultPgCredentialAuthority, isDefaultPgCredentialAuthorityFor, readDefaultNativeLinkedCredential } from "@/lib/agent-access/authority/pg";
import { currentIntegrationGrant, readCurrentNativeLinkedCredential, isCurrentNativeLinkedCredentialFor } from "@/lib/capabilities/current-integration-grants";
const url = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim();
const required = process.env.ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED === "1";
const explicitPort=()=>{try{return !!url&&!!new URL(url).port;}catch{return false;}};
if (required && (!explicitPort() || PLATFORM_SCHEMA_VERSION < 13)) throw new Error("Native linked credential authority requires owned PostgreSQL with explicit port.");
const globals = ["__zenithPgCredentialAuthority", "__zenithHostedPg"] as const;
function clearAuthority() { Reflect.deleteProperty(globalThis, globals[0]); }
function descriptor(value: object, key: PropertyKey, replacement: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(value, key);
  Object.defineProperty(value, key, { configurable: true, ...replacement });
  return () => { if (original) Object.defineProperty(value, key, original); else Reflect.deleteProperty(value, key); };
}
async function seed(owner: PlatformDbHandle) {
  const id = `cred_${randomUUID()}`, workspaceId = `ws_${randomUUID()}`, projectId = `proj_${randomUUID()}`, environmentId = `env_${randomUUID()}`;
  const principal: Principal = { kind: "integration", id, name: "Native credential origin fixture", integrationId: id, onBehalfOf: "subject" };
  const issued = new Date(Date.now() - 1000).toISOString(), expires = new Date(Date.now() + 120000).toISOString();
  await owner.query(`insert into agent.agent_credentials(id,token_hash,subject,workspace_id,project_ids,environment_ids,scopes,client_name,issued_at,expires_at,created_by)
    values($1,$2,'subject',$3,$4::text::jsonb,$5::text::jsonb,'["read","plan","write"]'::jsonb,'explicit SQL fixture',$6,$7,'subject')`,
    [id, digest(randomUUID()), workspaceId, json([projectId]), json([environmentId]), issued, expires]);
  return { principal, workspaceId, projectId, environmentId };
}
describe.skipIf(!url)("native linked credential factory origin [postgres]", () => {
  let owner: PlatformDbHandle, peer: PlatformDbHandle;
  beforeAll(async () => {
    owner = await openPlatformDb({ kind: "postgres", url: url!, migrate: true, max: 1 });
    peer = await openPlatformDb({ kind: "postgres", url: url!, max: 1 });
    await owner.exec("create schema if not exists agent");
    const migration = readFileSync(new URL("../../supabase/migrations/0006_agent_link.sql", import.meta.url), "utf8");
    for (const table of ["schema_migrations", "agent_credentials"]) {
      const ddl = new RegExp(`create table if not exists agent\\.${table} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];
      if (!ddl) throw new Error("Canonical linked credential DDL is unavailable.");
      await owner.exec(ddl);
    }
    await owner.query("insert into agent.schema_migrations(version,name,applied_at) values(1,'agent-link-v1','2026-01-01T00:00:00.000Z') on conflict do nothing");
  }, 60000);
  beforeEach(async () => { await closePgAuthorityClient(); clearAuthority(); vi.stubEnv("SUPABASE_DB_URL", url!); vi.stubEnv("ZENITH_STORE", "postgres"); });
  afterEach(async () => { await closePgAuthorityClient(); clearAuthority(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => { await peer?.close(); await owner?.close(); });
  it("actual cached native client and linked authority prove the same owning opening target", async () => {
    const client = pgAuthorityClient(), authority = pgCredentialAuthority(); await authority.ready();
    expect(isDefaultPgAuthorityClientFor(client, owner)).toBe(true); expect(isDefaultPgAuthorityClientFor(client, peer)).toBe(true);
    expect(isDefaultPgCredentialAuthorityFor(authority, owner)).toBe(true);
    const f = await seed(owner), read = await readDefaultNativeLinkedCredential(authority, f.principal, f.workspaceId);
    expect(read.present).toBe(true); expect(Object.keys(read.tuple!).sort()).toEqual(["id","subject","workspace_id","project_ids","environment_ids","scopes","issued_at","expires_at","revoked_at"].sort());
    expect(await currentIntegrationGrant(f.principal, f.workspaceId)).toEqual({ scopes: ["read","plan","write"], projectIds: [f.projectId], environmentIds: [f.environmentId] });
    const tuple = readCurrentNativeLinkedCredential(f.principal, f.workspaceId, owner)!;
    expect(Object.isFrozen(tuple)).toBe(true); expect(isCurrentNativeLinkedCredentialFor(tuple, owner, f.workspaceId, f.principal.id, "subject")).toBe(true);
    expect(isCurrentNativeLinkedCredentialFor({ ...tuple }, owner, f.workspaceId, f.principal.id, "subject")).toBe(false);
    expect(readCurrentNativeLinkedCredential({ ...f.principal }, f.workspaceId, owner)).toBeUndefined();
  });
  it.each(["copied authority", "constructed authority", "copied client", "tooling client"] as const)("native factory origin refuses %s", async change => {
    const client = pgAuthorityClient(), authority = pgCredentialAuthority();
    if (change === "copied authority") expect(isDefaultPgCredentialAuthority({ ...authority })).toBe(false);
    if (change === "constructed authority") expect(isDefaultPgCredentialAuthority(new PgCredentialAuthority(() => client))).toBe(false);
    if (change === "copied client") expect(isDefaultPgAuthorityClient({ ...client })).toBe(false);
    if (change === "tooling client") { const supplied = createPgAuthorityClient(url!); try { expect(isDefaultPgAuthorityClient(supplied)).toBe(false); } finally { await supplied.end(); } }
  });
  it.each(["authority method", "authority accessor", "authority selector accessor", "client method", "client selector accessor", "client startup", "text parser", "text serializer"] as const)("native provenance refuses %s without evaluating hostile getters", async change => {
    const client = pgAuthorityClient(), authority = pgCredentialAuthority(); await authority.ready(); let getters = 0;
    const method = Object.getPrototypeOf(authority);
    const target = change.startsWith("authority selector") || change.startsWith("client selector") ? globalThis
      : change.startsWith("authority") ? method : change === "client startup" ? client.options.connection
      : change === "text parser" ? client.options.parsers : change === "text serializer" ? client.options.serializers : client;
    const key = change.startsWith("authority selector") ? globals[0] : change.startsWith("client selector") ? globals[1]
      : change.startsWith("authority") ? "ready" : change === "client startup" ? "user" : change.startsWith("text") ? "25" : "unsafe";
    const restore = descriptor(target, key, change.includes("accessor") ? { get: () => { getters++; throw new Error("Hostile getter must remain unevaluated."); } } : { value: () => undefined, writable: true });
    try { expect(isDefaultPgCredentialAuthorityFor(authority, owner)).toBe(false); expect(getters).toBe(0); }
    finally { restore(); }
    expect(isDefaultPgCredentialAuthorityFor(authority, owner)).toBe(true);
  });
  it.each(["cached config replacement", "shared pooler username", "database replacement", "missing explicit port", "startup user", "startup database", "unknown startup option"] as const)("current authority target refuses %s", async change => {
    const client = pgAuthorityClient(), authority = pgCredentialAuthority(), foreign = new URL(url!);
    if (change === "cached config replacement") foreign.hostname = "unreachable.invalid";
    if (change === "shared pooler username") foreign.username = `${foreign.username}.otherRealm`;
    if (change === "database replacement") foreign.pathname = "/other_database";
    if (change === "missing explicit port") foreign.port = "";
    if (change.startsWith("startup")) foreign.searchParams.set(change === "startup user" ? "user" : "database", "otherRealm");
    if (change === "unknown startup option") foreign.searchParams.set("options", "other-target");
    vi.stubEnv("SUPABASE_DB_URL", foreign.toString()); expect(isDefaultPgAuthorityClientFor(client, owner)).toBe(false); expect(isDefaultPgCredentialAuthorityFor(authority, owner)).toBe(false);
  });
  it("separate genuine owning database target and closed genuine native client refuse", async () => {
    const client = pgAuthorityClient(), authority = pgCredentialAuthority(), foreign = new URL(url!); foreign.pathname = "/other_database";
    const other = await openPlatformDb({ kind: "postgres", url: foreign.toString(), max: 1 });
    try { expect(isDefaultPgCredentialAuthorityFor(authority, other)).toBe(false); } finally { await other.close(); }
    await client.end(); expect(isDefaultPgCredentialAuthorityFor(authority, owner)).toBe(false);
  });
  it.each(["revoked", "expired", "future issued", "foreign subject", "foreign workspace", "missing identity", "duplicate scope", "malformed scope"] as const)("current native linked directory refuses %s without alternate authority fallback", async change => {
    const f = await seed(owner);
    if (change === "revoked") await peer.query("update agent.agent_credentials set revoked_at=$2 where id=$1", [f.principal.id, new Date().toISOString()]);
    if (change === "expired") await peer.query("update agent.agent_credentials set expires_at=$2 where id=$1", [f.principal.id, new Date(Date.now()-1000).toISOString()]);
    if (change === "future issued") await peer.query("update agent.agent_credentials set issued_at=$2 where id=$1", [f.principal.id, new Date(Date.now()+100000).toISOString()]);
    if (change === "foreign subject") await peer.query("update agent.agent_credentials set subject='other' where id=$1", [f.principal.id]);
    if (change === "foreign workspace") await peer.query("update agent.agent_credentials set workspace_id='foreign' where id=$1", [f.principal.id]);
    if (change === "missing identity") await peer.query("delete from agent.agent_credentials where id=$1", [f.principal.id]);
    if (change === "duplicate scope") await peer.query("update agent.agent_credentials set scopes='[\"read\",\"read\"]'::jsonb where id=$1", [f.principal.id]);
    if (change === "malformed scope") await peer.query("update agent.agent_credentials set scopes='[1]'::jsonb where id=$1", [f.principal.id]);
    if (["duplicate scope", "malformed scope"].includes(change)) await expect(currentIntegrationGrant(f.principal, f.workspaceId)).rejects.toMatchObject({ code: "current_integration_grant_unconfirmed" });
    else expect(await currentIntegrationGrant(f.principal, f.workspaceId)).toBeNull();
    expect(readCurrentNativeLinkedCredential(f.principal, f.workspaceId, owner)).toBeUndefined();
  });
  it("missing native linked schema version fails closed with sanitized diagnostics", async () => {
    const f=await seed(owner);await peer.query("delete from agent.schema_migrations where version=1");
    try { await expect(currentIntegrationGrant(f.principal,f.workspaceId)).rejects.toMatchObject({message:"The current integration grant could not be confirmed."});expect(readCurrentNativeLinkedCredential(f.principal,f.workspaceId,owner)).toBeUndefined(); }
    finally { await peer.query("insert into agent.schema_migrations(version,name,applied_at) values(1,'agent-link-v1','2026-01-01T00:00:00.000Z') on conflict do nothing"); }
  });
  it("current file selector cannot revive a previously captured native grant", async () => {
    const f=await seed(owner);await currentIntegrationGrant(f.principal,f.workspaceId);const tuple=readCurrentNativeLinkedCredential(f.principal,f.workspaceId,owner)!;expect(tuple).toBeDefined();
    vi.stubEnv("ZENITH_STORE","file");expect(readCurrentNativeLinkedCredential(f.principal,f.workspaceId,owner)).toBeUndefined();expect(isCurrentNativeLinkedCredentialFor(tuple,owner,f.workspaceId,f.principal.id,"subject")).toBe(false);
  });

  it("genuine owning handle accessor replacement refuses native credential provenance without getter effects", async () => {
    const authority=pgCredentialAuthority();await authority.ready();
    const saved=Object.getOwnPropertyDescriptor(owner,"kind")!;let getters=0;
    Object.defineProperty(owner,"kind",{get:()=>{getters++;throw new Error("Hostile owner getter must remain unevaluated.");},configurable:true});
    try { expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false);expect(getters).toBe(0); }
    finally { Object.defineProperty(owner,"kind",saved); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
  });

  it.each(["kind","identity","query","tx","exec","close"] as const)("private opener refuses branded handle %s accessor with zero getter calls", async field => {
    const saved=Object.getOwnPropertyDescriptor(owner,field)!;let getters=0;
    Object.defineProperty(owner,field,{get:()=>{getters++;throw new Error("Hostile opened handle getter must remain unevaluated.");},configurable:true});
    try { expect(isOpenedPlatformDbHandle(owner,"postgres")).toBe(false);expect(isOpenedPlatformDbHandle(Object.create(Object.getPrototypeOf(owner),Object.getOwnPropertyDescriptors(owner)),"postgres")).toBe(false);expect(getters).toBe(0); }
    finally { Object.defineProperty(owner,field,saved); }
    expect(isOpenedPlatformDbHandle(owner,"postgres")).toBe(true);
  });

  it("boolean parser replacement cannot hide a foreign native OAuth identity or reach journal fallback", async () => {
    const client=pgAuthorityClient(),authority=pgCredentialAuthority();await authority.ready();
    const oauth=await import("@/lib/agent-access/control/oauth");
    const fallback=vi.spyOn(oauth,"oauthConfig").mockReturnValue(undefined);
    vi.stubEnv("ZENITH_AGENT_ORIGIN","https://zenith.acceptance.invalid");
    const f=await seed(owner),integrationId=`integration_${randomUUID()}`;
    const principal:Principal={kind:"integration",id:integrationId,name:"Native collision origin fixture",integrationId,onBehalfOf:"subject"};
    // Establish that this exact real directory can reach the observed fallback
    // for true native absence before introducing a foreign native collision.
    expect(await currentIntegrationGrant(principal,f.workspaceId)).toBeNull();expect(fallback).toHaveBeenCalledTimes(1);fallback.mockClear();
    await peer.query("update agent.agent_credentials set id=$2,subject='foreign_subject',workspace_id='foreign_workspace' where id=$1",[f.principal.id,integrationId]);
    expect(await readDefaultNativeLinkedCredential(authority,principal,f.workspaceId)).toEqual({present:true});
    const restore=descriptor(client.options.parsers,"16",{value:()=>false,writable:true});
    try {
      // The locked SDK really uses this parser for the EXISTS result. The
      // production provenance guard must refuse before trusting that result.
      const observed=await client<{present:boolean}[]>`select exists(select 1 from agent.agent_credentials where id=${integrationId}) as present`;
      expect(observed).toEqual([{present:false}]);
      expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false);
      await expect(currentIntegrationGrant(principal,f.workspaceId)).rejects.toMatchObject({code:"current_integration_grant_unconfirmed"});
      expect(readCurrentNativeLinkedCredential(principal,f.workspaceId,owner)).toBeUndefined();expect(fallback).not.toHaveBeenCalled();
    } finally { restore(); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
    expect(await readDefaultNativeLinkedCredential(authority,principal,f.workspaceId)).toEqual({present:true});
    await expect(currentIntegrationGrant(principal,f.workspaceId)).rejects.toMatchObject({code:"current_integration_grant_unconfirmed"});
    expect(fallback).not.toHaveBeenCalled();
  });

  it("boolean serializer replacement refuses genuine native client provenance and restores exactly", async () => {
    const client=pgAuthorityClient(),authority=pgCredentialAuthority();await authority.ready();
    const restore=descriptor(client.options.serializers,"16",{value:()=>"f",writable:true});
    try { expect(isDefaultPgAuthorityClientFor(client,owner)).toBe(false);expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false); }
    finally { restore(); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
  });

  it.each(["host","port"] as const)("native opening %s array slot accessor refuses without invoking its getter", async field => {
    const client=pgAuthorityClient(),authority=pgCredentialAuthority();await authority.ready();let getters=0;
    const restore=descriptor(client.options[field],"0",{get:()=>{getters++;throw new Error("Hostile opening slot getter must remain unevaluated.");}});
    try { expect(isDefaultPgAuthorityClientFor(client,owner)).toBe(false);expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false);expect(getters).toBe(0); }
    finally { restore(); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
  });

  it.each(["host","port"] as const)("native opening %s array changed target refuses and original target restores", async field => {
    const client=pgAuthorityClient(),authority=pgCredentialAuthority();await authority.ready();
    const restore=descriptor(client.options[field],"0",{value:field==="host"?"unreachable.invalid":1,writable:true,enumerable:true});
    try { expect(isDefaultPgAuthorityClientFor(client,owner)).toBe(false);expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false); }
    finally { restore(); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
  });

  it.each(["host","port"] as const)("native opening %s array replaced prototype refuses without inherited getter effects", async field => {
    const client=pgAuthorityClient(),authority=pgCredentialAuthority();await authority.ready();let getters=0;
    const array=client.options[field],before=Object.getPrototypeOf(array),foreign=Object.create(before);
    Object.defineProperty(foreign,"0",{get:()=>{getters++;throw new Error("Hostile inherited opening getter must remain unevaluated.");}});
    Object.setPrototypeOf(array,foreign);
    try { expect(isDefaultPgAuthorityClientFor(client,owner)).toBe(false);expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false);expect(getters).toBe(0); }
    finally { Object.setPrototypeOf(array,before); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
  });

  it.each(["host","port"] as const)("native opening %s array copied equal target refuses private identity", async field => {
    const client=pgAuthorityClient(),authority=pgCredentialAuthority();await authority.ready();
    const restore=descriptor(client.options,field,{value:[...client.options[field]],writable:true,enumerable:true});
    try { expect(isDefaultPgAuthorityClientFor(client,owner)).toBe(false);expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false); }
    finally { restore(); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
  });

  it.each(["host","port"] as const)("native opening %s array appended target refuses exact descriptor inventory", async field => {
    const client=pgAuthorityClient(),authority=pgCredentialAuthority();await authority.ready();
    const length=Object.getOwnPropertyDescriptor(client.options[field],"length")!;
    const restore=descriptor(client.options[field],"1",{value:field==="host"?"unreachable.invalid":1,writable:true,enumerable:true});
    try { expect(isDefaultPgAuthorityClientFor(client,owner)).toBe(false);expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(false); }
    finally { restore();Object.defineProperty(client.options[field],"length",length); }
    expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
  });

  it.each(["ready method", "ready accessor", "getCredential method", "getCredential accessor", "listCredentials method", "listCredentials accessor"] as const)("pre-selection linked factory refuses %s before registering or invoking callbacks", async change => {
    const f=await seed(owner), prototype=PgCredentialAuthority.prototype, key=change.split(" ")[0];
    let getters=0,callbacks=0;
    const restore=descriptor(prototype,key,change.endsWith("accessor")
      ? {get:()=>{getters++;throw new Error("Hostile pre-selection getter must remain unevaluated.");}}
      : {value:async()=>{callbacks++;return undefined;},writable:true});
    try {
      expect(()=>pgCredentialAuthority()).toThrow("Current native linked credential provenance is unavailable.");
      expect(Object.getOwnPropertyDescriptor(globalThis,globals[0])).toBeUndefined();
      await expect(currentIntegrationGrant(f.principal,f.workspaceId)).rejects.toMatchObject({code:"current_integration_grant_unconfirmed"});
      expect(getters).toBe(0);expect(callbacks).toBe(0);
    } finally {restore();}
    try {
      const authority=pgCredentialAuthority();await authority.ready();
      expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);
      expect((await readDefaultNativeLinkedCredential(authority,f.principal,f.workspaceId)).tuple?.id).toBe(f.principal.id);
      expect(await currentIntegrationGrant(f.principal,f.workspaceId)).toEqual({scopes:["read","plan","write"],projectIds:[f.projectId],environmentIds:[f.environmentId]});
      expect(readCurrentNativeLinkedCredential(f.principal,f.workspaceId,owner)?.id).toBe(f.principal.id);
    } finally {await owner.query("delete from agent.agent_credentials where id=$1",[f.principal.id]);}
  });

  it("pre-selection linked factory refuses a changed canonical prototype parent and restores native authority", async () => {
    const f=await seed(owner),prototype=PgCredentialAuthority.prototype,parent=Object.getPrototypeOf(prototype);let getters=0;
    const foreign=Object.create(parent);
    Object.defineProperty(foreign,"ready",{get:()=>{getters++;throw new Error("Hostile inherited getter must remain unevaluated.");}});
    Object.setPrototypeOf(prototype,foreign);
    try {expect(()=>pgCredentialAuthority()).toThrow("Current native linked credential provenance is unavailable.");expect(Object.getOwnPropertyDescriptor(globalThis,globals[0])).toBeUndefined();expect(getters).toBe(0);}
    finally {Object.setPrototypeOf(prototype,parent);}
    try {const authority=pgCredentialAuthority();await authority.ready();expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);expect((await readDefaultNativeLinkedCredential(authority,f.principal,f.workspaceId)).tuple?.id).toBe(f.principal.id);}
    finally {await owner.query("delete from agent.agent_credentials where id=$1",[f.principal.id]);}
  });

  it.each(["authority selector", "client selector"] as const)("pre-selection linked factory refuses %s accessors with zero getter or setter effects", async change => {
    const f=await seed(owner);let getters=0,setters=0;
    const key=change==="authority selector"?globals[0]:globals[1];
    const restore=descriptor(globalThis,key,{get:()=>{getters++;return undefined;},set:()=>{setters++;}});
    try {expect(()=>pgCredentialAuthority()).toThrow("Current native linked credential provenance is unavailable.");expect(getters).toBe(0);expect(setters).toBe(0);}
    finally {restore();}
    try {const authority=pgCredentialAuthority();await authority.ready();expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);expect((await readDefaultNativeLinkedCredential(authority,f.principal,f.workspaceId)).tuple?.id).toBe(f.principal.id);}
    finally {await owner.query("delete from agent.agent_credentials where id=$1",[f.principal.id]);}
  });

  it("cached linked readiness and native read refuse a client selector getter before calling its factory", async () => {
    const f=await seed(owner),authority=pgCredentialAuthority();await authority.ready();let getters=0;
    const restore=descriptor(globalThis,globals[1],{get:()=>{getters++;throw new Error("Hostile client selector getter must remain unevaluated.");}});
    try {
      await expect(authority.ready()).rejects.toMatchObject({code:"policy_unavailable"});
      await expect(readDefaultNativeLinkedCredential(authority,f.principal,f.workspaceId)).rejects.toMatchObject({code:"policy_unavailable"});
      expect(getters).toBe(0);
    } finally {restore();}
    try {await authority.ready();expect(isDefaultPgCredentialAuthorityFor(authority,owner)).toBe(true);expect((await readDefaultNativeLinkedCredential(authority,f.principal,f.workspaceId)).tuple?.id).toBe(f.principal.id);}
    finally {await owner.query("delete from agent.agent_credentials where id=$1",[f.principal.id]);}
  });

  it("tooling linked constructor retains native readiness without acquiring default factory origin", async () => {
    const client=pgAuthorityClient();let calls=0;const tooling=new PgCredentialAuthority(()=>{calls++;return client;});
    await tooling.ready();expect(calls).toBeGreaterThan(0);expect(isDefaultPgCredentialAuthority(tooling)).toBe(false);
    const before=calls,f=await seed(owner);
    try {await expect(readDefaultNativeLinkedCredential(tooling,f.principal,f.workspaceId)).rejects.toMatchObject({code:"policy_unavailable"});expect(calls).toBe(before);}
    finally {await owner.query("delete from agent.agent_credentials where id=$1",[f.principal.id]);}
  });

});
