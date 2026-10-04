/** Actual PostgreSQL owner/claim/connection/evidence, native credential broker and inspector; IAM/STS and human/product ports are modeled. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, IAMClient, type Role } from "@aws-sdk/client-iam";
import { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION, type PlatformDbHandle } from "@/lib/controlplane/db";
import { platformCredentialBroker, readNativeAwsBootstrapReadiness } from "@/lib/platform/credentials";
import { composeExecutionActivities } from "@/lib/platform/execution";
import { createLeasesPort } from "@/lib/execution/platform";
import { StepFailedError } from "@/lib/execution/errors";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { AWS_ROLE_BOUNDARIES, awsBootstrapContextForConnection, resolveAwsRoleBoundaries, type AwsRoleFamily } from "@/lib/credentials/aws/naming";
import { CredentialDeniedError, type AwsConnectionConfig, type CredentialBroker } from "@/lib/credentials/types";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { loadTemplate, makeEvaluator, resolveResource } from "../credentials/cfn";
import { TEMPLATE_PATH } from "../../deploy/aws/tools/generate-tofu-policies";
import { approve, newWorkspace, PG_URL, seedAwaitingApproval, user } from "../controlplane/_support/harness";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import { createWorld } from "../execution/fakes/world";

if (process.env.ZENITH_TEST_AWS_PREFLIGHT_REQUIRED === "1") {
  if (!PG_URL) throw new Error("AWS bootstrap readiness acceptance requires owned PostgreSQL.");
  if (PLATFORM_SCHEMA_VERSION < 13) throw new Error("AWS bootstrap readiness requires canonical schema13.");
}
const FAMILIES=["app","build","machine","scheduler","eksCluster","eksNode"] as const;
const CONFIG:AwsConnectionConfig={provider:"aws",mode:"aws_assume_role",accountId:"123456789012",region:"us-east-1",bootstrapNameSuffix:"-team-a",
  observeRoleArn:"arn:aws:iam::123456789012:role/ZenithObserveRole-team-a",deployRoleArn:"arn:aws:iam::123456789012:role/ZenithDeployRole-team-a",
  stateBucket:"zenith-state-123456789012-us-east-1",externalId:"zenith-owned-readiness-fixture"};
const iam=mockClient(IAMClient),sts=mockClient(STSClient);
const boundaries=resolveAwsRoleBoundaries(awsBootstrapContextForConnection(CONFIG));
const legacy="arn:aws:iam::123456789012:policy/ZenithWorkloadBoundary-team-a";
const metadata=(arn:string)=>({Arn:arn,PolicyName:arn.slice(arn.lastIndexOf("/")+1),Path:"/",PolicyId:"ANPA12345678901234567",IsAttachable:true,DefaultVersionId:"v3"});
function modelPolicies() {
  const template=loadTemplate(TEMPLATE_PATH);
  const evaluator=makeEvaluator(template,{params:{NameSuffix:CONFIG.bootstrapNameSuffix!},pseudo:{partition:"aws",accountId:CONFIG.accountId,region:CONFIG.region},
    resourceOverrides:{StateBucket:{ref:CONFIG.stateBucket!,attrs:{Arn:`arn:aws:s3:::${CONFIG.stateBucket}`}}}});
  for(const family of FAMILIES) {
    const arn=boundaries[family],doc=resolveResource(template,evaluator,AWS_ROLE_BOUNDARIES[family].logicalId)?.PolicyDocument;
    iam.on(GetPolicyCommand,{PolicyArn:arn}).resolves({Policy:metadata(arn)});
    iam.on(GetPolicyVersionCommand,{PolicyArn:arn,VersionId:"v3"}).resolves({PolicyVersion:{VersionId:"v3",IsDefaultVersion:true,Document:encodeURIComponent(JSON.stringify(doc))}});
  }
  iam.on(GetPolicyCommand,{PolicyArn:legacy}).resolves({Policy:metadata(legacy)});
}
const stsOutput=()=>({Credentials:{AccessKeyId:"ASIAREADBACKCANARY000",SecretAccessKey:"readiness-session-key-canary",SessionToken:"readiness-session-token-canary",
  Expiration:new Date(Date.now()+900_000)}});

describe.skipIf(!PG_URL)("native AWS bootstrap readiness admission [postgres]",()=>{
  let db:PlatformDbHandle,peer:PlatformDbHandle;
  beforeAll(async()=>{db=await openPlatformDb({kind:"postgres",url:PG_URL!,migrate:true,max:1});peer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});},60_000);
  beforeEach(()=>{iam.reset();sts.reset();modelPolicies();sts.on(AssumeRoleCommand).resolves(stsOutput());});
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
  afterAll(async()=>{iam.restore();sts.restore();await peer?.close();await db?.close();});
  async function fixture() {
    const workspaceId=newWorkspace(),projectId=`proj_${randomUUID()}`,environmentId=`env-${randomUUID()}`;
    const seeded=await seedAwaitingApproval(db,{workspaceId,minRole:"admin",separationOfDuties:true,
      proposal:{capability:"deployment.deploy",scope:{workspaceId,projectId,environmentId}}});
    await approve(db,seeded,user(),{role:"admin"});
    const op=await repos.operations.claimForExecution(db,{workspaceId,id:seeded.operation.id,expectedDigest:seeded.operation.proposalDigest,
      holder:`workflow:${seeded.operation.id}`,leaseMs:120_000,expectedPolicyVersion:seeded.decision.policyVersion});
    const lease=await createLeasesPort(db).acquire({workspaceId,scope:`env:${environmentId}`,holder:`worker:readiness-fixture:${op.id}`,ttlMs:120_000,
      operation:{id:op.id,proposalDigest:op.proposalDigest}});
    if(!lease)throw new Error("Native fixture lease was not acquired.");
    const connection=await repos.connections.create(db,{workspaceId,config:CONFIG,createdBy:"modeled-human"});
    await repos.connections.recordVerification(db,{workspaceId,id:connection.id,ok:true,detail:"Modeled identity fixture, no live IAM proof."});
    await registerEnvironment(db,{environment:{workspaceId,projectId,environmentId,class:"development",provider:"aws",region:CONFIG.region,
      connection:{id:connection.id,status:"verified"}}});
    const broker=platformCredentialBroker(db);
    async function issue(capability="infrastructure.observe") {
      const iat=Math.floor(Date.now()/1000),claims:CapabilityGrantClaims={jti:randomUUID(),iss:"modeled-signing-fixture",aud:"worker",sub:"modeled-human",
        iat,exp:iat+60,cap:capability,op:op.id,digest:op.proposalDigest,ws:workspaceId,proj:projectId,env:environmentId,fence:lease!.fenceToken};
      await repos.grants.insert(db,{jti:claims.jti,workspaceId,operationId:op.id,capability,audience:"worker",issuedAt:new Date(iat*1000).toISOString(),expiresAt:new Date(claims.exp*1000).toISOString()});
      return claims;
    }
    const grant=await issue();
    const read=(owner:CredentialBroker=broker,claims=grant,connectionId=connection.id)=>readNativeAwsBootstrapReadiness(owner,{connectionId,grant:claims});
    return {workspaceId,projectId,environmentId,op,lease,connection,broker,grant,issue,read};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  async function role(f:Fixture,family:AwsRoleFamily="app",status:"active"|"deleted"="active") {
    const arn=`arn:aws:iam::${CONFIG.accountId}:role/zenith-${f.environmentId}${AWS_ROLE_BOUNDARIES[family].suffixes[0]}`;
    const node=mkNode(`identity/${family}`,"identity","aws:iam_role",{trust:{service:"ecs-tasks.amazonaws.com"}},{region:CONFIG.region,specDigest:digest({family})});
    const row=await repos.resources.upsertDesired(db,{workspaceId:f.workspaceId,projectId:f.projectId,environmentId:f.environmentId,node,status});
    await repos.observations.appendObservation(db,{workspaceId:f.workspaceId,resourceId:row.id,observation:{address:row.address,presence:"present",externalId:arn,
      attributes:{},observedAt:new Date().toISOString(),source:"aws.iam_role@1",simulated:false}});
    const reply:Role={Arn:arn,RoleName:arn.slice(arn.lastIndexOf("/")+1),Path:"/",RoleId:"AROA12345678901234567",CreateDate:new Date(),
      Tags:[{Key:"zenith:managed",Value:"true"},{Key:"zenith:workspace",Value:f.workspaceId},{Key:"zenith:environment",Value:f.environmentId}],
      PermissionsBoundary:{PermissionsBoundaryType:"PermissionsBoundaryPolicy",PermissionsBoundaryArn:boundaries[family]}};
    iam.on(GetRoleCommand,{RoleName:reply.RoleName}).resolves({Role:reply});
    return {row,arn,reply};
  }
  const evidence=(f:Fixture)=>peer.query<{summary:Record<string,unknown>}>("select summary from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='observation'",[f.workspaceId,f.op.id]);
  async function noRead(f:Fixture,body:()=>Promise<unknown>=()=>f.read()) {
    await expect(body()).rejects.toBeInstanceOf(StepFailedError);
    expect(sts.calls()).toHaveLength(0);expect(iam.calls()).toHaveLength(0);expect(await evidence(f)).toEqual([]);
  }
  it("uses native owners and a dedicated exact seven-policy observe session while retaining incomplete child-role coverage",async()=>{
    const f=await fixture(),out=await f.read();
    expect(out).toMatchObject({status:"incomplete",readbackStatus:"readback_compatible",roleCoverage:"incomplete",declaredRoleRows:0,inspectedRoleRows:0,unresolvedRoleRows:0});
    expect(iam.commandCalls(GetPolicyCommand)).toHaveLength(13);expect(iam.commandCalls(GetPolicyVersionCommand)).toHaveLength(6);expect(iam.commandCalls(GetRoleCommand)).toHaveLength(0);
    const input=sts.commandCalls(AssumeRoleCommand)[0].args[0].input;
    expect(input.RoleArn).toBe(CONFIG.observeRoleArn);
    expect(JSON.parse(input.Policy!)).toEqual({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["iam:GetPolicy","iam:GetPolicyVersion"],Resource:[...FAMILIES.map(family=>boundaries[family]),legacy]}]});
    expect(input.Policy!.length).toBeLessThanOrEqual(2048);expect(input.Policy).not.toContain("*");
    const stored=await evidence(f);expect(stored).toHaveLength(1);expect(stored[0].summary).toMatchObject({stage:"aws_bootstrap_readiness",authorization:"unverified",migration:"not_performed",roleCoverage:"incomplete"});
    for(const value of ["readiness-session-key-canary","readiness-session-token-canary",CONFIG.accountId,"Statement","Document"])
      expect(JSON.stringify([out,stored])).not.toContain(value);
  });
  it("inspects an exact current observed role but keeps legacy migration explicit without write admission",async()=>{
    const f=await fixture(),r=await role(f);
    iam.on(GetRoleCommand,{RoleName:r.reply.RoleName}).resolves({Role:{...r.reply,PermissionsBoundary:{PermissionsBoundaryType:"PermissionsBoundaryPolicy",PermissionsBoundaryArn:legacy}}});
    expect(await f.read()).toMatchObject({status:"migration_required",roleCoverage:"incomplete",declaredRoleRows:1,inspectedRoleRows:1});
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(1);
    expect(sts.commandCalls(AssumeRoleCommand).every(call=>call.args[0].input.RoleArn===CONFIG.observeRoleArn)).toBe(true);
  });
  it("preserves a conflicting cloud boundary as an explicit operator result",async()=>{
    const f=await fixture();
    iam.on(GetPolicyCommand,{PolicyArn:boundaries.app}).resolves({Policy:{...metadata(boundaries.app),Arn:legacy}});
    expect(await f.read()).toMatchObject({status:"conflict",readbackStatus:"conflict",roleCoverage:"incomplete",code:"policy_identity"});
    expect((await evidence(f))[0].summary).toMatchObject({status:"conflict",authorization:"unverified",migration:"not_performed"});
  });
  it.each(["app","build","machine","scheduler","eksCluster","eksNode"] as const)("keeps %s compiler-parent inventory explicitly incomplete without inventing child role ARNs",async family=>{
    const f=await fixture();
    const nativeTypes={app:"aws:ecs_service",build:"aws:codebuild_project",machine:"aws:ec2_instance",scheduler:"aws:ecs_scheduled_task",eksCluster:"aws:eks_cluster",eksNode:"aws:eks_cluster"};
    await repos.resources.upsertDesired(db,{workspaceId:f.workspaceId,projectId:f.projectId,environmentId:f.environmentId,
      node:mkNode(`provider_native/${family}`,"provider_native",nativeTypes[family],{},{region:CONFIG.region,specDigest:digest(family)})});
    expect(await f.read()).toMatchObject({status:"incomplete",declaredRoleRows:0,inspectedRoleRows:0,roleCoverage:"incomplete"});
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(0);
  });
  it.each(["unknown","simulated","error","stale","contradictory","deleted","unobserved"] as const)("keeps %s native role provenance unresolved without using older success or guessing absence",async kind=>{
    const f=await fixture(),r=await role(f,"app",kind==="deleted"?"deleted":"active");
    if(kind==="unobserved") {
      await peer.query("delete from platform.resource_observations where workspace_id=$1 and resource_id=$2",[f.workspaceId,r.row.id]);
      await repos.resources.setStatus(peer,f.workspaceId,r.row.id,"planned");
    }
    else if(kind==="stale")await peer.query("update platform.resource_observations set observed_at=clock_timestamp()-interval '16 minutes' where workspace_id=$1 and resource_id=$2",[f.workspaceId,r.row.id]);
    else if(kind==="contradictory")await peer.query("update platform.resources set external_id='contradictory-native-id' where workspace_id=$1 and id=$2",[f.workspaceId,r.row.id]);
    else if(kind!=="deleted")await repos.observations.appendObservation(peer,{workspaceId:f.workspaceId,resourceId:r.row.id,
      observation:{address:r.row.address,presence:kind==="unknown"?"unknown":"present",externalId:r.arn,attributes:{},observedAt:new Date().toISOString(),source:"aws.iam_role@1",simulated:kind==="simulated",...(kind==="error"?{error:"Modeled read error."}:{})}});
    expect(await f.read()).toMatchObject({status:"incomplete",roleCoverage:"incomplete",declaredRoleRows:1,inspectedRoleRows:0,unresolvedRoleRows:1});
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(0);
  });
  it("refuses an unknown credential owner and a structurally labeled SQL owner before SDK calls",async()=>{
    const f=await fixture(),query=vi.fn(async()=>[]);
    const fake=platformCredentialBroker({query,tx:async body=>body({query,tx:async()=>{throw new Error("unused");}})});
    await noRead(f,()=>f.read(fake));expect(query).not.toHaveBeenCalled();
  });
  it("refuses a replaced registered credential callback before SDK calls",async()=>{
    const f=await fixture();f.broker.withSession=vi.fn();await noRead(f);
  });
  it("refuses a closed native owner and a genuine unsupported PGlite owner before SDK calls",async()=>{
    const f=await fixture(),closed=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});
    const owner=platformCredentialBroker(closed);await closed.close();await noRead(f,()=>f.read(owner));
    const local=await openPlatformDb({kind:"pglite"});
    try {await noRead(f,()=>f.read(platformCredentialBroker(local)));}finally{await local.close();}
  });
  it.each(["cancelled","uncertain","MCP holder","expired claim","expired lease","changed digest","revoked grant","foreign grant"] as const)("refuses %s native authority before SDK calls",async kind=>{
    const f=await fixture();
    if(kind==="expired lease")await peer.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and scope=$2",[f.workspaceId,f.lease.scope]);
    else if(kind==="revoked grant")await repos.grants.revoke(peer,f.workspaceId,f.grant.jti);
    else if(kind==="foreign grant"){await noRead(f,()=>f.read(f.broker,{...f.grant,ws:newWorkspace()}));return;}
    else if(kind==="changed digest"){await noRead(f,()=>f.read(f.broker,{...f.grant,digest:digest("changed")}));return;}
    else {
      const fields:Record<string,string>={cancelled:"status='cancelled'",uncertain:"status='uncertain'","MCP holder":"lease_holder='mcp:fixture'","expired claim":"lease_until=clock_timestamp()-interval '1 second'"};
      await peer.query(`update platform.operations set ${fields[kind]} where workspace_id=$1 and id=$2`,[f.workspaceId,f.op.id]);
    }
    await noRead(f);
  });
  it("refuses a verified same-workspace connection outside the exact native environment mapping",async()=>{
    const f=await fixture(),other=await repos.connections.create(db,{workspaceId:f.workspaceId,config:CONFIG,createdBy:"modeled-human"});
    await repos.connections.recordVerification(db,{workspaceId:f.workspaceId,id:other.id,ok:true});
    await noRead(f,()=>f.read(f.broker,f.grant,other.id));
  });
  it("refuses connection revocation committed during federation before the first inspector command",async()=>{
    const f=await fixture();sts.on(AssumeRoleCommand).callsFake(async()=>{await repos.connections.revoke(peer,f.workspaceId,f.connection.id);return stsOutput();});
    await expect(f.read()).rejects.toBeInstanceOf(StepFailedError);expect(iam.calls()).toHaveLength(0);expect(await evidence(f)).toEqual([]);
  });
  it("refuses credential callback replacement committed during federation before the first inspector command",async()=>{
    const f=await fixture();sts.on(AssumeRoleCommand).callsFake(async()=>{f.broker.withSession=vi.fn();return stsOutput();});
    await expect(f.read()).rejects.toBeInstanceOf(StepFailedError);expect(iam.calls()).toHaveLength(0);expect(await evidence(f)).toEqual([]);
  });
  it("refuses native method replacement committed during federation before the first inspector command",async()=>{
    const f=await fixture(),original=db.query;
    sts.on(AssumeRoleCommand).callsFake(async()=>{db.query=vi.fn();return stsOutput();});
    // The real broker refuses its required audit before invoking the inspector.
    const pending=f.read();
    try {
      await expect(pending).rejects.toBeInstanceOf(CredentialDeniedError);
      await expect(pending).rejects.toMatchObject({reason:"audit_failed",message:"The credential could not be recorded, so it was not issued."});
      expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);expect(iam.calls()).toHaveLength(0);
    } finally{db.query=original;}
    expect(await evidence(f)).toEqual([]);
  });
  it.each(["resource removal","resource addition","observation replacement","connection mapping"] as const)("refuses %s during readback without persisting a compatible result",async kind=>{
    const f=await fixture(),r=await role(f);let changed=false;
    iam.on(GetPolicyCommand,{PolicyArn:legacy}).callsFake(async()=>{
      if(!changed){changed=true;
        if(kind==="resource removal")await peer.query("delete from platform.resources where workspace_id=$1 and id=$2",[f.workspaceId,r.row.id]);
        else if(kind==="resource addition")await repos.resources.upsertDesired(peer,{workspaceId:f.workspaceId,projectId:f.projectId,environmentId:f.environmentId,
          node:mkNode("identity/new","identity","aws:iam_role",{trust:{service:"ecs-tasks.amazonaws.com"}},{region:CONFIG.region,specDigest:digest("new")})});
        else if(kind==="connection mapping")await peer.query("update platform.reconcile_state set connection_id=null where workspace_id=$1 and environment_id=$2",[f.workspaceId,f.environmentId]);
        else await repos.observations.appendObservation(peer,{workspaceId:f.workspaceId,resourceId:r.row.id,observation:{address:r.row.address,presence:"unknown",attributes:{},observedAt:new Date().toISOString(),source:"aws.iam_role@1",simulated:false}});
      }return {Policy:metadata(legacy)};
    });
    await expect(f.read()).rejects.toBeInstanceOf(StepFailedError);expect(await evidence(f)).toEqual([]);
  });
  it("default observation composition preserves drift results and records supplemental incomplete readiness with default credentials",async()=>{
    const f=await fixture(),world=createWorld();
    try {
      Object.assign(world.product.base.workspace,{id:f.workspaceId});Object.assign(world.product.base.project,{id:f.projectId});
      Object.assign(world.product.base.environment,{id:f.environmentId,connectionId:f.connection.id,provider:"aws",region:CONFIG.region});
      world.product.setManifest({version:1,services:[],resources:[],routes:[],bindings:[]});
      world.product.loadContext=async input=>{
        expect(input).toMatchObject({workspaceId:f.workspaceId,environmentId:f.environmentId});
        return {...structuredClone(world.product.base),revision:world.product.revisions.values().next().value!};
      };
      const issueGrant=vi.fn(async(_id:string,_aud:string,_fence:unknown,options?:{capability?:string})=>({jws:"modeled-signature",claims:await f.issue(options?.capability)}));
      // Product lookup and grant signing/roles are modeled; store, original
      // observer, default credential owner and inspector are the actual paths.
      const activities=composeExecutionActivities({db,workerIdentity:"readiness-fixture",planDir:world.planDir,secretKey:"1".repeat(64),
        ports:{product:world.product,broker:{issueGrant,reevaluate:world.broker.reevaluate.bind(world.broker),approvalStatus:world.broker.approvalStatus.bind(world.broker)}}});
      expect(await activities.observeEnvironment({operationId:f.op.id})).toEqual({drift:0,unknown:0});
      expect(issueGrant).toHaveBeenCalledWith(f.op.id,"worker",{scope:f.lease.scope,fenceToken:f.lease.fenceToken},{capability:"infrastructure.observe",durationSec:60});
      expect((await evidence(f)).some(row=>row.summary.stage==="aws_bootstrap_readiness"&&row.summary.status==="incomplete")).toBe(true);
      expect(sts.commandCalls(AssumeRoleCommand).every(call=>call.args[0].input.RoleArn===CONFIG.observeRoleArn)).toBe(true);
    } finally {world.dispose();}
  });
  it("default observation composition retains observed results when supplemental native readiness is unavailable",async()=>{
    const f=await fixture(),world=createWorld();let exchanges=0;
    try {
      Object.assign(world.product.base.workspace,{id:f.workspaceId});Object.assign(world.product.base.project,{id:f.projectId});
      Object.assign(world.product.base.environment,{id:f.environmentId,connectionId:f.connection.id,provider:"aws",region:CONFIG.region});
      world.product.setManifest({version:1,services:[],resources:[],routes:[],bindings:[]});
      world.product.loadContext=async input=>{expect(input).toMatchObject({workspaceId:f.workspaceId,environmentId:f.environmentId});
        return {...structuredClone(world.product.base),revision:world.product.revisions.values().next().value!};};
      const issueGrant=async(_id:string,_aud:string,_fence:unknown,options?:{capability?:string})=>({jws:"modeled-signature",claims:await f.issue(options?.capability)});
      sts.on(AssumeRoleCommand).callsFake(async()=>{if(++exchanges===2)await repos.connections.revoke(peer,f.workspaceId,f.connection.id);return stsOutput();});
      const activities=composeExecutionActivities({db,workerIdentity:"readiness-fixture",planDir:world.planDir,secretKey:"1".repeat(64),
        ports:{product:world.product,broker:{issueGrant,reevaluate:world.broker.reevaluate.bind(world.broker),approvalStatus:world.broker.approvalStatus.bind(world.broker)}}});
      expect(await activities.observeEnvironment({operationId:f.op.id})).toEqual({drift:0,unknown:0});
      expect(iam.calls()).toHaveLength(0);
      expect((await evidence(f)).some(row=>row.summary.stage==="aws_bootstrap_readiness"&&row.summary.status==="unavailable")).toBe(true);
    }finally{world.dispose();}
  });
});
