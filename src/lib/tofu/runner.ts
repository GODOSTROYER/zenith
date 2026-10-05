/**
 * `TofuRunner` — executes the pinned `tofu` binary for one workspace.
 *
 * Every run gets a fresh private directory holding the workspace files, the
 * committed lockfile, a per-run HOME/TMP and a generated CLI config; nothing
 * of the user's or the control plane's environment is inherited (see
 * `env.ts`). The directory is removed on `dispose()` — state lives in the
 * backend, never in the run dir (a `local` backend is for tests and must name
 * an absolute path outside it).
 *
 *   runner.run(ws, { session }, async (run) => {
 *     await run.init();
 *     const { hasChanges } = await run.plan();
 *     const { json } = await run.showJson();
 *     …
 *   });
 *
 * Guarantees, all covered by tests/tofu:
 *   - `tofu version -json` must equal `TOFU_VERSION` or nothing runs;
 *   - the workspace's digests are recomputed from its bytes before it is
 *     materialized;
 *   - `init` uses `-lockfile=readonly`; plan uses `-detailed-exitcode
 *     -lock-timeout=60s -input=false`;
 *   - wall-clock timeout and `AbortSignal` terminate the whole process tree;
 *   - output is redacted (session secrets by exact value, then patterns) and
 *     capped head+tail with a `truncated` flag;
 *   - `apply` re-runs `show -json` on the very plan file it is about to
 *     apply, refuses a digest other than the expected one
 *     (`TofuPlanChangedError`) and refuses a plan file that changed on disk
 *     in between.
 *
 * Limits (honest): not sandboxed beyond the environment allowlist and process
 * tree kill — provider plugins run with the runner's OS privileges and
 * network. Only builtin `terraform_data` and `hashicorp/random` have been
 * exercised by real runs in this repo; AWS/GCP/Azure/OCI/Kubernetes have
 * not been run against a cloud.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTofuVersion, describeTofuBinary, resolveTofuBinary, type TofuExecutableIdentity, type TofuVersionInfo } from "@/lib/tofu/binary";
import { buildChildEnv, validateExtraEnv, type HostEnv, type SessionEnvProvider } from "@/lib/tofu/env";
import { generateLockfile } from "@/lib/tofu/lockgen";
import { runProcess, type RunProcessResult } from "@/lib/tofu/process";
import { normalizePlan, parseShowJson, type NormalizePlanOptions, type PlanDiagnostic, type ShowJson } from "@/lib/tofu/plan";
import type { ProviderLocalName } from "@/lib/tofu/providers";
import { redactOutput, secretValuesOf } from "@/lib/tofu/redact";
import { renderUiStream } from "@/lib/tofu/ui-stream";
import { LOCKFILE_NAME } from "@/lib/tofu/config-digest";
import { assertWorkspaceIntact } from "@/lib/tofu/workspace";
import { TOFU_VERSION, TofuPlanChangedError, type NormalizedPlan, type TofuRunLimits, type TofuRunResult, type TofuWorkspace } from "@/lib/tofu/types";

export const PLAN_FILE = "tfplan";
const ORIGINAL_PLAN_FILE = "reviewed.tfplan";
export const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_SHOW_JSON_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_JSON_BYTES = 8 * 1024 * 1024;
const cleanedRuns = new WeakSet<object>();
// Capture the canonical child implementation before exported runner factories are available.
const canonicalRunProcess=runProcess;
interface FieldShape { prototype:object|null; fields:ReadonlyMap<PropertyKey,Readonly<{descriptor:PropertyDescriptor;child?:FieldShape}>> }
function fieldShape(value:object,depth=0):FieldShape|undefined {
  if(depth>8)return undefined;
  const fields=new Map<PropertyKey,Readonly<{descriptor:PropertyDescriptor;child?:FieldShape}>>();
  for(const key of Reflect.ownKeys(value)) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor || !("value" in descriptor))return undefined;
    let child:FieldShape|undefined;
    if(descriptor.value && typeof descriptor.value==="object") {
      const prototype=Object.getPrototypeOf(descriptor.value);
      if(prototype===Object.prototype || prototype===Array.prototype || prototype===null) {child=fieldShape(descriptor.value,depth+1);if(!child)return undefined;}
    }
    fields.set(key,{descriptor,child});
  }
  return {prototype:Object.getPrototypeOf(value),fields};
}
function matchesFields(value:object,shape:FieldShape):boolean {
  if(Object.getPrototypeOf(value)!==shape.prototype || Reflect.ownKeys(value).length!==shape.fields.size)return false;
  for(const [key,before] of shape.fields) {
    const current=Object.getOwnPropertyDescriptor(value,key),saved=before.descriptor;
    if(!current || !("value" in current) || current.value!==saved.value || current.writable!==saved.writable
      || current.enumerable!==saved.enumerable || current.configurable!==saved.configurable || before.child && !matchesFields(current.value,before.child))return false;
  }
  return true;
}
const runnerInputs=new WeakMap<object,Readonly<{fields:ReadonlyMap<string,FieldShape>}>>();
interface NativeCommand { command:TofuRunResult["command"]; args:readonly string[]; exitCode:number; originalSha?:string; planSha?:string; stateViewDigest?:string }
interface NativeRun { runner:TofuRunner; init:RunInit; shape:FieldShape; identity:TofuExecutableIdentity; files:readonly Readonly<{path:string;content:string}>[]; lockfile:string; workspaceJson:string; commands:NativeCommand[] }
const nativeRuns=new WeakMap<object,NativeRun>();
function originalRunner(value:TofuRunner):boolean {
  const known=runnerInputs.get(value);
  return !!known && samePrototype(TofuRunner.prototype,runnerPrototype) && samePrototype(TofuRun.prototype,runPrototype)
    && Object.getPrototypeOf(value)===TofuRunner.prototype && [...known.fields].every(([key,shape])=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,key);return !!descriptor && "value" in descriptor && matchesFields(descriptor.value,shape);
    });
}
function originalRun(value:object):NativeRun|undefined {
  const known=nativeRuns.get(value);
  if(!known)return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(value,"i");
  const keys=Reflect.ownKeys(value),disposed=Object.getOwnPropertyDescriptor(value,"disposed"),diagnostics=Object.getOwnPropertyDescriptor(value,"lastDiagnostics");
  return known && keys.length===3 && keys.every(key=>["i","disposed","lastDiagnostics"].includes(String(key)))
    && disposed&&"value" in disposed&&typeof disposed.value==="boolean"&&diagnostics&&"value" in diagnostics&&Array.isArray(diagnostics.value)
    && originalRunner(known.runner) && Object.getPrototypeOf(value)===TofuRun.prototype && descriptor && "value" in descriptor
    && descriptor.value===known.init && matchesFields(known.init,known.shape) ? known : undefined;
}
function checkedRun(value:object):NativeRun|undefined {
  const native=originalRun(value);
  if(nativeRuns.has(value)&&!native)throw new Error("Canonical standalone run origin changed.");
  return native;
}
async function originalFilesMatch(native:NativeRun,work:string):Promise<boolean> {
  try {
    const names=await readdir(work),expected=new Set(native.files.map(file=>file.path));
    if(names.some(name=>/\.(?:tf|tf\.json|tfvars|tfvars\.json)$/.test(name) && !expected.has(name)))return false;
    for(const file of native.files)if(await readFile(path.join(work,file.path),"utf8")!==file.content)return false;
    if(await readFile(path.join(work,LOCKFILE_NAME),"utf8")!==native.lockfile)return false;
    try{if((await readFile(path.join(work,".terraform","environment"),"utf8")).trim()!=="default")return false;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")return false;}
    return true;
  } catch {return false;}
}
async function nativePlanSha(work:string,file:string):Promise<string> {
  const handle=await open(path.join(work,file),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size<1||before.size>MAX_PLAN_BYTES)throw new Error("Binary plan exceeds its custody bound.");
    const bytes=await handle.readFile(),after=await handle.stat();try{if(bytes.length!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error("Binary plan changed while being read.");return createHash("sha256").update(bytes).digest("hex");}finally{bytes.fill(0);}
  }finally{await handle.close();}
}
const canonicalInitArgs=Object.freeze(["init","-input=false","-no-color","-lockfile=readonly"]);
const canonicalPlanArgs=(destroy:boolean,lock:boolean)=>["plan",...(destroy?["-destroy"]:[]),`-out=${PLAN_FILE}`,"-input=false","-detailed-exitcode",lock?"-lock-timeout=60s":"-lock=false","-no-color","-json"];
function canonicalInitialCommands(run:NativeRun,destroy:boolean,lock:boolean):boolean {
  const init=run.commands.filter(command=>command.command==="init"),plan=run.commands.filter(command=>command.command==="plan");
  return init.length===1&&init[0].exitCode===0&&JSON.stringify(init[0].args)===JSON.stringify(canonicalInitArgs)
    && plan.length===1&&[0,2].includes(plan[0].exitCode)&&JSON.stringify(plan[0].args)===JSON.stringify(canonicalPlanArgs(destroy,lock));
}
function canonicalCommandArgs(command:TofuRunResult["command"],args:readonly string[]):boolean {
  const value=JSON.stringify(args),same=(expected:readonly string[])=>value===JSON.stringify(expected);
  if(command==="init")return same(canonicalInitArgs)||same([...canonicalInitArgs,"-backend=false"]);
  if(command==="plan")return [false,true].some(destroy=>[false,true].some(lock=>same(canonicalPlanArgs(destroy,lock))));
  if(command==="apply")return [PLAN_FILE,ORIGINAL_PLAN_FILE].some(file=>same(["apply","-input=false","-lock-timeout=60s","-no-color","-json",file]));
  if(command==="show")return same(["show","-json","-no-color"])||[PLAN_FILE,ORIGINAL_PLAN_FILE].some(file=>same(["show","-json","-no-color",file]));
  if(command==="validate")return same(["validate","-json","-no-color"]);
  return command==="output"&&same(["output","-json","-no-color"]);
}
/** A caller return or mutable producer method cannot attest the actual binary produced by the canonical child. */
export function canonicalStandaloneProducerMatch(runner:TofuRunner,value:unknown,binding:Readonly<{configDigest:string;lockDigest:string;rawSha256:string;destroy:boolean;lock:boolean;executable:Readonly<TofuExecutableIdentity>}>):boolean {
  if(typeof value!=="object"||value===null)return false;const known=originalRun(value);if(!known||known.runner!==runner)return false;
  const descriptor=Object.getOwnPropertyDescriptor(known.init,"ws"),workspace=descriptor&&"value" in descriptor?descriptor.value:undefined;
  const planned=known.commands.filter(command=>command.command==="plan");
  return workspace?.configDigest===binding.configDigest&&workspace?.lockDigest===binding.lockDigest&&JSON.stringify(known.identity)===JSON.stringify(binding.executable)
    && canonicalInitialCommands(known,binding.destroy,binding.lock)&&planned[0].planSha===binding.rawSha256;
}
/** Fixed observations only. There is no public registrar or returned command evidence object. */
export function isCanonicalStandaloneRun(runner:TofuRunner,value:unknown,workspace:TofuWorkspace):boolean {
  if(typeof value!=="object"||value===null)return false;const known=originalRun(value);
  return !!known&&known.runner===runner&&known.workspaceJson===JSON.stringify(workspace);
}
export function canonicalStandaloneCommandsMatch(runner:TofuRunner,applied:unknown,readback:unknown,
  binding:Readonly<{configDigest:string;lockDigest:string;rawSha256:string;purpose:"deploy"|"destroy";stateViewDigest:string;executable:Readonly<TofuExecutableIdentity>}>):boolean {
  if(typeof applied!=="object" || applied===null || typeof readback!=="object" || readback===null || applied===readback)return false;
  const first=originalRun(applied),second=originalRun(readback);
  if(!first || !second || first.runner!==runner || second.runner!==runner || !cleanedRuns.has(applied) || !cleanedRuns.has(readback))return false;
  const config=(run:NativeRun)=>{
    const descriptor=Object.getOwnPropertyDescriptor(run.init,"ws"),workspace=descriptor&&"value" in descriptor?descriptor.value:undefined;
    return workspace?.configDigest===binding.configDigest && workspace?.lockDigest===binding.lockDigest;
  };
  const apply=first.commands.filter(command=>command.command==="apply"),plan=second.commands.filter(command=>command.command==="plan"),state=second.commands.filter(command=>command.stateViewDigest);
  return JSON.stringify(first.identity)===JSON.stringify(binding.executable)&&JSON.stringify(second.identity)===JSON.stringify(binding.executable)
    && config(first)&&config(second)&&canonicalInitialCommands(first,binding.purpose==="destroy",true)&&canonicalInitialCommands(second,binding.purpose==="destroy",true)&&apply.length===1&&apply[0].exitCode===0&&apply[0].originalSha===binding.rawSha256
    && JSON.stringify(apply[0].args)===JSON.stringify(["apply","-input=false","-lock-timeout=60s","-no-color","-json",ORIGINAL_PLAN_FILE])
    && plan.length===1&&plan[0].exitCode===0&&plan[0].args.includes("-destroy")===(binding.purpose==="destroy")
    && state.length===1&&state[0].stateViewDigest===binding.stateViewDigest;
}
/** Fixed private-origin observation. Shape, status and copied objects cannot attest cleanup. */
export function isCleanedTofuRun(value: unknown): boolean {
  return typeof value === "object" && value !== null && cleanedRuns.has(value);
}

export const DEFAULT_LIMITS: TofuRunLimits = { timeoutMs: 30 * 60_000, maxOutputBytes: 1024 * 1024 };

/** Anything with `childProcessEnv()` — every provider session that can drive tofu. */
export interface TofuSessionEnv {
  readonly provider?: SessionEnvProvider;
  childProcessEnv?(): Record<string, string>;
}

export interface TofuRunnerOptions {
  /** absolute path of the tofu binary; default `ZENITH_TOFU_BIN`, then PATH */
  bin?: string;
  /** shared provider plugin cache; default `ZENITH_TOFU_PLUGIN_CACHE`, then `<tmp>/zenith-tofu-plugin-cache` */
  pluginCacheDir?: string;
  /** parent of per-run directories; default the OS temp dir */
  workRoot?: string;
  limits?: Partial<TofuRunLimits>;
  /** POSIX SIGINT→SIGKILL grace, default 5 s */
  graceMs?: number;
  /** operator-supplied non-secret environment (e.g. proxy settings) */
  extraEnv?: Record<string, string>;
  /** environment read ONLY for ZENITH_TOFU_BIN / ZENITH_TOFU_PLUGIN_CACHE / PATH lookups */
  hostEnv?: HostEnv;
  expectedVersion?: string;
  /** Production uses the checksum-verified packaged identity. Tests may omit it explicitly. */
  identityFile?: string;
}

export interface TofuRunContext {
  /** brokered provider session; only `childProcessEnv()` is used */
  session?: TofuSessionEnv;
  signal?: AbortSignal;
  limits?: Partial<TofuRunLimits>;
}

export class TofuCommandError extends Error {
  readonly code: "tofu_command_failed" | "tofu_timeout" | "tofu_aborted" | "tofu_output_overflow";
  constructor(
    code: TofuCommandError["code"],
    message: string,
    readonly result: TofuRunResult
  ) {
    super(message);
    this.name = "TofuCommandError";
    this.code = code;
  }
}

/* --------------------------------- runner --------------------------------- */

export class TofuRunner {
  private readonly hostEnv: HostEnv;
  private readonly limits: TofuRunLimits;
  private readonly pluginCacheDir: string;
  private readonly extraEnv: Record<string, string>;
  private binaryReady?: Promise<{ bin: string; info: TofuVersionInfo }>;

  constructor(private readonly opts: TofuRunnerOptions = {}) {
    this.hostEnv = opts.hostEnv ?? process.env;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.pluginCacheDir = opts.pluginCacheDir ?? this.hostEnv.ZENITH_TOFU_PLUGIN_CACHE ?? path.join(os.tmpdir(), "zenith-tofu-plugin-cache");
    if (!path.isAbsolute(this.pluginCacheDir)) throw new Error("The tofu plugin cache directory must be an absolute path.");
    this.extraEnv = validateExtraEnv(opts.extraEnv, "Runner");
    const fields=new Map<string,FieldShape>();
    for(const key of ["opts","hostEnv","limits","extraEnv"]) {
      const descriptor=Object.getOwnPropertyDescriptor(this,key),shape=descriptor&&"value" in descriptor&&typeof descriptor.value==="object"?fieldShape(descriptor.value):undefined;
      if(!shape)return;fields.set(key,shape);
    }
    runnerInputs.set(this,{fields});
  }

  /** Resolve the binary and enforce the pinned version (memoized). */
  binary(): Promise<{ bin: string; info: TofuVersionInfo }> {
    if (!this.binaryReady) {
      this.binaryReady = (async () => {
        const bin = resolveTofuBinary(this.hostEnv, this.opts.bin);
        const info = await checkTofuVersion(bin, this.opts.expectedVersion ?? TOFU_VERSION);
        return { bin, info };
      })();
      this.binaryReady.catch(() => {
        this.binaryReady = undefined;
      });
    }
    return this.binaryReady;
  }

  async identity(): Promise<TofuExecutableIdentity> {
    const { bin, info } = await this.binary();
    return describeTofuBinary(bin, info, this.opts.identityFile ?? this.hostEnv.ZENITH_TOFU_IDENTITY_FILE ?? (this.hostEnv.NODE_ENV === "production" ? "/usr/local/share/zenith/tofu-identity.json" : undefined));
  }

  /** Materialize `ws` into a fresh private directory and return a handle. */
  async open(ws: TofuWorkspace, ctx: TofuRunContext = {}): Promise<TofuRun> {
    assertWorkspaceIntact(ws);
    const { bin, info } = await this.binary();
    // Original lexical verification independently binds the actually executed file,
    // including a cached binaryReady value that cannot substitute another target.
    let nativeIdentity:TofuExecutableIdentity|undefined;
    try {
      if(originalRunner(this) && info.version===TOFU_VERSION && resolveTofuBinary(this.hostEnv,this.opts.bin)===bin)
        nativeIdentity=await describeTofuBinary(bin,info,this.opts.identityFile??this.hostEnv.ZENITH_TOFU_IDENTITY_FILE??(this.hostEnv.NODE_ENV==="production"?"/usr/local/share/zenith/tofu-identity.json":undefined));
    } catch { /* Legacy/model execution is preserved, but cannot originate settlement. */ }
    await mkdir(this.pluginCacheDir, { recursive: true });
    const root = await mkdtemp(path.join(this.opts.workRoot ?? os.tmpdir(), "zenith-tofu-run-"));
    try {
      const work = path.join(root, "work");
      const home = path.join(root, "home");
      const tmp = path.join(root, "tmp");
      for (const d of [work, home, tmp]) await mkdir(d, { recursive: true });
      const cli = path.join(root, "tofu.rc");
      await writeFile(cli, "# generated by zenith: provider installation is registry + shared plugin cache only\n", { mode: 0o600 });
      for (const f of ws.files) {
        const target = path.join(work, ...f.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, f.content, { mode: 0o600 });
      }
      await writeFile(path.join(work, LOCKFILE_NAME), ws.lockfile, { mode: 0o600 });
      const run=new TofuRun({
        bin,
        ws,
        root,
        work,
        home,
        tmp,
        cli,
        pluginCacheDir: this.pluginCacheDir,
        extraEnv: this.extraEnv,
        hostEnv: this.hostEnv,
        limits: { ...this.limits, ...ctx.limits },
        graceMs: this.opts.graceMs,
        session: ctx.session,
        signal: ctx.signal,
      });
      const descriptor=Object.getOwnPropertyDescriptor(run,"i"),init=descriptor&&"value" in descriptor?descriptor.value:undefined;
      const shape=init&&typeof init==="object"?fieldShape(init):undefined;
      if(shape && nativeIdentity && originalRunner(this))nativeRuns.set(run,{runner:this,init,shape,identity:Object.freeze({...nativeIdentity}),files:Object.freeze(ws.files.map(file=>Object.freeze({path:file.path,content:file.content}))),lockfile:ws.lockfile,workspaceJson:JSON.stringify(ws),commands:[]});
      return run;
    } catch (err) {
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      throw err;
    }
  }

  /** `open`, run `fn`, always dispose. */
  async run<T>(ws: TofuWorkspace, ctx: TofuRunContext, fn: (run: TofuRun) => Promise<T>): Promise<T> {
    const run = await this.open(ws, ctx);
    try {
      return await fn(run);
    } finally {
      checkedRun(run);
      await run.dispose();
    }
  }

  /** `tofu providers lock` for the given providers on every lock platform. */
  async providersLock(providers: readonly ProviderLocalName[], platforms?: readonly string[], signal?: AbortSignal): Promise<{ lockfile: string; result: TofuRunResult }> {
    const { bin } = await this.binary();
    return generateLockfile({ bin, providers, platforms, signal });
  }
}

/* ----------------------------------- run ---------------------------------- */

interface RunInit {
  bin: string;
  ws: TofuWorkspace;
  root: string;
  work: string;
  home: string;
  tmp: string;
  cli: string;
  pluginCacheDir: string;
  extraEnv: Record<string, string>;
  hostEnv: HostEnv;
  limits: TofuRunLimits;
  graceMs?: number;
  session?: TofuSessionEnv;
  signal?: AbortSignal;
}

export interface ExecOptions {
  /** exit codes that are not failures */
  okExitCodes?: readonly number[];
  timeoutMs?: number;
  /** capture stdout separately (structured commands) */
  captureStdoutBytes?: number;
  /** the command emits tofu's JSON UI stream */
  uiStream?: boolean;
  /** do not throw on a nonzero exit; the caller interprets the result */
  allowFailure?: boolean;
}

interface ExecOutcome {
  result: TofuRunResult;
  stdout?: string;
  diagnostics: PlanDiagnostic[];
  raw: RunProcessResult;
}

export type PlanNormalizeBase = Pick<NormalizePlanOptions, "statefulTypes" | "fingerprintKey" | "now" | "executableSourceDigest">;

/** Server-side guard only. Raw show JSON contains secrets and must never escape this callback. */
export type PlanInspector = (plan: NormalizedPlan, raw: ShowJson) => void | Promise<void>;

export class TofuRun {
  private disposed = false;
  private lastDiagnostics: PlanDiagnostic[] = [];

  constructor(private readonly i: RunInit) {}

  get workspace(): TofuWorkspace {
    checkedRun(this);
    return this.i.ws;
  }

  /** Directory tofu runs in. Exposed for tests; do not write to it. */
  get workDir(): string {
    checkedRun(this);
    return this.i.work;
  }

  /** Warnings and errors tofu reported in the most recent plan/apply. */
  get diagnostics(): PlanDiagnostic[] {
    checkedRun(this);
    return this.lastDiagnostics;
  }

  private async command(command: TofuRunResult["command"], args: string[], o: ExecOptions = {}): Promise<ExecOutcome> {
    const native=originalRun(this),argv=Object.freeze([...args]);
    if(nativeRuns.has(this)&&(!native||!canonicalCommandArgs(command,argv)))throw new Error("Canonical standalone command origin changed.");
    const input=native?native.init:this.i;
    if (this.disposed) throw new Error("This tofu run has been disposed.");
    const sessionEnv = input.session?.childProcessEnv?.() ?? {};
    const env = buildChildEnv({
      homeDir: input.home,
      tmpDir: input.tmp,
      cliConfigFile: input.cli,
      pluginCacheDir: input.pluginCacheDir,
      sessionEnv,
      sessionProvider: input.session?.provider,
      extraEnv: input.extraEnv,
      hostEnv: input.hostEnv,
    });
    const secrets = secretValuesOf({ ...input.extraEnv, ...sessionEnv });
    // Capture the exact fields before filesystem awaits. A changed original binding
    // refuses before spawn without evaluating a replacement field or accessor.
    const invocation={
      file: input.bin,
      args:[...argv],
      cwd: input.work,
      env,
      timeoutMs: o.timeoutMs ?? input.limits.timeoutMs,
      graceMs: input.graceMs,
      maxOutputBytes: input.limits.maxOutputBytes,
      captureStdoutBytes: o.captureStdoutBytes,
      signal: input.signal,
    };
    const sessionAbsent=input.session===undefined;
    if(native && !await originalFilesMatch(native,invocation.cwd))throw new Error("Standalone command configuration changed.");
    let originalSha:string|undefined;
    if(native && command==="apply" && argv[argv.length-1]===ORIGINAL_PLAN_FILE) {
      originalSha=await nativePlanSha(invocation.cwd,ORIGINAL_PLAN_FILE);
    }
    if(native&&originalRun(this)!==native)throw new Error("Canonical standalone command origin changed before launch.");
    const raw=await (native?canonicalRunProcess:runProcess)(invocation);
    // This private record is minted only after the actual child close/result path.
    // Substituted apply/plan/show methods and copied statuses cannot populate it.
    if(native && originalRun(this)===native && await originalFilesMatch(native,invocation.cwd) && !raw.timedOut && !raw.aborted && !raw.stdoutOverflow && native.commands.length<32 && sessionAbsent) {
      let stateViewDigest:string|undefined,planSha:string|undefined;
      if(command==="plan"&&[0,2].includes(raw.exitCode))planSha=await nativePlanSha(invocation.cwd,PLAN_FILE);
      if(command==="show" && JSON.stringify(argv)===JSON.stringify(["show","-json","-no-color"]) && raw.exitCode===0) {
        try {const state:unknown=JSON.parse(raw.stdout??"");if(state&&typeof state==="object"&&!Array.isArray(state))stateViewDigest=createHash("sha256").update(JSON.stringify(state)).digest("hex");}catch { /* No readback identity on malformed native output. */ }
      }
      if(originalRun(this)===native)native.commands.push(Object.freeze({command,args:argv,exitCode:raw.exitCode,originalSha,planSha,stateViewDigest}));
    }
    let text = raw.output;
    let diagnostics: PlanDiagnostic[] = [];
    if (o.uiStream) {
      const rendered = renderUiStream(raw.output);
      text = rendered.text;
      diagnostics = rendered.diagnostics;
    }
    const result: TofuRunResult = {
      command,
      exitCode: raw.exitCode,
      output: redactOutput(text, secrets),
      truncated: raw.truncated,
      durationMs: raw.durationMs,
    };
    diagnostics = diagnostics.map((d) => ({
      severity: d.severity,
      summary: redactOutput(d.summary, secrets),
      ...(d.detail ? { detail: redactOutput(d.detail, secrets) } : {}),
    }));
    if (raw.timedOut) throw new TofuCommandError("tofu_timeout", `tofu ${command} timed out after ${invocation.timeoutMs} ms.`, result);
    if (raw.aborted) throw new TofuCommandError("tofu_aborted", `tofu ${command} was aborted.`, result);
    if (raw.stdoutOverflow) throw new TofuCommandError("tofu_output_overflow", `tofu ${command} produced more structured output than the ${o.captureStdoutBytes} byte cap.`, result);
    const ok = o.okExitCodes ?? [0];
    if (!o.allowFailure && !ok.includes(raw.exitCode)) {
      throw new TofuCommandError("tofu_command_failed", `tofu ${command} failed with exit code ${raw.exitCode}.`, result);
    }
    return { result, stdout: raw.stdout, diagnostics, raw };
  }

  /** `tofu init -input=false -lockfile=readonly`. */
  async init(opts: { backend?: boolean } = {}): Promise<TofuRunResult> {
    checkedRun(this);
    const args = ["init", "-input=false", "-no-color", "-lockfile=readonly"];
    if (opts.backend === false) args.push("-backend=false");
    return (await this.command("init", args)).result;
  }

  /** `tofu validate -json`. An invalid configuration is a result, not an exception. */
  async validate(): Promise<{ result: TofuRunResult; valid: boolean; diagnostics: PlanDiagnostic[] }> {
    checkedRun(this);
    const out = await this.command("validate", ["validate", "-json", "-no-color"], { okExitCodes: [0, 1], captureStdoutBytes: MAX_OUTPUT_JSON_BYTES });
    let valid = false;
    const diagnostics: PlanDiagnostic[] = [];
    try {
      const parsed = JSON.parse(out.stdout ?? "") as { valid?: boolean; diagnostics?: { severity?: string; summary?: string; detail?: string }[] };
      valid = parsed.valid === true;
      for (const d of parsed.diagnostics ?? []) {
        if (typeof d.summary !== "string") continue;
        diagnostics.push({
          severity: d.severity === "error" ? "error" : "warning",
          summary: redactOutput(d.summary),
          ...(d.detail ? { detail: redactOutput(d.detail) } : {}),
        });
      }
    } catch {
      valid = false;
    }
    return { result: out.result, valid, diagnostics };
  }

  /**
   * `tofu plan -out=tfplan …`; exit 0 = no changes, 2 = changes, anything else throws.
   *
   * `lock: false` skips OpenTofu's state lock. Only the observe-purpose plan
   * uses it: the read-only role cannot write the S3 lock object, and every
   * plan and apply of an environment already runs under Zenith's fenced
   * `env:<id>` lease, which is the lock that actually serialises mutations.
   * Apply always locks.
   */
  async plan(opts: { lock?: boolean; destroy?: boolean } = {}): Promise<{ result: TofuRunResult; hasChanges: boolean; diagnostics: PlanDiagnostic[] }> {
    checkedRun(this);
    const lockArgs = opts.lock === false ? ["-lock=false"] : ["-lock-timeout=60s"];
    const out = await this.command("plan", ["plan", ...(opts.destroy ? ["-destroy"] : []), `-out=${PLAN_FILE}`, "-input=false", "-detailed-exitcode", ...lockArgs, "-no-color", "-json"], {
      okExitCodes: [0, 2],
      uiStream: true,
    });
    checkedRun(this);
    this.lastDiagnostics = out.diagnostics;
    return { result: out.result, hasChanges: out.result.exitCode === 2, diagnostics: out.diagnostics };
  }

  /** `tofu show -json tfplan`, parsed. The raw document contains unmasked values: never log or return it. */
  async showJson(file: typeof PLAN_FILE | typeof ORIGINAL_PLAN_FILE = PLAN_FILE): Promise<{ result: TofuRunResult; json: ShowJson }> {
    checkedRun(this);
    const out = await this.command("show", ["show", "-json", "-no-color", file], { captureStdoutBytes: MAX_SHOW_JSON_BYTES });
    const json = parseShowJson(out.stdout ?? "");
    return { result: out.result, json };
  }

  /** Read and normalize the current plan file with this workspace's context. */
  async normalizedPlan(base: PlanNormalizeBase = {}, inspect?: PlanInspector, file: typeof PLAN_FILE | typeof ORIGINAL_PLAN_FILE = PLAN_FILE): Promise<NormalizedPlan> {
    const native=checkedRun(this),input=native?native.init:this.i;
    const { json } = await this.showJson(file);
    checkedRun(this);
    const sessionEnv = input.session?.childProcessEnv?.() ?? {};
    const plan = normalizePlan(json, {
      configDigest: input.ws.configDigest,
      lockDigest: input.ws.lockDigest,
      addressMap: input.ws.addressMap,
      diagnostics: this.lastDiagnostics,
      secrets: secretValuesOf({ ...input.extraEnv, ...sessionEnv }),
      ...base,
    });
    await inspect?.(plan, json);
    return plan;
  }

  /**
   * The binary plan file produced in THIS run. Callers keep it server-side; it
   * is not model-visible. There is deliberately no way to install a plan file
   * from elsewhere: a saved plan embeds its own configuration, so applying one
   * that this run's workspace did not produce would bypass `configDigest`.
   */
  async readPlanFile(file: typeof PLAN_FILE | typeof ORIGINAL_PLAN_FILE = PLAN_FILE): Promise<Buffer> {
    const native=checkedRun(this),work=native?native.init.work:this.i.work;
    const handle = await open(path.join(work, file), "r");
    try {
      const size = (await handle.stat()).size;
      if (size < 1 || size > MAX_PLAN_BYTES) throw new Error("Binary plan exceeds its size bound.");
      const bytes = await handle.readFile();
      if (bytes.length !== size || bytes.length > MAX_PLAN_BYTES) throw new Error("Binary plan changed while being read.");
      return bytes;
    } finally { await handle.close(); }
  }

  /** Only the trusted engine calls this after authenticating the producer receipt. Never a caller pathname. */
  async installReviewedPlan(bytes: Buffer): Promise<void> {
    const native=checkedRun(this),work=native?native.init.work:this.i.work;
    if (bytes.length < 1 || bytes.length > MAX_PLAN_BYTES) throw new Error("Binary plan exceeds its size bound.");
    await writeFile(path.join(work, ORIGINAL_PLAN_FILE), bytes, { flag: "wx", mode: 0o600 });
  }

  async planFileSha(file: typeof PLAN_FILE | typeof ORIGINAL_PLAN_FILE = PLAN_FILE): Promise<string> {
    checkedRun(this);
    const bytes=await this.readPlanFile(file);
    checkedRun(this);
    return createHash("sha256").update(bytes).digest("hex");
  }

  /**
   * Apply the saved plan — but only if `show -json` on that very file still
   * normalizes to `expectedPlanDigest`. A different digest throws
   * `TofuPlanChangedError` before anything is applied.
   */
  async apply(args: { expectedPlanDigest: string; normalize?: PlanNormalizeBase; inspectPlan?: PlanInspector; originalSha256?: string; beforeDispatch?: () => Promise<void> }): Promise<{ result: TofuRunResult; plan: NormalizedPlan }> {
    checkedRun(this);
    const file = args.originalSha256 ? ORIGINAL_PLAN_FILE : PLAN_FILE;
    const before = await this.planFileSha(file);
    checkedRun(this);
    if (args.originalSha256 && before !== args.originalSha256) throw new Error("Reviewed plan integrity check failed.");
    const plan = await this.normalizedPlan(args.normalize, async (current, raw) => {
      if (current.planDigest !== args.expectedPlanDigest) throw new TofuPlanChangedError(args.expectedPlanDigest, current.planDigest);
      await args.inspectPlan?.(current, raw);
    }, file);
    checkedRun(this);
    if (plan.planDigest !== args.expectedPlanDigest) throw new TofuPlanChangedError(args.expectedPlanDigest, plan.planDigest);
    await args.beforeDispatch?.();
    checkedRun(this);
    const after=await this.planFileSha(file);
    checkedRun(this);
    if (after !== before) {
      throw new TofuCommandError("tofu_command_failed", "The saved plan file changed while it was being verified; refusing to apply.", {
        command: "apply",
        exitCode: -1,
        output: "",
        truncated: false,
        durationMs: 0,
      });
    }
    const out = await this.command("apply", ["apply", "-input=false", "-lock-timeout=60s", "-no-color", "-json", file], { uiStream: true });
    checkedRun(this);
    this.lastDiagnostics = out.diagnostics;
    return { result: out.result, plan };
  }

  /**
   * `tofu output -json`. Sensitive values are dropped unless the caller opts in;
   * the values that remain are data from the cloud, never instructions.
   */
  async output(opts: { includeSensitive?: boolean } = {}): Promise<Record<string, { sensitive: boolean; type: unknown; value?: unknown }>> {
    checkedRun(this);
    const out = await this.command("output", ["output", "-json", "-no-color"], { captureStdoutBytes: MAX_OUTPUT_JSON_BYTES });
    let parsed: Record<string, { sensitive?: boolean; type?: unknown; value?: unknown }>;
    try {
      parsed = JSON.parse(out.stdout ?? "{}");
    } catch {
      throw new TofuCommandError("tofu_command_failed", "`tofu output -json` did not return JSON.", out.result);
    }
    const result: Record<string, { sensitive: boolean; type: unknown; value?: unknown }> = {};
    for (const name of Object.keys(parsed).sort()) {
      const o = parsed[name];
      const sensitive = o.sensitive === true;
      result[name] = sensitive && !opts.includeSensitive ? { sensitive, type: o.type } : { sensitive, type: o.type, value: o.value };
    }
    return result;
  }

  /** Current state stays private. Only a bounded digest leaves this fixed readback command. */
  async currentStateDigest(): Promise<string> {
    checkedRun(this);
    const out = await this.command("show", ["show", "-json", "-no-color"], { captureStdoutBytes: MAX_SHOW_JSON_BYTES });
    let parsed: unknown;
    try { parsed = JSON.parse(out.stdout ?? ""); } catch { throw new Error("Standalone state readback is unavailable."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Standalone state readback is unavailable.");
    // No raw state or command output enters the terminal witness or activity result.
    return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  }

  async dispose(): Promise<void> {
    const native=originalRun(this);
    if(nativeRuns.has(this)&&!native)throw new Error("Canonical standalone cleanup origin changed.");
    if (this.disposed) return;
    const root=native?native.init.root:this.i.root;
    this.disposed = true;
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      try { await lstat(root); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && (!native || originalRun(this)===native)) cleanedRuns.add(this);
      }
    } catch { /* Legacy disposal remains best effort; settlement requires the private observation. */ }
  }

}

interface PrototypeShape { parent:object|null; descriptors:PropertyDescriptorMap }
function samePrototype(value:object,shape:PrototypeShape):boolean {
  if(Object.getPrototypeOf(value)!==shape.parent || Reflect.ownKeys(value).length!==Reflect.ownKeys(shape.descriptors).length)return false;
  for(const key of Reflect.ownKeys(shape.descriptors)) {
    const saved=Object.getOwnPropertyDescriptor(shape.descriptors,key)?.value,current=Object.getOwnPropertyDescriptor(value,key);
    if(!saved || !current || current.value!==saved.value || current.get!==saved.get || current.set!==saved.set
      || current.writable!==saved.writable || current.enumerable!==saved.enumerable || current.configurable!==saved.configurable)return false;
  }
  return true;
}
const runnerPrototype:PrototypeShape={parent:Object.getPrototypeOf(TofuRunner.prototype),descriptors:Object.getOwnPropertyDescriptors(TofuRunner.prototype)};
const runPrototype:PrototypeShape={parent:Object.getPrototypeOf(TofuRun.prototype),descriptors:Object.getOwnPropertyDescriptors(TofuRun.prototype)};
