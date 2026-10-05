/**
 * Production applies the authenticated original binary after a separate fresh
 * semantic drift and ownership check. Producer provenance is captured inside
 * this engine. A paired production runtime owns callback-scoped admission;
 * legacy direct calls without an original retain fresh-plan behavior.
 * Raw binary plans are private worker data and never model-visible evidence.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { PlanInspector, PlanNormalizeBase, TofuSessionEnv } from "@/lib/tofu/runner";
import type { ResourceNode } from "@/lib/resources/types";
import { assertDeletionAllowed, TofuDeletionRefusedError } from "@/lib/tofu/plan";
import { assertWorkspaceIntact } from "@/lib/tofu/workspace";
import { stableJson } from "@/lib/tofu/stable";
import { digest } from "@/lib/controlplane/digest";
import type { Sealed, VaultCipher } from "@/lib/secrets";
import type { TofuExecutableIdentity } from "@/lib/tofu/binary";
import { isCleanedTofuRun, isCanonicalStandaloneRun, canonicalStandaloneCommandsMatch,canonicalStandaloneProducerMatch, MAX_PLAN_BYTES, TofuRunner, type TofuRun } from "@/lib/tofu/runner";
import { TOFU_VERSION, TofuPlanChangedError, TofuPlanProvenanceError, type NormalizedPlan, type TofuRunLimits, type TofuRunResult, type TofuWorkspace } from "@/lib/tofu/types";

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
/** Non-secret worker-private terminal binding. Its shape grants no authority. */
export interface StandalonePlanBinding {
  readonly workspaceId: string; readonly projectId: string; readonly environmentId: string;
  readonly operationId: string; readonly attemptId: string; readonly manifestDigest: string;
  readonly rawSha256: string; readonly backendDigest: string; readonly targetDigest: string;
  readonly holder: string; readonly fenceToken: number;
}
export interface StandalonePlanSettlement extends StandalonePlanBinding {
  readonly format: "zenith.tofu.standalone-settlement.v1";
  readonly stateDigest: string; readonly stateViewDigest: string; readonly executableDigest: string;
  readonly configDigest: string; readonly lockDigest: string; readonly purpose: "deploy" | "destroy";
  /** Encrypted worker-private custody only; never projected by a native receipt or preview. */
  readonly targetPath: string;
}
export interface SealedStandaloneSettlement {
  readonly binding: Readonly<StandalonePlanBinding>; readonly settlementDigest: string; readonly sealed: Readonly<Sealed>;
}
interface LocalStandaloneTarget { path: string; targetDigest: string; stateDigest?: string }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// A function declaration (not an arrow constant) so control-flow analysis treats calls as never-returning and narrows the guarded values.
function standaloneRefusal(): never { throw new Error("Standalone plan settlement is unavailable."); }
function finiteBuiltinBackend(ws: TofuWorkspace): string | undefined {
  if (ws.backend !== "local" || ws.lockfile.trim().split("\n").some(line => line.trim() && !line.trim().startsWith("#"))) return undefined;
  let backend: string | undefined, versions = 0, main = 0;
  const labels = new Set<string>();
  try {
    for (const file of ws.files) {
      const value: unknown = JSON.parse(file.content);
      if (!plain(value)) return undefined;
      if (file.path === "backend.tf.json") {
        if (Object.keys(value).join() !== "terraform" || !plain(value.terraform) || Object.keys(value.terraform).join() !== "backend"
          || !plain(value.terraform.backend) || Object.keys(value.terraform.backend).join() !== "local"
          || !plain(value.terraform.backend.local) || Object.keys(value.terraform.backend.local).join() !== "path"
          || typeof value.terraform.backend.local.path !== "string") return undefined;
        backend = value.terraform.backend.local.path;
      } else if (file.path === "versions.tf.json") {
        if (Object.keys(value).join() !== "terraform" || !plain(value.terraform) || Object.keys(value.terraform).join() !== "required_version"
          || value.terraform.required_version !== `= ${TOFU_VERSION}`) return undefined;
        versions++;
      } else if (file.path === "providers.tf.json") {
        if (Object.keys(value).length !== 0) return undefined;
      } else if (file.path === "main.tf.json") {
        if (Object.keys(value).some(key => key !== "resource" && key !== "output")) return undefined;
        if (value.resource !== undefined) {
          if (!plain(value.resource) || Object.keys(value.resource).join() !== "terraform_data" || !plain(value.resource.terraform_data)) return undefined;
          for (const [name, body] of Object.entries(value.resource.terraform_data)) {
            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || !plain(body) || Object.keys(body).some(key => key !== "input" && key !== "triggers_replace")) return undefined;
            labels.add(name);
          }
        }
        if (value.output !== undefined && (!plain(value.output) || Object.entries(value.output).some(([name, body]) =>
          !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || !plain(body) || Object.keys(body).some(key => key !== "value" && key !== "sensitive")))) return undefined;
        main++;
      } else return undefined;
    }
    // A deliberately finite expression language, not an HCL evaluator or a no-session shortcut.
    const walk = (value: unknown, depth = 0): boolean => {
      if (depth > 64) return false;
      if (typeof value === "string") {
        if (value.includes("%{")) return false;
        if (!value.includes("${")) return true;
        const match = /^\$\{terraform_data\.([A-Za-z_][A-Za-z0-9_-]*)\.(?:output|id)\}$/.exec(value);
        return !!match && labels.has(match[1]);
      }
      if (Array.isArray(value)) return value.every(child => walk(child, depth + 1));
      if (plain(value)) return Object.entries(value).every(([key, child]) => !key.includes("${") && !key.includes("%{") && walk(child, depth + 1));
      return value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
    };
    if (!ws.files.every(file => walk(JSON.parse(file.content)))) return undefined;
  } catch { return undefined; }
  return versions === 1 && main === 1 && backend && path.isAbsolute(backend) && path.normalize(backend) === backend
    && path.basename(backend) === "terraform.tfstate" && !/[\u0000-\u001f\u007f]/.test(backend) ? backend : undefined;
}
async function localStandaloneTarget(statePath: string, createdByCanonicalApply?: Readonly<{ targetDigest: string }>): Promise<LocalStandaloneTarget> {
  const parent = path.dirname(statePath), uid = process.getuid?.();
  if (uid === undefined || parent === path.parse(parent).root || await realpath(parent) !== parent) standaloneRefusal();
  let ancestor=parent,childOwner=uid;
  for (;;) {
    const directory=await lstat(ancestor);
    if(!directory.isDirectory() || directory.isSymbolicLink() || ![0,uid].includes(directory.uid)
      || ((directory.mode & 0o022)!==0 && !((directory.mode & 0o1000)!==0 && directory.uid===0 && childOwner===uid)))standaloneRefusal();
    if(ancestor===path.parse(ancestor).root)break;
    childOwner=directory.uid;ancestor=path.dirname(ancestor);
  }
  const root = await lstat(parent);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== uid || (root.mode & 0o077) !== 0) standaloneRefusal();
  // Physical parent identity and one fixed filename survive bind-mount aliases and refuse case-fold alternatives.
  // The separate immutable backend digest retains the exact approved pathname.
  if (path.basename(statePath) !== "terraform.tfstate") standaloneRefusal();
  const targetDigest = objectHash({ filename: "terraform.tfstate", device: root.dev, inode: root.ino, uid: root.uid });
  let file;
  try { file = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: statePath, targetDigest };
    return standaloneRefusal();
  }
  try {
    // Only authenticated, completed canonical apply can seal its newly written state.
    // OpenTofu creates 0644 files even inside the already validated private 0700 directory.
    // Earlier reads keep their strict 0600 requirement and never repair foreign state.
    if (createdByCanonicalApply) {
      if (createdByCanonicalApply.targetDigest !== targetDigest) standaloneRefusal();
      const created = await file.stat(), named = await lstat(statePath);
      if (!created.isFile() || created.uid !== uid || created.nlink !== 1
        || ((created.mode & 0o7777) & ~0o044) !== 0o600
        || named.isSymbolicLink() || named.dev !== created.dev || named.ino !== created.ino) standaloneRefusal();
      const assertSamePrivateParent = async () => {
        const currentParent = await lstat(parent);
        if (await realpath(parent) !== parent || !currentParent.isDirectory() || currentParent.isSymbolicLink()
          || currentParent.dev !== root.dev || currentParent.ino !== root.ino || currentParent.uid !== uid
          || (currentParent.mode & 0o077) !== 0) standaloneRefusal();
      };
      await assertSamePrivateParent();
      await file.chmod(0o600);
      await assertSamePrivateParent();
      const sealed = await file.stat(), current = await lstat(statePath);
      if (sealed.dev !== created.dev || sealed.ino !== created.ino || sealed.uid !== uid || sealed.nlink !== 1
        || (sealed.mode & 0o7777) !== 0o600 || sealed.size !== created.size || sealed.mtimeMs !== created.mtimeMs
        || current.isSymbolicLink() || current.dev !== sealed.dev || current.ino !== sealed.ino) standaloneRefusal();
    }
    const before = await file.stat();
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 16 * 1024 * 1024) standaloneRefusal();
    const bytes = await file.readFile(), after = await file.stat(), named = await lstat(statePath);
    try {
      if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino || named.isSymbolicLink()) standaloneRefusal();
      const state: unknown = JSON.parse(bytes.toString("utf8"));
      if (!plain(state) || state.version !== 4 || state.terraform_version !== TOFU_VERSION || typeof state.lineage !== "string" || !/^[a-f0-9-]{36}$/.test(state.lineage)
        || typeof state.serial !== "number" || !Number.isSafeInteger(state.serial) || state.serial < 0 || !Array.isArray(state.resources)
        || state.resources.some(resource => !plain(resource) || resource.module !== undefined || resource.mode !== "managed" || resource.type !== "terraform_data"
          || resource.provider !== 'provider["terraform.io/builtin/terraform"]')) standaloneRefusal();
      return { path: statePath, targetDigest, stateDigest: hash(bytes) };
    } finally { bytes.fill(0); }
  } catch { return standaloneRefusal(); } finally { await file.close(); }
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
  const standalonePath=custody&&record&&!session?finiteBuiltinBackend(snapshot):undefined;
  if(standalonePath)await localStandaloneTarget(standalonePath);
  const result = await runner.run(snapshot, { session, signal: opts.signal, limits: opts.limits }, async (run) => {
    if(standalonePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    await run.init();
    if(standalonePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    await run.plan({ lock: opts.lock, ...(opts.destroy ? { destroy: true } : {}) });
    if(standalonePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    const before = await run.planFileSha();
    if(standalonePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    const plan = await run.normalizedPlan(opts.normalize, inspector(opts));
    if(standalonePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    const planFile = await run.readPlanFile();
    if(standalonePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    if (hash(planFile) !== before || await run.planFileSha() !== before) throw new Error("Produced plan changed during inspection.");
    let produced: ProducedPlan | undefined;
    if (custody && executable && record) {
      if(!session && finiteBuiltinBackend(snapshot) && !canonicalStandaloneProducerMatch(runner,run,{configDigest:snapshot.configDigest,lockDigest:snapshot.lockDigest,rawSha256:before,destroy:!!opts.destroy,lock:opts.lock!==false,executable}))standaloneRefusal();
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
 , resolve?: (original: ApprovedPlan) => PlanAdmission | undefined,
  standalone?: Readonly<{ prepared(original: ApprovedPlan, binding: Readonly<StandalonePlanBinding>): void;
    completed(original: ApprovedPlan, settlement: Readonly<StandalonePlanSettlement>): void }>
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
  const statePath = original && !args.session && standalone ? finiteBuiltinBackend(snapshot) : undefined;
  // An eligible configuration can still name foreign state. Refuse it before init or refresh loads any provider.
  const initialTarget = statePath ? await localStandaloneTarget(statePath) : undefined;
  let target: LocalStandaloneTarget | undefined, binding: Readonly<StandalonePlanBinding> | undefined, appliedRun: TofuRun | undefined;
  const result = await runner.run(snapshot, { session: args.session, signal: args.signal, limits: args.limits }, async (run) => {
    appliedRun = run;
    if(statePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    await run.init();
    if(statePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    await run.plan(args.destroy ? { destroy: true } : undefined);
    if(statePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    // Fresh drift and ownership check uses a DIFFERENT file from the reviewed original.
    if (original && bytes) {
      const fresh = await run.normalizedPlan(args.normalize, inspector({ ...args, expectedDigest: args.approvedDigest }));
      if(statePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
      if (fresh.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, fresh.planDigest);
      await run.installReviewedPlan(bytes);
    }
    if(statePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    const { plan, result } = await run.apply({ expectedPlanDigest: args.approvedDigest, normalize: args.normalize, inspectPlan: inspector(args),
      ...(original ? { originalSha256: manifest!.rawSha256 } : {}), beforeDispatch: async () => {
        if (original && (!admission || resolve?.(original) !== admission)) throw new Error("Reviewed plan custody is unavailable.");
        if(statePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
        if (manifest) assertProvenance(manifest, snapshot, originalCustody, await runner.identity(), !!args.destroy);
        await args.beforeDispatch?.();
        if (original && (!admission || resolve?.(original) !== admission)) throw new Error("Reviewed plan custody is unavailable.");
        if (statePath && original && admission && manifest && standalone) {
          if(!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
          target = await localStandaloneTarget(statePath);
          if (!initialTarget || target.targetDigest !== initialTarget.targetDigest || target.stateDigest !== initialTarget.stateDigest) standaloneRefusal();
          binding = immutable({ workspaceId: admission.custody.workspaceId, projectId: admission.custody.projectId,
            environmentId: admission.custody.environmentId, operationId: admission.custody.operationId,
            attemptId: admission.attemptId, manifestDigest: digest(manifest), rawSha256: manifest.rawSha256,
            backendDigest: manifest.backendDigest, targetDigest: target.targetDigest, holder: admission.lease.holder, fenceToken: admission.lease.fenceToken });
          standalone.prepared(original, binding);
        }
        await admission?.dispatch();
        if (target) {
          const current = await localStandaloneTarget(target.path);
          if (current.targetDigest !== target.targetDigest || current.stateDigest !== target.stateDigest) standaloneRefusal();
        }
      } });
    if(statePath&&!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
    const outputs = await run.output();
    return { plan, apply: result, outputs };
  });
  if (target && binding && original && admission && manifest && standalone) {
    if(!isCanonicalStandaloneRun(runner,appliedRun,snapshot))standaloneRefusal();
    if (!isCleanedTofuRun(appliedRun) || resolve?.(original) !== admission || stableJson(await runner.identity()) !== stableJson(manifest.executable)) standaloneRefusal();
    const after = await localStandaloneTarget(target.path, { targetDigest: target.targetDigest });
    if (after.targetDigest !== target.targetDigest || !after.stateDigest) standaloneRefusal();
    let readbackRun: TofuRun | undefined;
    const stateViewDigest = await runner.run(snapshot, { signal: args.signal, limits: args.limits }, async run => {
      readbackRun = run;
      if(!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
      await run.init();
      if(!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
      const current = await run.plan(args.destroy ? { destroy: true } : undefined);
      if(!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
      const plan = await run.normalizedPlan(args.normalize, inspector(args));
      if(!isCanonicalStandaloneRun(runner,run,snapshot))standaloneRefusal();
      if (current.hasChanges || !plan.empty) standaloneRefusal();
      return run.currentStateDigest();
    });
    const observed = await localStandaloneTarget(target.path);
    if(!isCanonicalStandaloneRun(runner,readbackRun,snapshot))standaloneRefusal();
    if (!isCleanedTofuRun(readbackRun) || observed.targetDigest !== after.targetDigest || observed.stateDigest !== after.stateDigest
      || resolve?.(original) !== admission || stableJson(await runner.identity()) !== stableJson(manifest.executable)) standaloneRefusal();
    if(!canonicalStandaloneCommandsMatch(runner,appliedRun,readbackRun,{configDigest:snapshot.configDigest,lockDigest:snapshot.lockDigest,
      rawSha256:manifest.rawSha256,purpose:manifest.purpose,stateViewDigest,executable:manifest.executable}))standaloneRefusal();
    standalone.completed(original, immutable({ ...binding, format: "zenith.tofu.standalone-settlement.v1", stateDigest: after.stateDigest,
      stateViewDigest, executableDigest: objectHash(manifest.executable), configDigest: snapshot.configDigest, lockDigest: snapshot.lockDigest,
      purpose: manifest.purpose, targetPath: target.path }));
  }
  return result;
}

/** Direct legacy entry point never accepts an original from another custody authority. */
export const applyVerifiedPlan = (ws: TofuWorkspace, args: Parameters<typeof applyWithAdmission>[1]): Promise<ApplyVerifiedResult> => applyWithAdmission(ws, args);
/** Server composition captures one executable and two private registries. Neither is returned by the runtime. */
export function createPlanEngineAuthority(cipher:VaultCipher, resolve: (original:ApprovedPlan)=>PlanAdmission|undefined, env:Readonly<Record<string,string|undefined>>=process.env) {
  const producers=new WeakMap<ProducedPlan,ProducerRecord>();
  const prepared = new WeakMap<ApprovedPlan, Readonly<StandalonePlanBinding>>();
  const completed = new WeakMap<ApprovedPlan, Readonly<StandalonePlanSettlement>>();
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
      return applyWithAdmission(ws,{...args,runner},resolve,{
        prepared(original,binding) { if (prepared.has(original) || !resolve(original)) standaloneRefusal(); prepared.set(original,binding); },
        completed(original,settlement) { if (!resolve(original) || objectHash(prepared.get(original)) !== objectHash({
          workspaceId:settlement.workspaceId,projectId:settlement.projectId,environmentId:settlement.environmentId,operationId:settlement.operationId,
          attemptId:settlement.attemptId,manifestDigest:settlement.manifestDigest,rawSha256:settlement.rawSha256,backendDigest:settlement.backendDigest,
          targetDigest:settlement.targetDigest,holder:settlement.holder,fenceToken:settlement.fenceToken })) standaloneRefusal(); completed.set(original,settlement); },
      });
    },
  });
  const settlementRef = (binding: Readonly<StandalonePlanBinding>) => `zenith.tofu.standalone-settlement.v1:${objectHash(binding)}`;
  const authenticateSettlement = async (receipt: SealedStandaloneSettlement, manifest: Readonly<PlanArtifactManifest>): Promise<{stateDigest:string;currentDigest:string}> => {
    try {
      const value: unknown = JSON.parse(cipher.open(receipt.binding.workspaceId, settlementRef(receipt.binding), receipt.sealed).value);
      if (!plain(value) || value.format !== "zenith.tofu.standalone-settlement.v1" || objectHash(value) !== receipt.settlementDigest
        || digest(manifest) !== receipt.binding.manifestDigest || manifest.rawSha256 !== receipt.binding.rawSha256
        || manifest.backendDigest !== receipt.binding.backendDigest || value.executableDigest !== objectHash(manifest.executable)
        || value.configDigest !== manifest.configDigest || value.lockDigest !== manifest.lockDigest || value.purpose !== manifest.purpose
        || typeof value.stateDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.stateDigest) || !/^[a-f0-9]{64}$/.test(String(value.stateViewDigest))
        || typeof value.targetPath !== "string" || Object.entries(receipt.binding).some(([key,bound]) => value[key] !== bound)) standaloneRefusal();
      const target = await localStandaloneTarget(value.targetPath);
      if (target.targetDigest !== receipt.binding.targetDigest || !target.stateDigest) standaloneRefusal();
      return {stateDigest:value.stateDigest,currentDigest:target.stateDigest};
    } catch { return standaloneRefusal(); }
  };
  return Object.freeze({codec,tofu,
    preparedStandalone(original: ApprovedPlan): Readonly<StandalonePlanBinding> | undefined { return resolve(original) ? prepared.get(original) : undefined; },
    takeStandaloneSettlement(original: ApprovedPlan): SealedStandaloneSettlement | undefined {
      const settlement = completed.get(original), binding = prepared.get(original);
      if (!settlement || !binding || !resolve(original)) return undefined;
      completed.delete(original);
      return immutable({ binding, settlementDigest: objectHash(settlement), sealed: cipher.seal(binding.workspaceId, settlementRef(binding), stableJson(settlement)) });
    },
    async authenticateStandaloneSettlement(receipt: SealedStandaloneSettlement, manifest: Readonly<PlanArtifactManifest>): Promise<void> {
      await authenticateSettlement(receipt,manifest);
    },
    async authenticateCurrentStandaloneCompletion(receipt: SealedStandaloneSettlement, manifest: Readonly<PlanArtifactManifest>): Promise<void> {
      const observed=await authenticateSettlement(receipt,manifest);
      if(observed.stateDigest!==observed.currentDigest)standaloneRefusal();
    },
  });
}
