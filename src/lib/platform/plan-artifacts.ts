/** Server-only encrypted custody. Plaintext is callback-scoped; no raw plan is an activity result. */
import { randomUUID } from "node:crypto";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { createPlanEngineAuthority, type PlanAdmission, type ApprovedPlan } from "@/lib/tofu/engine";
import { createExecutionBroker, isDefaultCurrentDispatchRequirement } from "./broker";
import type { BrokerPort, PlanArtifactsPort } from "@/lib/execution/ports";
import type { Sql } from "@/lib/controlplane/types";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import { assertDefaultMcpProductTopology } from "@/lib/controlplane/db/repos/workflow-start-deploy-authority";

export function planArtifactCipherFromEnv(env: Readonly<Record<string,string|undefined>> = process.env) {
  try {
    if (env.ZENITH_PLAN_ARTIFACT_KEY === env.ZENITH_SECRET_KEY || !env.ZENITH_PLAN_ARTIFACT_KEY || !/^[a-f0-9]{64}$/i.test(env.ZENITH_PLAN_ARTIFACT_KEY)) throw new Error();
    const overlap = (raw: string | undefined): string[] => {
      const values: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(values)) throw new Error();
      return values.map(value => {
        if (typeof value !== "string") throw new Error();
        const bytes = /^[a-f0-9]{64}$/i.test(value.trim()) ? Buffer.from(value.trim(),"hex") : Buffer.from(value.trim(),"base64");
        if (bytes.length !== 32) throw new Error();
        return bytes.toString("hex");
      });
    };
    const artifactKeys = [env.ZENITH_PLAN_ARTIFACT_KEY.toLowerCase(),...overlap(env.ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS)];
    const vaultKeys = [...(env.ZENITH_SECRET_KEY ? overlap(JSON.stringify([env.ZENITH_SECRET_KEY])) : []),...overlap(env.ZENITH_VAULT_PREVIOUS_SECRET_KEYS)];
    if (artifactKeys.some(key => vaultKeys.includes(key))) throw new Error();
    return vaultCipherFromEnv({ ZENITH_SECRET_KEY: env.ZENITH_PLAN_ARTIFACT_KEY, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: env.ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS });
  } catch { throw new Error("Plan artifact keys are unavailable or invalid."); }
}
function pairedRuntime(db: Sql, env: Readonly<Record<string,string|undefined>>, broker: Pick<BrokerPort,"approvalStatus">, kind: PlanArtifactsPort["kind"]) {
  if ((db as Sql & {kind?:string}).kind !== "postgres") throw new Error("Durable plan custody requires PostgreSQL.");
  const capture = (input: artifacts.ArtifactAccess): artifacts.ArtifactAccess => Object.freeze({custody:Object.freeze({...input.custody}),planDigest:input.planDigest,lease:Object.freeze({...input.lease})});
  const admissions = new WeakMap<ApprovedPlan,PlanAdmission>();
  const {codec,tofu}=createPlanEngineAuthority(planArtifactCipherFromEnv(env),original=>admissions.get(original),env);
  const decoded = <T>(row: artifacts.ArtifactRow, fn: (manifest: Readonly<artifacts.ArtifactRow["manifest"]>, bytes: Buffer) => Promise<T>) =>
    codec.withDecoded(row.manifest, { iv:row.iv, authTag:row.auth_tag, ciphertext:row.ciphertext }, fn);
  const port: PlanArtifactsPort = {
    kind,
    async associate(input) {
      const row=await artifacts.associate(db,input);
      try { await decoded(row,async()=>undefined); } catch { throw new artifacts.PlanArtifactError(); }
    },
    async publish(input) {
      try {
        if (!input.produced) throw new artifacts.PlanArtifactError();
        const sealed = codec.sealProduced(input.produced);
        const row = await artifacts.publish(db,{ ...sealed, lease:input.lease, evidence:input.evidence });
        // A repeated semantic plan returns the original only if it still authenticates.
        await decoded(row,async () => undefined);
      } catch { throw new artifacts.PlanArtifactError(); }
    },
    async inspect<T>(input: artifacts.ArtifactAccess, fn: (approved: ApprovedPlan) => Promise<T>) {
      input = capture(input);
      const row = await artifacts.read(db,input);
      try { return await decoded(row,manifest => fn(Object.freeze({manifest}))); } catch { throw new artifacts.PlanArtifactError(); }
    },
    async consume<T>(input: artifacts.ArtifactAccess, fn: (approved: ApprovedPlan, dispatch: () => Promise<void>) => Promise<T>) {
      input = capture(input);
      const attempt = randomUUID();
      const row = await artifacts.claim(db,input,attempt);
      let dispatched = false;
      try {
        if (kind === "postgres") {
          // Native absence cannot establish historical product provenance.
          // Only the existing explicit isolated test runtime accepts that seam.
          if (!await artifacts.requiresProductComposition(db, row, input.custody.operationId, attempt)) throw new artifacts.PlanArtifactError();
          await assertDefaultMcpProductTopology(db);
        }
        const result = await decoded(row, async (manifest,bytes) => {
          const approved: ApprovedPlan = Object.freeze({manifest});
          const admission: PlanAdmission = Object.freeze({manifest,bytes,custody:input.custody,attemptId:attempt,lease:input.lease,associated:manifest.operationId !== input.custody.operationId,
            dispatch: async () => {
              if (dispatched || admissions.get(approved)!==admission) throw new artifacts.PlanArtifactError();
              // Current policy/roles are evaluated by the captured broker, never by caller hooks.
              const authority=await broker.approvalStatus(input.custody.operationId);
              if(!authority.approved || authority.rejected || !authority.dispatchApproval || admissions.get(approved)!==admission) throw new artifacts.PlanArtifactError();
              const proof=authority.dispatchApproval;
              if (kind === "postgres" && !await isDefaultCurrentDispatchRequirement(proof,db,input.custody.workspaceId,input.custody.operationId)) throw new artifacts.PlanArtifactError();
              // Lost commit responses are non-replayable; mark locally before awaiting the CAS.
              dispatched=true;
              await artifacts.dispatch(db,input,attempt,proof);
            } });
          admissions.set(approved,admission);
          // Compatibility hook grants no dispatch authority. The paired engine owns the durable boundary.
          try { return await fn(approved, async () => undefined); } finally { admissions.delete(approved); }
        });
        if (!dispatched) throw new artifacts.PlanArtifactError();
        await artifacts.finish(db,input,attempt,true);
        return result;
      } catch (error) {
        await artifacts.finish(db,input,attempt,false).catch(() => undefined);
        if (dispatched) throw new Error("Original plan dispatch outcome is unconfirmed; inspect this operation before another write.");
        throw error;
      }
    },
  };
  return Object.freeze({ planArtifacts: Object.freeze(port), tofu });
}

/** Production always captures the real canonical broker. No per-call hook can replace it. */
export function createPlanArtifactRuntime(db: Sql, env: Readonly<Record<string,string|undefined>> = process.env) {
  return pairedRuntime(db,env,createExecutionBroker(db),"postgres");
}
/** Explicit fixture seam: real SQL/tool custody with isolated scope/role/policy fixtures, never production composition. */
export function createIsolatedPlanArtifactRuntimeForTests(db:Sql,env:Readonly<Record<string,string|undefined>>,broker:Pick<BrokerPort,"approvalStatus">) {
  if(process.env.NODE_ENV!=="test")throw new Error("Isolated plan custody is available only in tests.");
  return pairedRuntime(db,env,broker,"isolated-test");
}

/** Producer-only callers receive no engine or admission-registration capability. */
export function createPlanArtifactsPort(db: Sql, env: Readonly<Record<string,string|undefined>> = process.env): PlanArtifactsPort {
  return createPlanArtifactRuntime(db,env).planArtifacts;
}
