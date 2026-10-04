/** Canonical activities with isolated source/product/tool/cloud ports. No live provider evidence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "./fakes/world";
import { builtManifest, OP, CANARY_SECRET } from "./fakes/fixtures";
import { sourceSnapshotSetDigest, immutableSourceSnapshot } from "@/lib/execution/source-snapshot";
import { normalizePlan } from "@/lib/tofu/plan";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { createApprovedSourceSnapshotStore, createIsolatedApprovedSourceStoreForTests } from "@/lib/controlplane/db/repos/approved-source-snapshots";

const worlds:World[]=[];
const world=()=>{const w=createWorld();worlds.push(w);w.product.setManifest(builtManifest());return w;};
afterEach(()=>{while(worlds.length)worlds.pop()!.dispose();vi.unstubAllEnvs();});
async function planned(w:World){const lease=await w.lease();await w.activities.validateDesiredState({operationId:OP});const plan=await w.activities.planInfrastructure({operationId:OP,lease});w.broker.approval={approved:true,rejected:false,approvalId:"isolated-human-review"};return {lease,plan};}

describe("approved executable source semantics [isolated ports]",()=>{
  it("captures before normalized plan and binds the exact native-source set in approval evidence and custody",async()=>{
    const w=world(),{plan}=await planned(w),row=w.evidence.ofKind("tofu_plan")[0];
    const sources=await w.deps.sourceSnapshots!.list({workspaceId:w.product.base.workspace.id,operationId:OP,projectId:w.product.base.project.id,environmentId:w.product.base.environment.id});
    const source=sourceSnapshotSetDigest(sources);
    expect(w.sourceBundle.captures).toHaveLength(1);expect(w.tofu.planCalls[0].opts.normalize?.executableSourceDigest).toBe(source);
    expect(row.digest).toBe(plan.planDigest);expect(row.summary.executableSourceDigest).toBe(source);
    expect(row.summary.view).toMatchObject({executableSourceDigest:source,approvedSources:[{commit:"a".repeat(40),archiveDigest:"5".repeat(64)}]});
    expect(w.tofu.planCalls[0].opts.custody?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(w.stored()).not.toContain(CANARY_SECRET);
  });
  it("a moved branch never changes retained bytes during retry, final plan or build",async()=>{
    const w=world(),{lease,plan}=await planned(w);w.sourceBundle.commit="b".repeat(40);
    await w.activities.planInfrastructure({operationId:OP,lease});await w.activities.finalPlan({operationId:OP,approvedPlanDigest:plan.planDigest,lease});
    await w.activities.buildArtifacts({operationId:OP,lease});expect(w.sourceBundle.captures).toHaveLength(1);
    expect(w.sourceBundle.calls).toHaveLength(1);expect(w.build.started).toHaveLength(1);
  });
  it("two independent activity instances reuse the immutable row after producer loss",async()=>{
    const w=world(),{lease}=await planned(w);
    const {createExecutionActivities}=await import("@/lib/execution/activities");const next=createExecutionActivities(w.deps);
    await next.buildArtifacts({operationId:OP,lease});expect(w.sourceBundle.captures).toHaveLength(1);expect(w.build.started).toHaveLength(1);
  });
  for(const phase of ["final","apply","build"] as const)it(`changed archive refuses before ${phase} cloud effects`,async()=>{
    const w=world(),{lease,plan}=await planned(w);w.sourceBundle.archiveDigest="6".repeat(64);
    const call=phase==="final"?w.activities.finalPlan({operationId:OP,approvedPlanDigest:plan.planDigest,lease}):phase==="apply"?w.activities.applyInfrastructure({operationId:OP,planDigest:plan.planDigest,lease}):w.activities.buildArtifacts({operationId:OP,lease});
    await expect(call).rejects.toThrow();expect(w.tofu.applyCalls).toHaveLength(0);expect(w.sourceBundle.calls).toHaveLength(0);expect(w.build.started).toHaveLength(0);
  });
  it("old unbound build continuation requires a new operation rather than adding source semantics",async()=>{
    const w=world(),lease=await w.lease();const op=w.ops.ops.get(OP)!;w.ops.ops.set(OP,{...op,planDigest:"e".repeat(64)});
    await expect(w.activities.buildArtifacts({operationId:OP,lease})).rejects.toThrow("approved source snapshot");expect(w.sourceBundle.captures).toHaveLength(0);expect(w.build.started).toHaveLength(0);
  });
  it("unreviewed retained source cannot start a build",async()=>{
    const w=world(),lease=await w.lease();await expect(w.activities.buildArtifacts({operationId:OP,lease})).rejects.toThrow("reviewed source-bound plan");expect(w.build.started).toHaveLength(0);
  });
  it("a changed recipe refuses without refreshing the approved row",async()=>{
    const w=world(),{lease}=await planned(w),manifest=builtManifest();manifest.services[0].source={type:"git",repo:"github.com/acme/api",ref:"other",dockerfile:"Dockerfile"};w.product.setManifest(manifest);
    await expect(w.activities.buildArtifacts({operationId:OP,lease})).rejects.toThrow("recipe changed");expect(w.sourceBundle.captures).toHaveLength(1);expect(w.build.started).toHaveLength(0);
  });
  it("current source refusal cannot fall back to anonymous or a second capture",async()=>{
    const w=world(),{lease}=await planned(w);w.sourceBundle.unavailable=true;
    await expect(w.activities.buildArtifacts({operationId:OP,lease})).rejects.toThrow();expect(w.sourceBundle.captures).toHaveLength(1);expect(w.build.started).toHaveLength(0);
  });
  it("source verification runs again after upload and an approval loss prevents StartBuild",async()=>{
    const w=world(),{lease}=await planned(w),prepare=w.sourceBundle.prepare.bind(w.sourceBundle);
    w.sourceBundle.prepare=async(...args)=>{const result=await prepare(...args);w.broker.approval={approved:false,rejected:false};return result;};
    await expect(w.activities.buildArtifacts({operationId:OP,lease})).rejects.toThrow("Current approval changed");expect(w.sourceBundle.calls).toHaveLength(1);expect(w.build.started).toHaveLength(0);
  });
  it("a plan evidence with another source set refuses before provider/tool access",async()=>{
    const w=world(),{lease}=await planned(w);w.evidence.ofKind("tofu_plan")[0].summary.executableSourceDigest="f".repeat(64);
    await expect(w.activities.buildArtifacts({operationId:OP,lease})).rejects.toThrow("does not bind");expect(w.build.started).toHaveLength(0);
  });
  it("nonbuild normalization is byte-for-byte compatible, while source identity changes the approved digest",()=>{
    const json={format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}};
    const opts={configDigest:"c".repeat(64),lockDigest:"d".repeat(64),addressMap:{},now:()=>new Date(0)};
    const old=normalizePlan(json,opts),same=normalizePlan(json,{...opts,executableSourceDigest:undefined});expect(same).toEqual(old);
    const a=normalizePlan(json,{...opts,executableSourceDigest:"a".repeat(64)}),b=normalizePlan(json,{...opts,executableSourceDigest:"b".repeat(64)});
    expect(a.planDigest).not.toBe(old.planDigest);expect(a.planDigest).not.toBe(b.planDigest);expect(a.resourceChanges).toEqual(old.resourceChanges);
  });
  it("default production store rejects model/PGlite before any query and isolated admission checks every invocation",()=>{
    const query=vi.fn(),db={kind:"pglite",query};expect(()=>createApprovedSourceSnapshotStore(db as never)).toThrow();expect(query).not.toHaveBeenCalled();
    const method=vi.fn(),model=createIsolatedApprovedSourceStoreForTests({list:method,retain:method,assertCurrent:method,assertReviewed:method});
    for(const env of ["development","production"]){vi.stubEnv("NODE_ENV",env);expect(()=>createIsolatedApprovedSourceStoreForTests({list:method,retain:method,assertCurrent:method,assertReviewed:method})).toThrow();expect(()=>model.list({} as never)).toThrow();expect(()=>model.retain({} as never,{} as never)).toThrow();expect(()=>model.assertCurrent({} as never)).toThrow();expect(()=>model.assertReviewed({} as never)).toThrow();}expect(method).not.toHaveBeenCalled();
  });
  it("rejects accessor, cycle and excessive depth before hashing source authority",()=>{
    const getter=vi.fn();expect(()=>immutableSourceSnapshot(Object.defineProperty({},"commitSha",{enumerable:true,get:getter}))).toThrow();expect(getter).not.toHaveBeenCalled();
    const cycle:Record<string,unknown>={};cycle.self=cycle;expect(()=>immutableSourceSnapshot(cycle)).toThrow();expect(()=>immutableSourceSnapshot({a:{b:{c:{d:{e:1}}}}})).toThrow();
  });
});
