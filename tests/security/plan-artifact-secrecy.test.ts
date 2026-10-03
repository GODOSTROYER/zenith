/** Real PostgreSQL and pinned OpenTofu read-only custody. Plaintext stays in private callbacks; no cloud calls. */
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import type { ArtifactRow } from "@/lib/controlplane/db/repos/plan-artifacts";
import { digest } from "@/lib/controlplane/digest";
import { executionHolder } from "@/lib/execution/platform";
import { planEvidence, toPlanSummary } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { createPlanArtifactRuntime, planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import { createPlanArtifactCodec, type PlanCustodyInput } from "@/lib/tofu/engine";
import { builtinWorkspace, dataFragment, tofuOnPath } from "../tofu/_helpers";
import { PG_URL, seedApprovedOperation, withScratchDatabase } from "../controlplane/_support/harness";

const sha=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
describe.skipIf(!PG_URL || !tofuOnPath() || process.env.ZENITH_TEST_TOFU_NETWORK!=="1")("encrypted plan artifact secrecy [postgres]",()=>{
  it("sensitive read-only originals persist only ciphertext; key rotation, tenant domains and tampering fail closed",async()=>{
    await withScratchDatabase(async url=>{
      const db=await openPlatformDb({kind:"postgres",url,migrate:true,max:2});
      const temp=await mkdtemp(path.join(os.tmpdir(),"zenith-private-plan-secrecy-"));
      const logs=[vi.spyOn(console,"log").mockImplementation(()=>{}),vi.spyOn(console,"warn").mockImplementation(()=>{}),vi.spyOn(console,"error").mockImplementation(()=>{})];
      try {
        const key=randomBytes(32).toString("hex"), next=randomBytes(32).toString("hex"), vault=randomBytes(32).toString("hex");
        const env={ZENITH_PLAN_ARTIFACT_KEY:key,ZENITH_SECRET_KEY:vault,ZENITH_WORKER_PLAN_DIR:temp};
        const runtime=createPlanArtifactRuntime(db,env);
        const seeded=await seedApprovedOperation(db),op=seeded.operation;
        await repos.operations.claimForExecution(db,{workspaceId:op.workspaceId,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:120000});
        const lease=await repos.leases.acquire(db,{scope:`env:${op.environmentId}`,workspaceId:op.workspaceId,holder:`worker:secrecy:${op.id}`,ttlMs:120000});
        if(!lease)throw new Error("Private fixture lease unavailable.");
        const marker=`private-artifact-marker-${randomBytes(24).toString("hex")}`;
        const expression="${sensitive("+JSON.stringify(marker)+")}";
        const ws=builtinWorkspace(path.join(temp,"state.tfstate"),{"resource/private":dataFragment("private",expression,{output:{private:{value:"${terraform_data.private.output}",sensitive:true}}})});
        const custody:PlanCustodyInput={workspaceId:op.workspaceId,projectId:op.projectId!,environmentId:op.environmentId!,operationId:op.id,proposalDigest:op.proposalDigest,inputDigest:op.inputDigest,expiresAt:op.expiresAt,sourceDigest:digest("source"),graphDigest:digest(ws.addressMap)};
        let inspectedSensitive=false;
        const made=await runtime.tofu.planWorkspace(ws,undefined,{custody,lock:false,normalize:{fingerprintKey:randomBytes(32).toString("hex")},inspectPlan:async(_plan,raw)=>{
          inspectedSensitive=JSON.stringify(raw).includes(marker);
        }});
        expect(inspectedSensitive).toBe(true);
        const evidence=planEvidence({plan:made.plan,facts:extractPlanFacts(made.plan),cost:{},graphDigest:custody.graphDigest,stage:"plan"});
        const publication={produced:made.produced,lease,evidence:{id:`evd_${op.id}`,workspaceId:op.workspaceId,operationId:op.id,kind:"tofu_plan" as const,digest:made.plan.planDigest,summary:evidence.summary,simulated:false}};
        await expect(runtime.planArtifacts.publish({...publication,produced:{manifest:{...made.produced!.manifest}}})).rejects.toThrow();
        await runtime.planArtifacts.publish(publication);
        const access={custody,planDigest:made.plan.planDigest,lease};
        const row=(await db.query<ArtifactRow>("select * from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[op.workspaceId,op.id]))[0];
        const surfaces=JSON.stringify({operation:await repos.operations.get(db,op.workspaceId,op.id),evidence:await repos.evidence.list(db,op.workspaceId,{operationId:op.id}),row,
          activityResult:toPlanSummary(made.plan,extractPlanFacts(made.plan),{}),logs:logs.flatMap(log=>log.mock.calls)});
        expect(surfaces.includes(marker)).toBe(false);
        expect(surfaces.includes(made.planFile.toString("base64"))).toBe(false);
        const codec=createPlanArtifactCodec(planArtifactCipherFromEnv(env));
        await codec.withDecoded(row.manifest,{iv:row.iv,authTag:row.auth_tag,ciphertext:row.ciphertext},async(_manifest,bytes)=>{expect(sha(bytes)).toBe(sha(made.planFile));});
        for(const changed of [{...row.manifest,workspaceId:"foreign"},{...row.manifest,rawSha256:digest("forged")},{...row.manifest,configDigest:digest("changed")}])
          await expect(codec.withDecoded(changed,{iv:row.iv,authTag:row.auth_tag,ciphertext:row.ciphertext},async()=>undefined)).rejects.toThrow();
        await expect(codec.withDecoded(row.manifest,{iv:row.iv,authTag:row.auth_tag,ciphertext:row.ciphertext.slice(0,-4)+"AAAA"},async()=>undefined)).rejects.toThrow();
        const rotated=createPlanArtifactRuntime(db,{...env,ZENITH_PLAN_ARTIFACT_KEY:next,ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS:JSON.stringify([key])});
        await rotated.planArtifacts.inspect(access,async()=>undefined);
        const missingOld=createPlanArtifactRuntime(db,{...env,ZENITH_PLAN_ARTIFACT_KEY:next});
        await expect(missingOld.planArtifacts.inspect(access,async()=>undefined)).rejects.toThrow();
        expect(()=>planArtifactCipherFromEnv({...env,ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS:JSON.stringify([vault])})).toThrow();
        expect(()=>planArtifactCipherFromEnv({...env,ZENITH_PLAN_ARTIFACT_KEY:vault})).toThrow();
        expect(()=>planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:key,ZENITH_VAULT_PREVIOUS_SECRET_KEYS:JSON.stringify([key])})).toThrow();
        expect(()=>planArtifactCipherFromEnv({...env,ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS:"invalid"})).toThrow();
        made.planFile.fill(0);
      } finally {for(const log of logs)log.mockRestore();await db.close();await rm(temp,{recursive:true,force:true});}
    });
  },180000);
});
