/** Unit composition/startup contracts. Tool/SQL/engine boundaries are explicit mocks; no durability evidence. */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
const f=vi.hoisted(()=>({identity:vi.fn(),schema:vi.fn(),canonical:vi.fn(),dispatch:vi.fn(),finish:vi.fn(),claim:vi.fn(),requiresProduct:vi.fn(),topology:vi.fn(),provenance:vi.fn(),row:undefined as unknown}));
vi.mock("@/lib/controlplane/db",()=>({
  platformDb:vi.fn(),assertPlatformSchemaCurrent:f.schema,MIGRATE_COMMAND:"npm run platform:migrate",
  platformDbConfigFromEnv:(env:Record<string,string|undefined>)=>({kind:env.ZENITH_PLATFORM_DB==="pglite"?"pglite":"postgres",source:env.ZENITH_PLATFORM_DB||env.ZENITH_PLATFORM_DB_URL?"explicit":"default"}),
}));
vi.mock("@/lib/credentials/signing",()=>({getControlSigner:async()=>({ready:async()=>undefined})}));
vi.mock("@/lib/tofu/runner",()=>({MAX_PLAN_BYTES:16*1024*1024,TofuCommandError:class extends Error {},TofuRun:class {},TofuRunner:class {identity=f.identity;}}));
vi.mock("@/lib/platform/broker",()=>({createExecutionBroker:f.canonical,isDefaultCurrentDispatchRequirement:f.provenance}));
vi.mock("@/lib/controlplane/db/repos/workflow-start-deploy-authority",()=>({assertDefaultMcpProductTopology:f.topology}));
vi.mock("@/lib/controlplane/db/repos/plan-artifacts",()=>({
  PlanArtifactError:class extends Error {constructor(){super("Reviewed plan artifact is unavailable; a new review is required.");}},
  claim:f.claim,dispatch:f.dispatch,finish:f.finish,read:async()=>f.row,requiresProductComposition:f.requiresProduct,
}));
vi.mock("@/lib/tofu/engine",()=>({planWorkspace:vi.fn(),applyVerifiedPlan:vi.fn(),createPlanEngineAuthority:(_cipher:unknown,resolve:(handle:unknown)=>{dispatch:()=>Promise<void>}|undefined)=>({
  codec:{withDecoded:async(manifest:unknown,_sealed:unknown,fn:(manifest:unknown,bytes:Buffer)=>Promise<unknown>)=>fn(manifest,Buffer.from("explicit-unit-fixture"))},
  tofu:{applyVerifiedPlan:async(_ws:unknown,args:{original:unknown;beforeDispatch?:()=>Promise<void>})=>{
    await args.beforeDispatch?.();const admission=resolve(args.original);if(!admission)throw new Error("Missing private admission.");await admission.dispatch();return {apply:{exitCode:0}};
  }},
})}));
import { validateExecutionConfiguration, openExecutionStore } from "../../workers/execution/startup";
import { createPlanArtifactRuntime, createIsolatedPlanArtifactRuntimeForTests } from "@/lib/platform/plan-artifacts";

const key=()=>randomBytes(32).toString("hex");
const env=()=>({ZENITH_TEMPORAL_ADDRESS:"fixture:7233",ZENITH_PLATFORM_DB:"postgres",ZENITH_PLATFORM_DB_URL:"postgresql://fixture/database",ZENITH_SECRET_KEY:key(),ZENITH_PLAN_ARTIFACT_KEY:key()});
beforeEach(()=>{vi.clearAllMocks();f.identity.mockResolvedValue({version:"1.12.5",platform:"linux_arm64",sha256:"a".repeat(64),archiveSha256:"b".repeat(64)});f.schema.mockResolvedValue(undefined);f.requiresProduct.mockResolvedValue(true);f.topology.mockResolvedValue(undefined);f.provenance.mockResolvedValue(true);f.finish.mockResolvedValue(undefined);});
describe("durable artifact startup and canonical dispatch wiring [unit]",()=>{
  it("refuses implicit/PGlite stores, absent/shared/invalid artifact keys and absent executable distribution identity before polling",async()=>{
    for(const override of [{ZENITH_PLATFORM_DB:undefined,ZENITH_PLATFORM_DB_URL:undefined},{ZENITH_PLATFORM_DB:"pglite"},{ZENITH_PLAN_ARTIFACT_KEY:undefined},{ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS:"malformed"}])
      await expect(validateExecutionConfiguration({...env(),...override})).rejects.toThrow();
    const shared=env();shared.ZENITH_PLAN_ARTIFACT_KEY=shared.ZENITH_SECRET_KEY;
    await expect(validateExecutionConfiguration(shared)).rejects.toThrow("dedicated");
    f.identity.mockResolvedValue({archiveSha256:null});await expect(validateExecutionConfiguration(env())).rejects.toThrow("identity");
    f.identity.mockRejectedValue(new Error("private diagnostics"));await expect(validateExecutionConfiguration(env())).rejects.toThrow("identity");
  });
  it("requires current schema on PostgreSQL before returning the worker store",async()=>{
    const db={kind:"postgres"} as unknown as Sql;
    expect(await openExecutionStore(async()=>db)).toBe(db);expect(f.schema).toHaveBeenCalledWith(db);
    await expect(openExecutionStore(async()=>({kind:"pglite"} as unknown as Sql))).rejects.toThrow("PostgreSQL");
    f.schema.mockRejectedValue(new Error("private schema detail"));await expect(openExecutionStore(async()=>db)).rejects.toThrow("schema");
  });
  it("default production custody obtains its broker itself and caller hooks cannot supply or replace private proof",async()=>{
    const db={kind:"postgres"} as unknown as Sql;
    const custody={workspaceId:"ws",operationId:"op",projectId:"project",environmentId:"environment",proposalDigest:"a".repeat(64),inputDigest:"b".repeat(64),sourceDigest:"c".repeat(64),graphDigest:"d".repeat(64),expiresAt:"2099-01-01T00:00:00.000Z"};
    const planDigest="e".repeat(64);const proof={approvalIds:["canonical-human"],requiredApprovalCount:1,approvalRound:1,proposalDigest:custody.proposalDigest,planDigest};
    const approvalStatus=vi.fn(async()=>({approved:true,rejected:false,dispatchApproval:proof}));f.canonical.mockReturnValue({approvalStatus});
    f.row={manifest:{...custody,planDigest}};f.claim.mockResolvedValue(f.row);
    const runtime=createPlanArtifactRuntime(db,env());expect(runtime.planArtifacts.kind).toBe("postgres");expect(f.canonical).toHaveBeenCalledExactlyOnceWith(db);
    const lease={scope:"env:environment",holder:"worker:test:op",fenceToken:1};
    const hook=vi.fn(async()=>undefined);
    await runtime.planArtifacts.consume({custody,planDigest,lease},original=>runtime.tofu.applyVerifiedPlan({} as never,{original,custody,approvedDigest:planDigest,beforeDispatch:hook}));
    expect(hook).toHaveBeenCalledOnce();expect(approvalStatus).toHaveBeenCalledExactlyOnceWith("op");
    expect(f.dispatch.mock.calls[0][3]).toEqual(proof);expect(f.dispatch.mock.calls[0][3]).toBe(proof);expect(f.finish.mock.calls[0][3]).toBe(true);
    expect(f.requiresProduct).toHaveBeenCalledExactlyOnceWith(db,f.row,"op",expect.any(String));
    expect(f.topology).toHaveBeenCalledExactlyOnceWith(db);
    expect(f.provenance).toHaveBeenCalledExactlyOnceWith(proof,db,"ws","op");
    expect(f.claim.mock.invocationCallOrder[0]).toBeLessThan(f.requiresProduct.mock.invocationCallOrder[0]);
    expect(f.requiresProduct.mock.invocationCallOrder[0]).toBeLessThan(f.topology.mock.invocationCallOrder[0]);
    expect(f.topology.mock.invocationCallOrder[0]).toBeLessThan(hook.mock.invocationCallOrder[0]);
    expect(hook.mock.invocationCallOrder[0]).toBeLessThan(approvalStatus.mock.invocationCallOrder[0]);
    expect(approvalStatus.mock.invocationCallOrder[0]).toBeLessThan(f.provenance.mock.invocationCallOrder[0]);
    expect(f.provenance.mock.invocationCallOrder[0]).toBeLessThan(f.dispatch.mock.invocationCallOrder[0]);
    expect(f.dispatch.mock.invocationCallOrder[0]).toBeLessThan(f.finish.mock.invocationCallOrder[0]);
  });
  it("refuses unproven canonical authority even when a caller hook reports success",async()=>{
    f.canonical.mockReturnValue({approvalStatus:async()=>({approved:true,rejected:false})});f.claim.mockResolvedValue({manifest:{operationId:"op"}});
    const runtime=createPlanArtifactRuntime({kind:"postgres"} as unknown as Sql,env());
    await expect(runtime.planArtifacts.consume({custody:{operationId:"op"} as never,planDigest:"a".repeat(64),lease:{scope:"env:env",holder:"worker:x:op",fenceToken:1}},original=>runtime.tofu.applyVerifiedPlan({} as never,{original,approvedDigest:"a".repeat(64),beforeDispatch:async()=>undefined}))).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
    const isolated=createIsolatedPlanArtifactRuntimeForTests({kind:"postgres"} as unknown as Sql,env(),{approvalStatus:async()=>({approved:false,rejected:true})});expect(isolated.planArtifacts.kind).toBe("isolated-test");
  });
  it.each(["product origin", "owning topology", "private requirement"] as const)("refuses modeled %s admission before repository dispatch and finishes the claimed attempt",async boundary=>{
    const db={kind:"postgres"} as unknown as Sql;
    const custody={workspaceId:"ws",operationId:"op",projectId:"project",environmentId:"environment",proposalDigest:"a".repeat(64),inputDigest:"b".repeat(64),sourceDigest:"c".repeat(64),graphDigest:"d".repeat(64),expiresAt:"2099-01-01T00:00:00.000Z"};
    const planDigest="e".repeat(64),proof={approvalIds:["canonical-human"],requiredApprovalCount:1,approvalRound:1,proposalDigest:custody.proposalDigest,planDigest};
    const approvalStatus=vi.fn(async()=>({approved:true,rejected:false,dispatchApproval:proof}));f.canonical.mockReturnValue({approvalStatus});
    f.row={manifest:{...custody,planDigest}};f.claim.mockResolvedValue(f.row);
    if(boundary==="product origin")f.requiresProduct.mockResolvedValue(false);
    else if(boundary==="owning topology")f.topology.mockRejectedValue(new Error("Explicit unit topology refusal."));
    else f.provenance.mockResolvedValue(false);
    const runtime=createPlanArtifactRuntime(db,env()),hook=vi.fn(async()=>undefined);
    await expect(runtime.planArtifacts.consume({custody,planDigest,lease:{scope:"env:environment",holder:"worker:test:op",fenceToken:1}},original=>runtime.tofu.applyVerifiedPlan({} as never,{original,custody,approvedDigest:planDigest,beforeDispatch:hook}))).rejects.toThrow();
    expect(f.claim).toHaveBeenCalledOnce();expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledOnce();expect(f.finish.mock.calls[0][3]).toBe(false);
    if(boundary==="product origin"){expect(f.topology).not.toHaveBeenCalled();expect(hook).not.toHaveBeenCalled();expect(approvalStatus).not.toHaveBeenCalled();expect(f.provenance).not.toHaveBeenCalled();}
    else if(boundary==="owning topology"){expect(f.topology).toHaveBeenCalledExactlyOnceWith(db);expect(hook).not.toHaveBeenCalled();expect(approvalStatus).not.toHaveBeenCalled();expect(f.provenance).not.toHaveBeenCalled();}
    else {expect(hook).toHaveBeenCalledOnce();expect(approvalStatus).toHaveBeenCalledExactlyOnceWith("op");expect(f.provenance).toHaveBeenCalledExactlyOnceWith(proof,db,"ws","op");}
  });
});
