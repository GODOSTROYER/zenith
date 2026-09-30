/**
 * Lockfile generation: `tofu providers lock` for a provider set across every
 * platform in `LOCK_PLATFORMS`, in a throw-away directory containing only a
 * minimal `required_providers` config. Used by `scripts/lock.ts` (regenerate
 * the committed lockfiles) and `TofuRunner.providersLock`.
 *
 * This needs network access to registry.opentofu.org and the provider release
 * hosts (the cloud providers are 100+ MB per platform), and downloads each
 * platform's package to compute its `h1:` hash.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "@/lib/tofu/env";
import { runProcess } from "@/lib/tofu/process";
import { LOCK_PLATFORMS, requiredProviders, type ProviderLocalName } from "@/lib/tofu/providers";
import { redactOutput } from "@/lib/tofu/redact";
import { stableJson } from "@/lib/tofu/stable";
import type { TofuRunResult } from "@/lib/tofu/types";

export interface GenerateLockfileOptions {
  bin: string;
  providers: readonly ProviderLocalName[];
  platforms?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class TofuLockError extends Error {
  readonly code = "tofu_lock_failed";
  constructor(
    message: string,
    readonly result: TofuRunResult
  ) {
    super(message);
  }
}

export async function generateLockfile(opts: GenerateLockfileOptions): Promise<{ lockfile: string; result: TofuRunResult }> {
  const platforms = opts.platforms ?? LOCK_PLATFORMS;
  const root = await mkdtemp(path.join(os.tmpdir(), "zenith-tofu-lock-"));
  try {
    const work = path.join(root, "work");
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    for (const d of [work, home, tmp]) await mkdir(d, { recursive: true });
    const cli = path.join(root, "tofu.rc");
    await writeFile(cli, "");
    await writeFile(
      path.join(work, "versions.tf.json"),
      stableJson({ terraform: { required_providers: requiredProviders(opts.providers) } })
    );
    const env = buildChildEnv({ homeDir: home, tmpDir: tmp, cliConfigFile: cli, pluginCacheDir: path.join(root, "cache") });
    const res = await runProcess({
      file: opts.bin,
      args: ["providers", "lock", "-no-color", ...platforms.map((p) => `-platform=${p}`)],
      cwd: work,
      env,
      timeoutMs: opts.timeoutMs ?? 20 * 60_000,
      maxOutputBytes: 256 * 1024,
      signal: opts.signal,
      redact: (t) => redactOutput(t),
    });
    const result: TofuRunResult = {
      command: "providers-lock",
      exitCode: res.exitCode,
      output: res.output,
      truncated: res.truncated,
      durationMs: res.durationMs,
    };
    if (res.exitCode !== 0 || res.timedOut || res.aborted) {
      throw new TofuLockError(`tofu providers lock failed (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}).`, result);
    }
    const lockfile = await readFile(path.join(work, ".terraform.lock.hcl"), "utf8");
    return { lockfile, result };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
