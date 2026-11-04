/** Actual native policy/approval records; scope, current roles and policy answers are explicit models. */
import { randomBytes, createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import { createExecutionBroker, readCurrentDispatchRequirement, isDefaultCurrentDispatchRequirement } from "@/lib/platform/broker";
import { createPlanArtifactRuntime, planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import { createOperationsPort, executionHolder } from "@/lib/execution/platform";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import { normalizePlan } from "@/lib/tofu/plan";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { stableJson } from "@/lib/tofu/stable";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { PG_URL, closeSharedPgliteAfterAll, makeHarness, scriptedEngine, requireApproval, user, sessionFor } from "../capabilities/support";
if (process.env.ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED === "1" && !PG_URL) throw new Error("Current dispatch requirement requires owned PostgreSQL.");
closeSharedPgliteAfterAll();
const peers: PlatformDbHandle[]=[];
afterAll(async()=>{for(const peer of peers)await peer.close();});
async function fixture() {
  const h=await makeHarness({kind:"postgres",engine:scriptedEngine("current-dispatch-policy",()=>requireApproval(1,"admin",true))});
  const db=h.db!;h.deps.clock={now:()=>new Date()};
  const proposed=(await h.broker.propose({capability:"deployment.deploy",scope:{workspaceId:h.ids.wsA,projectId:h.ids.projA,environmentId:h.ids.envAProd},input:{}},user("alice"))).operation;
  const op=await repos.operations.get(db,h.ids.wsA,proposed.id);if(!op)throw new Error("Native operation is missing.");
  await h.broker.approve({workspaceId:op.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,approver:user("erin"),session:sessionFor("erin")});
  const lease=await repos.leases.acquire(db,{workspaceId:op.workspaceId,scope:`env:${op.environmentId}`,holder:`worker:${op.id}`,ttlMs:120000});
  if(!lease)throw new Error("Native lease is missing.");
  await h.broker.beginExecution({workspaceId:op.workspaceId,operationId:op.id,holder:executionHolder(op.id),audience:"worker",lease,leaseMs:120000});
  const plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},{configDigest:digest("fixture config"),lockDigest:digest("fixture lock"),addressMap:{}});
  const facts=extractPlanFacts(plan),summary=planEvidence({plan,facts,cost:{},graphDigest:digest("fixture graph"),stage:"plan"}).summary;
  await repos.evidence.insert(db,{workspaceId:op.workspaceId,operationId:op.id,kind:"tofu_plan",digest:plan.planDigest,summary,simulated:false});
  const worker=createExecutionBroker(db,async()=>h.broker),ports=createOperationsPort(db);
  await ports.setPlanDigest({workspaceId:op.workspaceId,operationId:op.id,planDigest:plan.planDigest});
  const decision=await worker.reevaluate(op.id,facts);await ports.setPolicyDecision({workspaceId:op.workspaceId,operationId:op.id,decisionId:decision.decisionId});
  await ports.transition({workspaceId:op.workspaceId,operationId:op.id,to:"awaiting_approval"});
  await h.broker.approve({workspaceId:op.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,planDigest:plan.planDigest,approver:user("erin"),session:sessionFor("erin")});
  await repos.operations.claimForExecution(db,{workspaceId:op.workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:120000,lease,expectedPolicyVersion:"current-dispatch-policy"});
  return {h,db,op,worker,lease,plan,summary};
}
describe.skipIf(!PG_URL)("current evaluated dispatch requirement [postgres; modeled policy and directory]",()=>{
  it("exact factory snapshot binds deeply immutable evaluated requirement and native approval records",async()=>{
    const f=await fixture(),status=await f.worker.approvalStatus(f.op.id);expect(status.approved).toBe(true);
    const value=await readCurrentDispatchRequirement(status.dispatchApproval,f.db,f.op.workspaceId,f.op.id);
    expect(value?.requirement).toEqual({count:1,minRole:"admin",separationOfDuties:true});expect(value?.approvals).toHaveLength(1);
    expect(value?.policy.inputDigest).toBe(digest(value?.policy.input));expect(Object.isFrozen(value)).toBe(true);expect(Object.isFrozen(value?.policy.input)).toBe(true);
    expect(Object.isFrozen(value?.approvals[0])).toBe(true);expect(await isDefaultCurrentDispatchRequirement(status.dispatchApproval,f.db,f.op.workspaceId,f.op.id)).toBe(false);
  });
  it.each(["copied snapshot","forged snapshot","foreign workspace","foreign operation","different owning pool"] as const)("private requirement refuses %s",async change=>{
    const f=await fixture(),status=await f.worker.approvalStatus(f.op.id);let snapshot:unknown=status.dispatchApproval,sql=f.db,ws=f.op.workspaceId,op=f.op.id;
    if(change==="copied snapshot")snapshot={...status.dispatchApproval};
    if(change==="forged snapshot")snapshot={approvalIds:[],requiredApprovalCount:0,approvalRound:1,proposalDigest:f.op.proposalDigest,planDigest:f.plan.planDigest};
    if(change==="foreign workspace")ws=f.h.ids.wsB;if(change==="foreign operation")op="foreign-operation";
    if(change==="different owning pool"){sql=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});peers.push(sql);}
    expect(await readCurrentDispatchRequirement(snapshot,sql,ws,op)).toBeUndefined();
  });
  it("changed current policy version refuses an earlier genuine same-attempt snapshot",async()=>{
    const f=await fixture(),status=await f.worker.approvalStatus(f.op.id);
    f.h.deps.policy=async()=>scriptedEngine("replacement-policy",()=>requireApproval(1,"admin",true));
    expect(await readCurrentDispatchRequirement(status.dispatchApproval,f.db,f.op.workspaceId,f.op.id)).toBeUndefined();
  });
  it("inconsistent evaluated input digest supplies no private dispatch authority",async()=>{
    const f=await fixture(),engine=scriptedEngine("current-dispatch-policy",()=>requireApproval(1,"admin",true));
    f.h.deps.policy=async()=>({...engine,evaluate:async input=>({...await engine.evaluate(input),inputDigest:digest("foreign input")})});
    const status=await f.worker.approvalStatus(f.op.id);expect(status.approved).toBe(true);
    expect(await readCurrentDispatchRequirement(status.dispatchApproval,f.db,f.op.workspaceId,f.op.id)).toBeUndefined();
  });
  it("default paired runtime refuses unproven native absence before callback or provider dispatch",async()=>{
    const f=await fixture(),key=randomBytes(32).toString("hex"),payload="synthetic source-free native original";
    const custody={workspaceId:f.op.workspaceId,projectId:f.op.projectId!,environmentId:f.op.environmentId!,operationId:f.op.id,proposalDigest:f.op.proposalDigest,inputDigest:f.op.inputDigest,sourceDigest:digest("fixture source"),graphDigest:digest("fixture graph"),expiresAt:f.op.expiresAt};
    const manifest:PlanArtifactManifest={...custody,format:"zenith.plan-artifact.v1",purpose:"deploy",planDigest:f.plan.planDigest,configDigest:f.plan.configDigest,lockDigest:f.plan.lockDigest,backendDigest:digest("fixture backend"),addressMapDigest:digest("fixture addresses"),rawSha256:createHash("sha256").update(payload).digest("hex"),bytes:Buffer.byteLength(payload),executable:{version:"fixture",platform:"fixture",sha256:digest("fixture binary"),archiveSha256:null}};
    const sealed=planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:key}).seal(f.op.workspaceId,`zenith.tofu.plan-artifact.v1:${createHash("sha256").update(stableJson(manifest)).digest("hex")}`,Buffer.from(payload).toString("base64"));
    await artifacts.publish(f.db,{manifest,sealed,lease:f.lease,evidence:{workspaceId:f.op.workspaceId,operationId:f.op.id,kind:"tofu_plan",digest:f.plan.planDigest,summary:f.summary,simulated:false}});
    let callbacks=0;const runtime=createPlanArtifactRuntime(f.db,{ZENITH_PLAN_ARTIFACT_KEY:key});
    await expect(runtime.planArtifacts.consume({custody,planDigest:f.plan.planDigest,lease:f.lease},async()=>{callbacks++;})).rejects.toMatchObject({code:"plan_artifact_unavailable"});
    expect(callbacks).toBe(0);expect(await f.db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[f.op.workspaceId,f.op.id])).toEqual([{phase:"ready"}]);
  });
});
