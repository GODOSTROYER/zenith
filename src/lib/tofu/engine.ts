/**
 * Production applies the authenticated original binary after a separate fresh
 * semantic drift and ownership check. Producer provenance is captured inside
 * this engine. A paired production runtime owns callback-scoped admission;
 * legacy direct calls without an original retain fresh-plan behavior.
 * Raw binary plans are private worker data and never model-visible evidence.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanInspector, PlanNormalizeBase, TofuSessionEnv } from "@/lib/tofu/runner";
import type { ResourceNode } from "@/lib/resources/types";
import { assertDeletionAllowed, TofuDeletionRefusedError } from "@/lib/tofu/plan";
import { assertWorkspaceIntact } from "@/lib/tofu/workspace";
import { stableJson } from "@/lib/tofu/stable";
import type { Sealed, VaultCipher } from "@/lib/secrets";
import type { TofuExecutableIdentity } from "@/lib/tofu/binary";
import { MAX_PLAN_BYTES, TofuRunner } from "@/lib/tofu/runner";
import { TofuPlanChangedError, TofuPlanProvenanceError, type NormalizedPlan, type TofuRunLimits, type TofuRunResult, type TofuWorkspace } from "@/lib/tofu/types";

export interface EngineOptions {
  /** defaults to a process-wide runner configured from `ZENITH_TOFU_BIN` / `ZENITH_TOFU_PLUGIN_CACHE` */
  runner?: TofuRunner;
  signal?: AbortSignal;
  limits?: Partial<TofuRunLimits>;
  normalize?: PlanNormalizeBase;
  /** Plan teardown; apply still consumes a verified saved plan, never auto-approve. */
  destroy?: boolean;
  /** Trusted nodes from the deployed revision, including nodes removed from the new manifest. */
  deletionNodes?: readonly ResourceNode[];
  /** Server-side ownership guard, re-run on the exact file being applied. Never persist raw JSON. */
  inspectPlan?: PlanInspector;
}

export interface PlanWorkspaceOptions extends EngineOptions {
  /** Optional legacy private attempt directory (mode 0700), with exclusive 0600 plan files. */
  planDir?: string;
  custody?: PlanCustodyInput;
  /**
   * Take OpenTofu's state lock (default true). Pass false for a plan made with
   * observe-purpose (read-only) credentials, which cannot write the lock
   * object; the caller must hold the environment's Zenith lease. See
   * `TofuRun.plan`.
   */
  lock?: boolean;
  /**
   * The approved digest a final re-plan must match. A plan that moved is
   * refused by the caller as `plan_changed` and never applied (verified apply
   * re-plans and re-runs the digest check and every guard), so its deletion
   * guards are skipped: the refusal names what actually happened, and no
   * provider is read on behalf of an unapproved plan.
   */
  expectedDigest?: string;
}

export interface PlanWorkspaceResult {
  plan: NormalizedPlan;
  /** binary plan file — server-side only */
  planFile: Buffer;
  planFilePath?: string;
  produced?: ProducedPlan;
}

export interface ApplyVerifiedResult {
  plan: NormalizedPlan;
  apply: TofuRunResult;
  /** non-sensitive outputs after apply (sensitive ones are dropped) */
  outputs: Record<string, { sensitive: boolean; type: unknown; value?: unknown }>;
}

export interface PlanCustodyInput {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
  proposalDigest: string;
  inputDigest: string;
  expiresAt: string;
  sourceDigest: string;
  graphDigest: string;
}
export interface PlanArtifactManifest extends PlanCustodyInput {
  format: "zenith.plan-artifact.v1";
  purpose: "deploy" | "destroy";
  configDigest: string;
  lockDigest: string;
  backendDigest: string;
  addressMapDigest: string;
  planDigest: string;
  rawSha256: string;
  bytes: number;
  executable: TofuExecutableIdentity;
}
/** These opaque handles are worker-private. Only the producing engine can create a publishable handle. */
export interface ProducedPlan { readonly manifest: Readonly<PlanArtifactManifest> }
export interface ApprovedPlan { readonly manifest: Readonly<PlanArtifactManifest> }
type ProducerRecord = { manifest: Readonly<PlanArtifactManifest>; bytes: Buffer };
export interface PlanAdmission {
  readonly manifest: Readonly<PlanArtifactManifest>;
  readonly bytes: Buffer;
  readonly custody: Readonly<PlanCustodyInput>;
  readonly attemptId: string;
  readonly lease: Readonly<{ scope: string; holder: string; fenceToken: number }>;
  readonly associated: boolean;
  readonly dispatch: () => Promise<void>;
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const objectHash = (value: unknown) => hash(stableJson(value));
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function frozenWorkspace(ws: TofuWorkspace): TofuWorkspace {
  const snapshot = immutable(JSON.parse(JSON.stringify(ws)) as TofuWorkspace);
  assertWorkspaceIntact(snapshot);
  return snapshot;
}
/** Cipher is captured by the server composition, never selected by an artifact reader or request. */
export function createPlanArtifactCodec(cipher: VaultCipher, producer?: (handle: ProducedPlan) => ProducerRecord | undefined) {
  const ref = (manifest: Readonly<PlanArtifactManifest>) => `zenith.tofu.plan-artifact.v1:${objectHash(manifest)}`;
  return Object.freeze({
    sealProduced(produced: ProducedPlan): { manifest: Readonly<PlanArtifactManifest>; sealed: Sealed } {
      const record = producer?.(produced);
      if (!record || record.bytes.length !== record.manifest.bytes || hash(record.bytes) !== record.manifest.rawSha256) throw new Error("Plan producer provenance is unavailable.");
      return { manifest: record.manifest, sealed: cipher.seal(record.manifest.workspaceId, ref(record.manifest), record.bytes.toString("base64")) };
    },
    async withDecoded<T>(manifest: PlanArtifactManifest, sealed: Sealed, fn: (manifest: Readonly<PlanArtifactManifest>, bytes: Buffer) => Promise<T>): Promise<T> {
      const snapshot = immutable(JSON.parse(JSON.stringify(manifest)) as PlanArtifactManifest);
      const encoded = cipher.open(snapshot.workspaceId, ref(snapshot), sealed).value;
      const bytes = Buffer.from(encoded, "base64");
      if (snapshot.format !== "zenith.plan-artifact.v1" || bytes.length < 1 || bytes.length > MAX_PLAN_BYTES || bytes.length !== snapshot.bytes
        || bytes.toString("base64") !== encoded || hash(bytes) !== snapshot.rawSha256) throw new Error("Reviewed plan integrity check failed.");
      try { return await fn(snapshot, bytes); } finally { bytes.fill(0); }
    },
  });
}
function assertProvenance(manifest: Readonly<PlanArtifactManifest>, ws: TofuWorkspace, custody: PlanCustodyInput | undefined, executable: TofuExecutableIdentity, destroy: boolean): void {
  if (!custody || Object.entries(custody).some(([key, value]) => manifest[key as keyof PlanCustodyInput] !== value)
    || manifest.purpose !== (destroy ? "destroy" : "deploy") || manifest.configDigest !== ws.configDigest || manifest.lockDigest !== ws.lockDigest
    || manifest.addressMapDigest !== objectHash(ws.addressMap) || manifest.backendDigest !== objectHash(ws.files.filter((f) => f.path === "backend.tf.json"))
    || stableJson(manifest.executable) !== stableJson(executable)) throw new TofuPlanProvenanceError();
}

let shared: TofuRunner | undefined;
function defaultRunner(): TofuRunner {
  shared ??= new TofuRunner();
  return shared;
}

function inspector(opts: EngineOptions & Pick<PlanWorkspaceOptions, "expectedDigest">): PlanInspector {
  return async (plan, raw) => {
    if (opts.expectedDigest !== undefined && plan.planDigest !== opts.expectedDigest) return;
    // Harness ownership checks may resolve unmapped state to trusted nodes here.
    await opts.inspectPlan?.(plan, raw);
    if (opts.destroy && plan.resourceChanges.some((c) => !["delete", "no-op", "read"].includes(c.action))) {
      throw new TofuDeletionRefusedError("A destroy plan contains a non-deletion mutation; refusing to apply.");
    }
    // Without trusted nodes the safe answer for a stateful deletion is refusal.
    assertDeletionAllowed(plan, opts.deletionNodes ?? []);
    if (!opts.inspectPlan && plan.resourceChanges.some((c) => ["delete", "replace"].includes(c.action) && ["aws_route53_record", "google_dns_record_set", "azurerm_dns_a_record", "azurerm_dns_cname_record", "oci_dns_rrset"].includes(c.type))) {
      throw new TofuDeletionRefusedError("DNS deletion requires a server-side target ownership guard.");
    }
  };
}

/** A normalized, masked, digest-bound `tofu plan -destroy`. */
export function planDestroy(ws: TofuWorkspace, session?: TofuSessionEnv, opts: PlanWorkspaceOptions = {}): Promise<PlanWorkspaceResult> {
  return planWorkspace(ws, session, { ...opts, destroy: true });
}

async function producePlan(ws: TofuWorkspace, session: TofuSessionEnv | undefined, opts: PlanWorkspaceOptions, record?: (handle:ProducedPlan,record:ProducerRecord)=>void): Promise<PlanWorkspaceResult> {
  opts = Object.freeze({ ...opts, normalize: opts.normalize ? Object.freeze({ ...opts.normalize }) : undefined,
    deletionNodes: opts.deletionNodes ? immutable(JSON.parse(JSON.stringify(opts.deletionNodes)) as ResourceNode[]) : undefined });
  const snapshot = frozenWorkspace(ws);
  const custody = opts.custody ? immutable(JSON.parse(JSON.stringify(opts.custody)) as PlanCustodyInput) : undefined;
  const runner = opts.runner ?? defaultRunner();
  const executable = custody ? await runner.identity() : undefined;
  const result = await runner.run(snapshot, { session, signal: opts.signal, limits: opts.limits }, async (run) => {
    await run.init();
    await run.plan({ lock: opts.lock, ...(opts.destroy ? { destroy: true } : {}) });
    const before = await run.planFileSha();
    const plan = await run.normalizedPlan(opts.normalize, inspector(opts));
    const planFile = await run.readPlanFile();
    if (hash(planFile) !== before || await run.planFileSha() !== before) throw new Error("Produced plan changed during inspection.");
    let produced: ProducedPlan | undefined;
    if (custody && executable && record) {
      if (stableJson(executable) !== stableJson(await runner.identity())) throw new Error("OpenTofu executable changed during planning.");
      const manifest: PlanArtifactManifest = { ...custody, format: "zenith.plan-artifact.v1", purpose: opts.destroy ? "destroy" : "deploy",
        configDigest: snapshot.configDigest, lockDigest: snapshot.lockDigest, backendDigest: objectHash(snapshot.files.filter((f) => f.path === "backend.tf.json")),
        addressMapDigest: objectHash(snapshot.addressMap), planDigest: plan.planDigest, rawSha256: before, bytes: planFile.length, executable };
      produced = Object.freeze({ manifest: immutable(manifest) });
      record(produced, { manifest: produced.manifest, bytes: Buffer.from(planFile) });
    }
    return { plan, planFile, produced };
  });
  let planFilePath: string | undefined;
  if (opts.planDir) {
    await mkdir(opts.planDir, { recursive: true, mode: 0o700 });
    const attempt = await mkdtemp(path.join(opts.planDir, "attempt-"));
    planFilePath = path.join(attempt, "reviewed.tfplan");
    await writeFile(planFilePath, result.planFile, { flag: "wx", mode: 0o600 });
  }
  return { ...result, planFilePath };
}

export function planWorkspace(ws: TofuWorkspace, session?: TofuSessionEnv, opts: PlanWorkspaceOptions = {}): Promise<PlanWorkspaceResult> {
  return producePlan(ws,session,opts);
}

async function applyWithAdmission(
  ws: TofuWorkspace,
  args: { approvedDigest: string; session?: TofuSessionEnv; original?: ApprovedPlan; custody?: PlanCustodyInput; beforeDispatch?: () => Promise<void> } & EngineOptions
 , resolve?: (original: ApprovedPlan) => PlanAdmission | undefined
): Promise<ApplyVerifiedResult> {
  args = Object.freeze({ ...args, normalize: args.normalize ? Object.freeze({ ...args.normalize }) : undefined,
    deletionNodes: args.deletionNodes ? immutable(JSON.parse(JSON.stringify(args.deletionNodes)) as ResourceNode[]) : undefined });
  const snapshot = frozenWorkspace(ws);
  const custody = args.custody ? immutable(JSON.parse(JSON.stringify(args.custody)) as PlanCustodyInput) : undefined;
  const runner = args.runner ?? defaultRunner();
  const original = args.original;
  if (resolve && !original) throw new Error("Reviewed plan custody is required.");
  const admission = original ? resolve?.(original) : undefined;
  const bytes = admission?.bytes;
  const manifest = admission?.manifest;
  if (original && (!admission || !bytes || !manifest || manifest.planDigest !== args.approvedDigest
    || stableJson(custody) !== stableJson(admission.custody) || !admission.attemptId || admission.lease.scope !== `env:${custody?.environmentId}`)) throw new Error("Reviewed plan custody is unavailable.");
  const originalCustody = admission?.associated ? { ...custody!, operationId: manifest!.operationId, proposalDigest: manifest!.proposalDigest,
    inputDigest: manifest!.inputDigest, expiresAt: manifest!.expiresAt } : custody;
  if (manifest) assertProvenance(manifest, snapshot, originalCustody, await runner.identity(), !!args.destroy);
  return runner.run(snapshot, { session: args.session, signal: args.signal, limits: args.limits }, async (run) => {
    await run.init();
    await run.plan(args.destroy ? { destroy: true } : undefined);
    // Fresh drift and ownership check uses a DIFFERENT file from the reviewed original.
    if (original && bytes) {
      const fresh = await run.normalizedPlan(args.normalize, inspector({ ...args, expectedDigest: args.approvedDigest }));
      if (fresh.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, fresh.planDigest);
      await run.installReviewedPlan(bytes);
    }
    const { plan, result } = await run.apply({ expectedPlanDigest: args.approvedDigest, normalize: args.normalize, inspectPlan: inspector(args),
      ...(original ? { originalSha256: manifest!.rawSha256 } : {}), beforeDispatch: async () => {
        if (original && (!admission || resolve?.(original) !== admission)) throw new Error("Reviewed plan custody is unavailable.");
        if (manifest) assertProvenance(manifest, snapshot, originalCustody, await runner.identity(), !!args.destroy);
        await args.beforeDispatch?.();
        if (original && (!admission || resolve?.(original) !== admission)) throw new Error("Reviewed plan custody is unavailable.");
        await admission?.dispatch();
      } });
    const outputs = await run.output();
    return { plan, apply: result, outputs };
  });
}

/** Direct legacy entry point never accepts an original from another custody authority. */
export const applyVerifiedPlan = (ws: TofuWorkspace, args: Parameters<typeof applyWithAdmission>[1]): Promise<ApplyVerifiedResult> => applyWithAdmission(ws, args);
/** Server composition captures one executable and two private registries. Neither is returned by the runtime. */
export function createPlanEngineAuthority(cipher:VaultCipher, resolve: (original:ApprovedPlan)=>PlanAdmission|undefined, env:Readonly<Record<string,string|undefined>>=process.env) {
  const producers=new WeakMap<ProducedPlan,ProducerRecord>();
  // An explicitly supplied environment is the complete authority snapshot, including absent keys.
  const hostEnv=Object.freeze({...env});
  const runner=new TofuRunner({hostEnv,workRoot:hostEnv.ZENITH_WORKER_PLAN_DIR});
  const codec=createPlanArtifactCodec(cipher,handle=>producers.get(handle));
  const tofu=Object.freeze({
    async planWorkspace(ws:TofuWorkspace,session?:TofuSessionEnv,opts:PlanWorkspaceOptions={}) {
      if (opts.runner) throw new Error("Production plan custody does not accept a runner override.");
      return producePlan(ws,session,{...opts,runner},(handle,record)=>producers.set(handle,record));
    },
    async applyVerifiedPlan(ws:TofuWorkspace,args:Parameters<typeof applyWithAdmission>[1]) {
      if (args.runner) throw new Error("Production plan custody does not accept a runner override.");
      return applyWithAdmission(ws,{...args,runner},resolve);
    },
  });
  return Object.freeze({codec,tofu});
}
