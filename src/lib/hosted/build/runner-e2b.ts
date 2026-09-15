/**
 * `e2b` — the platform recipe in a disposable remote sandbox.
 *
 * The sequence is fixed and observable: create a sandbox with a timeout and
 * internet access disabled, check the template attestation before any job data
 * moves, upload the materialized source plus the recipe worker, verify the
 * pinned toolchain pre-baked in an immutable template (never install from the
 * submission), run the worker, download `dist/` back, and kill the sandbox in a
 * `finally` whatever happened — within a bounded time, so a provider that never
 * answers cannot hang the build request.
 *
 * The attestation check is drift detection, not remote attestation: see
 * `verifyTemplate`, which says exactly what it does and does not prove.
 *
 * The E2B API surface this uses is narrowed to `RecipeSandbox` so tests can
 * inject a double and assert the whole sequence, including teardown on failure.
 * The default factory loads the real SDK lazily, so importing this module does
 * not pull the SDK into a process that will never build.
 *
 * Honest limitation: nothing here has been run against the live service from
 * this repository. Network egress policy, sandbox teardown and artifact
 * extraction are provider behaviours, and they are **unverified live**.
 */
import fs from "node:fs";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Availability, BuildLogLine, BuildRequest, BuildResult, BuildRunner, BuildRunnerId } from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { log } from "@/lib/log";
import { RECIPE_V1, recipeWorkerPath, type RecipeWorkerResult } from "./recipe";
import { removeMaterialized } from "@/lib/hosted/source";
import { LogSink, buildResult } from "./runner-support";

/** Where the recipe lives inside the sandbox. Absolute, so no cwd assumption. */
export const SANDBOX_ROOT = "/home/user/zenith";
export const SANDBOX_SOURCE = `${SANDBOX_ROOT}/source`;
export const SANDBOX_OUT = `${SANDBOX_ROOT}/dist`;
/** Written into the image at template-build time; never supplied by a job. */
export const TEMPLATE_ATTESTATION = "/etc/zenith/template-attestation.json";

/**
 * The environment variable naming the key the attestation must be signed under.
 *
 * Proposed for `src/lib/hosted/config.ts` (not this packet's file to edit), so
 * it is read from `process.env` here and validated in one place.
 */
export const ATTESTATION_KEY_ID_ENV = "ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID";

/** How long a `sandbox.kill()` may take before the build stops waiting for it. */
export const SANDBOX_KILL_TIMEOUT_MS = 10_000;

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** An ISO-8601 instant in UTC. Nothing else is accepted, so there is one reading. */
const EXPIRES_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface TemplateAttestation {
  templateId: string;
  digest: string;
  /** which publisher key signed this; must equal ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID */
  keyId: string;
  /** ISO-8601 UTC instant after which this statement is refused */
  expiresAt: string;
  signature: string;
}

/**
 * Canonical bytes signed by the trusted template publisher.
 *
 * The first line is domain separation: it pins the scheme version, so a
 * signature minted for the earlier two-field payload cannot be replayed as a
 * key-id-and-expiry-bearing one. Every other field is newline-free by the time
 * it reaches here — `templateId` and `digest` are checked against values zod
 * has already constrained, `keyId` against `KEY_ID_RE`, `expiresAt` against
 * `EXPIRES_AT_RE` — so the separator cannot be smuggled inside a field.
 */
export const ATTESTATION_SCHEME = "zenith-e2b-template-attestation-v2";
export const templateAttestationPayload = (
  attestation: Pick<TemplateAttestation, "templateId" | "digest" | "keyId" | "expiresAt">
): string =>
  `${ATTESTATION_SCHEME}\n${attestation.templateId}\n${attestation.digest}\n${attestation.keyId}\n${attestation.expiresAt}\n`;

/** The configured attestation key id, or undefined when unset or malformed. */
export function attestationKeyId(raw: string | undefined = process.env[ATTESTATION_KEY_ID_ENV]): string | undefined {
  const value = (raw ?? "").trim();
  return KEY_ID_RE.test(value) ? value : undefined;
}

/** A build that stopped because its caller aborted, not because it failed. */
class BuildCancelled extends Error {
  constructor() {
    super("The build was cancelled; the sandbox was killed.");
    this.name = "BuildCancelled";
  }
}

/** The slice of the E2B `Sandbox` this runner uses. Kept small so a double is honest. */
export interface RecipeSandbox {
  sandboxId: string;
  files: {
    write(files: { path: string; data: string | ArrayBuffer }[]): Promise<unknown>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
    list(path: string, opts?: { depth?: number }): Promise<{ name: string; path: string; type?: string }[]>;
  };
  commands: {
    run(
      cmd: string,
      opts?: {
        cwd?: string;
        timeoutMs?: number;
        onStdout?: (d: string) => void;
        onStderr?: (d: string) => void;
        /**
         * Forwarded on every call. An SDK that honours it stops the remote
         * command; one that ignores it costs nothing, because the runner also
         * stops waiting on abort and the `finally` kills the sandbox.
         */
        signal?: AbortSignal;
      }
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  /** Required from the real E2B SDK so the resolved image is independently checked. */
  getInfo: () => Promise<{ templateId: string }>;
  kill(): Promise<boolean>;
}

/** How a sandbox is obtained. The default asks the real SDK; tests pass a double. */
export type SandboxFactory = (opts: {
  apiKey: string;
  timeoutMs: number;
  template: string;
  allowInternetAccess: false;
}) => Promise<RecipeSandbox>;

/**
 * The real factory: `Sandbox.create` from the `e2b` SDK, imported at call time.
 * The template ID is immutable and contains the pinned recipe toolchain. The
 * build never installs packages from the submitted source, and internet access
 * is explicitly disabled for the sandbox. Provider-side enforcement still has
 * to be proven in a disposable live lane.
 */
export const defaultSandboxFactory: SandboxFactory = async ({ apiKey, timeoutMs, template, allowInternetAccess }) => {
  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.create({ apiKey, timeoutMs, template, allowInternetAccess });
  const getInfo = (sandbox as { getInfo?: unknown }).getInfo;
  if (typeof getInfo !== "function")
    throw new Error("The E2B SDK did not expose the resolved template ID; refusing to build without provider identity verification.");
  // Preserve SDK methods that may live on the sandbox prototype; spreading the
  // SDK object would silently drop those methods before the first build step.
  return Object.assign(sandbox, { getInfo: getInfo.bind(sandbox) }) as RecipeSandbox;
};

export interface E2bOptions {
  createSandbox?: SandboxFactory;
  /** absolute path of the worker script uploaded into the sandbox */
  workerPath?: string;
  /** absolute path of the config module the worker imports */
  configPath?: string;
  /** how long teardown may take before the build stops waiting for it */
  killTimeoutMs?: number;
}

const toArrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export class E2bRunner implements BuildRunner {
  readonly id: BuildRunnerId = "e2b";
  readonly label = "Platform recipe in an E2B sandbox";
  readonly boundary =
    "Runs the platform's Vite recipe inside a disposable remote E2B sandbox, created from a bare immutable template ID with internet access disabled, and killed on every path. Before any job data is uploaded the runner checks a statement stored in the template that binds that template ID to a digest, signed under a named key and carrying an expiry. That is drift detection, not measurement: the digest is a value declared inside the image, never computed over the image's bytes, so it detects a wrong, replaced, unsigned or expired template and proves nothing against the provider itself. No submitted script or config is executed. Provider-side egress and teardown remain unverified live in this repository.";

  private readonly createSandbox: SandboxFactory;
  private readonly workerPath: string;
  private readonly configPath: string;
  private readonly killTimeoutMs: number;

  constructor(options: E2bOptions = {}) {
    this.createSandbox = options.createSandbox ?? defaultSandboxFactory;
    this.workerPath = options.workerPath ?? recipeWorkerPath();
    this.configPath = options.configPath ?? path.join(path.dirname(this.workerPath), "recipe-config.mjs");
    this.killTimeoutMs = options.killTimeoutMs ?? SANDBOX_KILL_TIMEOUT_MS;
  }

  async availability(): Promise<Availability> {
    const selected = hostedConfig().ZENITH_BUILD_RUNNER;
    if (selected !== "e2b")
      return {
        available: false,
        reason: `ZENITH_BUILD_RUNNER is "${selected}", so builds are not sent to E2B.`,
        fix: "Set ZENITH_BUILD_RUNNER=e2b to build in a disposable remote sandbox.",
      };
    const key = process.env.E2B_API_KEY;
    if (!key || key.trim() === "")
      return {
        available: false,
        reason: "E2B_API_KEY is not set, so no sandbox can be created.",
        fix: "Put an E2B API key in E2B_API_KEY in .env.local and restart the server, or choose another runner with ZENITH_BUILD_RUNNER.",
      };
    if (!fs.existsSync(this.workerPath) || !fs.existsSync(this.configPath))
      return {
        available: false,
        reason: `The recipe worker or its config module is not on disk (${this.workerPath}).`,
        fix: "Ship src/lib/hosted/build/recipe-worker.mjs and recipe-config.mjs beside the server.",
      };
    if (!hostedConfig().ZENITH_E2B_TEMPLATE)
      return {
        available: false,
        reason: "ZENITH_E2B_TEMPLATE is not set, so the runner cannot select an immutable toolchain image.",
        fix: "Build and attest a template containing the pinned recipe toolchain, then set ZENITH_E2B_TEMPLATE to its bare immutable ID.",
      };
    if (!hostedConfig().ZENITH_E2B_TEMPLATE_DIGEST)
      return {
        available: false,
        reason: "ZENITH_E2B_TEMPLATE_DIGEST is not set, so the runner cannot verify the pre-baked template attestation.",
        fix: "Set ZENITH_E2B_TEMPLATE_DIGEST to the sha256:<64-hex> digest recorded in the template attestation.",
      };
    if (!hostedConfig().ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY)
      return {
        available: false,
        reason: "ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY is not set, so the runner cannot authenticate the template attestation.",
        fix: "Set it to the trusted Ed25519 publisher public key used to sign the template attestation.",
      };
    const keyId = attestationKeyId();
    if (!keyId)
      return {
        available: false,
        reason: `${ATTESTATION_KEY_ID_ENV} is not set, so a signature made under any key the operator ever trusted would be accepted.`,
        fix: `Set ${ATTESTATION_KEY_ID_ENV} to the key id recorded in the template attestation (letters, digits, dot, dash or underscore, up to 64 characters). Rotating a key means changing this and the public key together.`,
      };
    return { available: true };
  }

  /**
   * What this check is, exactly.
   *
   * It reads a JSON statement stored in the template and requires it to name
   * the configured template ID and digest, to be signed under the configured
   * key id by the configured Ed25519 public key, and to have an expiry that has
   * not passed. Then it asks the provider which template it actually resolved
   * and requires the same ID.
   *
   * What that buys: a template that is the wrong one, is a rebuild that lost
   * the statement, was signed under a retired key, or whose signature is past
   * its stated life, is refused before any job data is uploaded.
   *
   * What it does NOT buy, and must not be described as buying: the digest is a
   * string the image declares about itself. Nothing computes it over the
   * image's bytes or its package set, so an image carrying a byte-for-byte copy
   * of a valid statement passes. Against a malicious or compromised provider
   * this check is worth nothing; against drift and misconfiguration it is worth
   * a great deal. Binding it to something measurable is open work.
   */
  private async verifyTemplate(sandbox: RecipeSandbox, now: number = Date.now()): Promise<void> {
    const config = hostedConfig();
    // Constructed before the signature check, so an operator with a mis-pasted
    // PEM is told their key is unreadable instead of being told an attacker
    // signed their template (REVIEW-D FIND-16).
    let publicKey;
    try {
      publicKey = createPublicKey(config.ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY!);
    } catch (err) {
      throw new Error(
        `ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY could not be read as a public key: ${err instanceof Error ? err.message : String(err)}. Fix: set it to the publisher's Ed25519 public key in PEM form, newlines included.`
      );
    }
    const keyId = attestationKeyId();
    if (!keyId)
      throw new Error(`${ATTESTATION_KEY_ID_ENV} is not set, so the attestation's key id cannot be checked.`);

    const raw = await sandbox.files.read(TEMPLATE_ATTESTATION, { format: "bytes" });
    let attestation: TemplateAttestation;
    try {
      attestation = JSON.parse(Buffer.from(raw).toString("utf8")) as TemplateAttestation;
    } catch {
      throw new Error(`The E2B template is missing a valid ${TEMPLATE_ATTESTATION} attestation.`);
    }
    if (attestation.templateId !== config.ZENITH_E2B_TEMPLATE)
      throw new Error("The E2B template attestation does not match the configured immutable template ID.");
    if (attestation.digest !== config.ZENITH_E2B_TEMPLATE_DIGEST)
      throw new Error("The E2B template attestation digest does not match ZENITH_E2B_TEMPLATE_DIGEST.");
    if (attestation.keyId !== keyId)
      throw new Error(
        `The E2B template attestation was signed under key id ${JSON.stringify(String(attestation.keyId ?? ""))}, not the trusted ${keyId}.`
      );
    // Fail closed on expiry: absent, unparseable and past are one answer.
    if (typeof attestation.expiresAt !== "string" || !EXPIRES_AT_RE.test(attestation.expiresAt))
      throw new Error(
        "The E2B template attestation has no usable expiry. Fix: re-sign the template attestation with an expiresAt in ISO-8601 UTC, such as 2027-01-31T00:00:00Z."
      );
    const expiresAt = Date.parse(attestation.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now)
      throw new Error(
        `The E2B template attestation expired at ${attestation.expiresAt}. Fix: re-sign the template attestation with a later expiry, or rebuild and re-attest the template.`
      );
    if (typeof attestation.signature !== "string" || !attestation.signature)
      throw new Error("The E2B template attestation has no publisher signature.");
    let valid = false;
    try {
      valid = verifySignature(
        null,
        Buffer.from(templateAttestationPayload(attestation)),
        publicKey,
        Buffer.from(attestation.signature, "base64")
      );
    } catch {
      valid = false;
    }
    if (!valid) throw new Error("The E2B template attestation is not signed by the trusted publisher key.");

    if (typeof (sandbox as { getInfo?: unknown }).getInfo !== "function")
      throw new Error("The E2B sandbox did not expose the resolved template ID; refusing to build without provider identity verification.");
    const info = await sandbox.getInfo();
    if (!info || typeof info.templateId !== "string" || info.templateId !== config.ZENITH_E2B_TEMPLATE)
      throw new Error("E2B resolved a different template ID than the configured immutable template ID.");
  }

  /**
   * Run one command in the sandbox, giving up the moment the caller aborts.
   *
   * The signal is forwarded to the SDK as well, but the guarantee does not
   * depend on the SDK honouring it: on abort this rejects, `run()` stops, and
   * the `finally` kills the sandbox — which is what actually stops the remote
   * work and the billing for it.
   */
  private async runInSandbox(
    sandbox: RecipeSandbox,
    cmd: string,
    opts: { cwd: string; timeoutMs: number; onStdout: (d: string) => void; onStderr: (d: string) => void },
    signal: AbortSignal
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (signal.aborted) throw new BuildCancelled();
    let onAbort = (): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => reject(new BuildCancelled());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([sandbox.commands.run(cmd, { ...opts, signal }), cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async run(req: BuildRequest, signal: AbortSignal): Promise<BuildResult> {
    const started = Date.now();
    const sink = new LogSink(req.limits.maxLogBytes);
    const note = (stream: BuildLogLine["stream"], text: string): void => sink.push(stream, `${text}\n`);
    const done = buildResult(sink, this.id, this.boundary, started);

    const availability = await this.availability();
    if (!availability.available)
      return done({ ok: false, error: `${availability.reason} ${availability.fix ?? ""}`.trim() });

    const outDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-dist-"));
    let keepOutput = false;
    let sandbox: RecipeSandbox | undefined;
    try {
      sandbox = await this.createSandbox({
        apiKey: process.env.E2B_API_KEY ?? "",
        timeoutMs: req.limits.timeoutMs,
        template: hostedConfig().ZENITH_E2B_TEMPLATE!,
        allowInternetAccess: false,
      });
      note("info", `Sandbox ${sandbox.sandboxId} created for job ${req.jobId}.`);
      await this.verifyTemplate(sandbox);
      note(
        "info",
        "Checked the provider-resolved template ID against a signed, unexpired attestation before uploading job data. This detects template drift; it does not measure the image."
      );
      if (signal.aborted) return done({ ok: false, error: "The build was cancelled before the sandbox was used." });

      const job = {
        root: SANDBOX_SOURCE,
        outDir: SANDBOX_OUT,
        cacheDir: `${SANDBOX_ROOT}/cache`,
        platformRoot: SANDBOX_ROOT,
        recipe: req.recipe,
      };
      await sandbox.files.write([
        ...req.source.files.map((file) => ({
          path: path.posix.join(SANDBOX_SOURCE, file.path),
          data: toArrayBuffer(file.bytes),
        })),
        { path: `${SANDBOX_ROOT}/recipe-worker.mjs`, data: fs.readFileSync(this.workerPath, "utf8") },
        { path: `${SANDBOX_ROOT}/recipe-config.mjs`, data: fs.readFileSync(this.configPath, "utf8") },
        { path: `${SANDBOX_ROOT}/job.json`, data: JSON.stringify(job) },
      ]);
      note("info", `Uploaded ${req.source.files.length} source files and the recipe worker.`);

      const expected = JSON.stringify({
        vite: RECIPE_V1.vite,
        "@vitejs/plugin-react": RECIPE_V1.pluginReact,
        react: RECIPE_V1.react,
        "react-dom": RECIPE_V1.react,
      });
      const check = `const expected=${expected}; for (const [name, version] of Object.entries(expected)) { const pkg=require(require.resolve(name + "/package.json", { paths: ["${SANDBOX_ROOT}"] })); if (pkg.version !== version) throw new Error(name + "@" + pkg.version + " is not pinned to " + version); }`;
      const toolchain = await this.runInSandbox(
        sandbox,
        `node -e ${JSON.stringify(check)}`,
        {
          cwd: SANDBOX_ROOT,
          timeoutMs: req.limits.timeoutMs,
          onStdout: (d) => note("stdout", d),
          onStderr: (d) => note("stderr", d),
        },
        signal
      );
      if (toolchain.exitCode !== 0)
        return done({
          ok: false,
          error: `The immutable E2B template does not contain the pinned recipe toolchain (exit code ${toolchain.exitCode}). No package installation was attempted.`,
        });

      const worker = await this.runInSandbox(
        sandbox,
        `node ${SANDBOX_ROOT}/recipe-worker.mjs ${SANDBOX_ROOT}/job.json ${SANDBOX_ROOT}/result.json`,
        {
          cwd: SANDBOX_ROOT,
          timeoutMs: req.limits.timeoutMs,
          onStdout: (d) => note("stdout", d),
          onStderr: (d) => note("stderr", d),
        },
        signal
      );

      let result: RecipeWorkerResult | undefined;
      try {
        const raw = await sandbox.files.read(`${SANDBOX_ROOT}/result.json`, { format: "bytes" });
        result = JSON.parse(Buffer.from(raw).toString("utf8")) as RecipeWorkerResult;
      } catch {
        result = undefined;
      }
      if (!result)
        return done({
          ok: false,
          error: `The recipe worker exited with code ${worker.exitCode} without writing a result in the sandbox.`,
        });
      if (!result.ok) return done({ ok: false, error: result.error ?? "The build failed without naming a reason." });

      const entries = await sandbox.files.list(SANDBOX_OUT, { depth: 20 });
      let files = 0;
      for (const entry of entries) {
        if (entry.type === "dir") continue;
        const relative = entry.path.startsWith(`${SANDBOX_OUT}/`) ? entry.path.slice(SANDBOX_OUT.length + 1) : entry.name;
        if (relative.includes("..") || relative.startsWith("/")) continue;
        const bytes = await sandbox.files.read(entry.path, { format: "bytes" });
        const target = path.join(outDir, ...relative.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(bytes));
        files += 1;
      }
      note("info", `Downloaded ${files} output files from the sandbox.`);
      if (!fs.existsSync(path.join(outDir, "index.html")))
        return done({ ok: false, error: "The sandbox build produced no index.html. The artifact was not stored." });

      keepOutput = true;
      return done({ ok: true, outputDir: outDir });
    } catch (err) {
      if (err instanceof BuildCancelled) return done({ ok: false, error: err.message });
      log.warn("hosted build failed", { runner: this.id, jobId: req.jobId, err });
      return done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (sandbox) {
        // Bounded. `finally` blocks the promise this method returns, so an
        // un-timed `kill()` against a provider that never answers hangs the
        // whole build request for as long as the provider likes.
        const sandboxId = sandbox.sandboxId;
        const kill = sandbox.kill();
        // A rejection that arrives after the race has already settled must not
        // surface as an unhandled rejection.
        kill.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            kill,
            new Promise((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`sandbox.kill() did not answer within ${this.killTimeoutMs} ms`)),
                this.killTimeoutMs
              );
            }),
          ]);
        } catch (err) {
          // Known gap: this is the only record. Nothing lists or re-kills a
          // sandbox that survived, so a leak bills until the provider's own
          // timeout — see docs/hosted/PROVIDERS.md.
          log.warn("hosted build sandbox was not torn down", { runner: this.id, jobId: req.jobId, sandboxId, err });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (!keepOutput) removeMaterialized(outDir);
    }
  }
}
