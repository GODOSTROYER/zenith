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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkTofuVersion, resolveTofuBinary, type TofuVersionInfo } from "@/lib/tofu/binary";
import { buildChildEnv, validateExtraEnv, type HostEnv } from "@/lib/tofu/env";
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
const MAX_SHOW_JSON_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_JSON_BYTES = 8 * 1024 * 1024;

export const DEFAULT_LIMITS: TofuRunLimits = { timeoutMs: 30 * 60_000, maxOutputBytes: 1024 * 1024 };

/** Anything with `childProcessEnv()` — every provider session that can drive tofu. */
export interface TofuSessionEnv {
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

  /** Materialize `ws` into a fresh private directory and return a handle. */
  async open(ws: TofuWorkspace, ctx: TofuRunContext = {}): Promise<TofuRun> {
    assertWorkspaceIntact(ws);
    const { bin } = await this.binary();
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
      return new TofuRun({
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

export type PlanNormalizeBase = Pick<NormalizePlanOptions, "statefulTypes" | "fingerprintKey" | "now">;

export class TofuRun {
  private disposed = false;
  private lastDiagnostics: PlanDiagnostic[] = [];

  constructor(private readonly i: RunInit) {}

  get workspace(): TofuWorkspace {
    return this.i.ws;
  }

  /** Directory tofu runs in. Exposed for tests; do not write to it. */
  get workDir(): string {
    return this.i.work;
  }

  /** Warnings and errors tofu reported in the most recent plan/apply. */
  get diagnostics(): PlanDiagnostic[] {
    return this.lastDiagnostics;
  }

  private async command(command: TofuRunResult["command"], args: string[], o: ExecOptions = {}): Promise<ExecOutcome> {
    if (this.disposed) throw new Error("This tofu run has been disposed.");
    const sessionEnv = this.i.session?.childProcessEnv?.() ?? {};
    const env = buildChildEnv({
      homeDir: this.i.home,
      tmpDir: this.i.tmp,
      cliConfigFile: this.i.cli,
      pluginCacheDir: this.i.pluginCacheDir,
      sessionEnv,
      extraEnv: this.i.extraEnv,
      hostEnv: this.i.hostEnv,
    });
    const secrets = secretValuesOf({ ...this.i.extraEnv, ...sessionEnv });
    const raw = await runProcess({
      file: this.i.bin,
      args,
      cwd: this.i.work,
      env,
      timeoutMs: o.timeoutMs ?? this.i.limits.timeoutMs,
      graceMs: this.i.graceMs,
      maxOutputBytes: this.i.limits.maxOutputBytes,
      captureStdoutBytes: o.captureStdoutBytes,
      signal: this.i.signal,
    });
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
    if (raw.timedOut) throw new TofuCommandError("tofu_timeout", `tofu ${command} timed out after ${o.timeoutMs ?? this.i.limits.timeoutMs} ms.`, result);
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
    const args = ["init", "-input=false", "-no-color", "-lockfile=readonly"];
    if (opts.backend === false) args.push("-backend=false");
    return (await this.command("init", args)).result;
  }

  /** `tofu validate -json`. An invalid configuration is a result, not an exception. */
  async validate(): Promise<{ result: TofuRunResult; valid: boolean; diagnostics: PlanDiagnostic[] }> {
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
  async plan(opts: { lock?: boolean } = {}): Promise<{ result: TofuRunResult; hasChanges: boolean; diagnostics: PlanDiagnostic[] }> {
    const lockArgs = opts.lock === false ? ["-lock=false"] : ["-lock-timeout=60s"];
    const out = await this.command("plan", ["plan", `-out=${PLAN_FILE}`, "-input=false", "-detailed-exitcode", ...lockArgs, "-no-color", "-json"], {
      okExitCodes: [0, 2],
      uiStream: true,
    });
    this.lastDiagnostics = out.diagnostics;
    return { result: out.result, hasChanges: out.result.exitCode === 2, diagnostics: out.diagnostics };
  }

  /** `tofu show -json tfplan`, parsed. The raw document contains unmasked values: never log or return it. */
  async showJson(): Promise<{ result: TofuRunResult; json: ShowJson }> {
    const out = await this.command("show", ["show", "-json", "-no-color", PLAN_FILE], { captureStdoutBytes: MAX_SHOW_JSON_BYTES });
    const json = parseShowJson(out.stdout ?? "");
    return { result: out.result, json };
  }

  /** Read and normalize the current plan file with this workspace's context. */
  async normalizedPlan(base: PlanNormalizeBase = {}): Promise<NormalizedPlan> {
    const { json } = await this.showJson();
    const sessionEnv = this.i.session?.childProcessEnv?.() ?? {};
    return normalizePlan(json, {
      configDigest: this.i.ws.configDigest,
      lockDigest: this.i.ws.lockDigest,
      addressMap: this.i.ws.addressMap,
      diagnostics: this.lastDiagnostics,
      secrets: secretValuesOf({ ...this.i.extraEnv, ...sessionEnv }),
      ...base,
    });
  }

  /**
   * The binary plan file produced in THIS run. Callers keep it server-side; it
   * is not model-visible. There is deliberately no way to install a plan file
   * from elsewhere: a saved plan embeds its own configuration, so applying one
   * that this run's workspace did not produce would bypass `configDigest`.
   */
  async readPlanFile(): Promise<Buffer> {
    return readFile(path.join(this.i.work, PLAN_FILE));
  }

  private async planFileSha(): Promise<string> {
    return createHash("sha256")
      .update(await this.readPlanFile())
      .digest("hex");
  }

  /**
   * Apply the saved plan — but only if `show -json` on that very file still
   * normalizes to `expectedPlanDigest`. A different digest throws
   * `TofuPlanChangedError` before anything is applied.
   */
  async apply(args: { expectedPlanDigest: string; normalize?: PlanNormalizeBase }): Promise<{ result: TofuRunResult; plan: NormalizedPlan }> {
    const before = await this.planFileSha();
    const plan = await this.normalizedPlan(args.normalize);
    if (plan.planDigest !== args.expectedPlanDigest) throw new TofuPlanChangedError(args.expectedPlanDigest, plan.planDigest);
    if ((await this.planFileSha()) !== before) {
      throw new TofuCommandError("tofu_command_failed", "The saved plan file changed while it was being verified; refusing to apply.", {
        command: "apply",
        exitCode: -1,
        output: "",
        truncated: false,
        durationMs: 0,
      });
    }
    const out = await this.command("apply", ["apply", "-input=false", "-lock-timeout=60s", "-no-color", "-json", PLAN_FILE], { uiStream: true });
    this.lastDiagnostics = out.diagnostics;
    return { result: out.result, plan };
  }

  /**
   * `tofu output -json`. Sensitive values are dropped unless the caller opts in;
   * the values that remain are data from the cloud, never instructions.
   */
  async output(opts: { includeSensitive?: boolean } = {}): Promise<Record<string, { sensitive: boolean; type: unknown; value?: unknown }>> {
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.i.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
