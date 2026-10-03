/**
 * Locating and version-checking the tofu binary.
 *
 * The binary comes from `ZENITH_TOFU_BIN` or a PATH lookup done HERE, in the
 * control-plane process; the child is then spawned by absolute path and never
 * sees the control plane's PATH. `checkTofuVersion` refuses any binary whose
 * `tofu version -json` is not exactly `TOFU_VERSION`: a silently different
 * tofu would change plan output and provider behaviour under an approved
 * digest.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChildEnv, type HostEnv } from "@/lib/tofu/env";
import { runProcess } from "@/lib/tofu/process";
import { TOFU_VERSION } from "@/lib/tofu/types";

export class TofuBinaryError extends Error {
  readonly code: "tofu_binary_missing" | "tofu_version_mismatch";
  constructor(code: TofuBinaryError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the tofu binary to an absolute path. Throws when it cannot be found. */
export function resolveTofuBinary(host: HostEnv = process.env, override?: string): string {
  const configured = override ?? host.ZENITH_TOFU_BIN;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new TofuBinaryError("tofu_binary_missing", "ZENITH_TOFU_BIN must be an absolute path.");
    }
    if (!isExecutableFile(configured)) {
      throw new TofuBinaryError("tofu_binary_missing", `ZENITH_TOFU_BIN does not point at an executable file: ${configured}`);
    }
    return configured;
  }
  const isWin = process.platform === "win32";
  const exts = isWin ? (host.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const dirs = (host.PATH ?? host.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      // only real executables: a .cmd/.bat shim cannot be spawned without a shell
      if (isWin && ![".EXE", ".COM"].includes(ext.toUpperCase())) continue;
      const candidate = path.join(dir, `tofu${ext.toLowerCase()}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  throw new TofuBinaryError("tofu_binary_missing", "OpenTofu was not found: set ZENITH_TOFU_BIN or put `tofu` on PATH.");
}

export interface TofuVersionInfo {
  version: string;
  platform: string;
}

/**
 * Run `tofu version -json` in a throw-away private environment and require the
 * pinned version. Returns the parsed info.
 */
export async function checkTofuVersion(bin: string, expected: string = TOFU_VERSION): Promise<TofuVersionInfo> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenith-tofu-ver-"));
  try {
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(tmp, { recursive: true });
    const cli = path.join(root, "tofu.rc");
    await writeFile(cli, "");
    const env = buildChildEnv({ homeDir: home, tmpDir: tmp, cliConfigFile: cli, pluginCacheDir: path.join(root, "cache") });
    const res = await runProcess({ file: bin, args: ["version", "-json"], cwd: root, env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024, captureStdoutBytes: 64 * 1024 });
    if (res.exitCode !== 0) {
      throw new TofuBinaryError("tofu_version_mismatch", `\`tofu version\` failed (exit ${res.exitCode}).`);
    }
    let parsed: { terraform_version?: unknown; platform?: unknown };
    try {
      parsed = JSON.parse(res.stdout ?? "");
    } catch {
      throw new TofuBinaryError("tofu_version_mismatch", "`tofu version -json` did not return JSON; is this an OpenTofu binary?");
    }
    const version = typeof parsed.terraform_version === "string" ? parsed.terraform_version : "";
    if (version !== expected) {
      throw new TofuBinaryError("tofu_version_mismatch", `OpenTofu ${expected} is required but the binary reports ${version || "an unknown version"}; refusing to run.`);
    }
    return { version, platform: typeof parsed.platform === "string" ? parsed.platform : "unknown" };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

/** Matching file identity is distinct from independently authenticated distribution provenance. */
export interface TofuExecutableIdentity {
  version: string;
  platform: string;
  sha256: string;
  archiveSha256: string | null;
}

export async function describeTofuBinary(bin: string, info: TofuVersionInfo, identityFile?: string): Promise<TofuExecutableIdentity> {
  const sha256 = createHash("sha256").update(await readFile(bin)).digest("hex");
  if (!identityFile) return { ...info, sha256, archiveSha256: null };
  try {
    const record = JSON.parse(await readFile(identityFile, "utf8")) as TofuExecutableIdentity;
    if (record.version !== info.version || record.platform !== info.platform || record.sha256 !== sha256
      || !record.archiveSha256 || !/^[a-f0-9]{64}$/.test(record.archiveSha256)) throw new Error();
    return { version: info.version, platform: info.platform, sha256, archiveSha256: record.archiveSha256 };
  } catch { throw new Error("OpenTofu packaged executable identity is unavailable or mismatched."); }
}
