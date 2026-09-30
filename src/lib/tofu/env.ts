/**
 * The child-process environment for tofu — an allowlist, never `process.env`.
 *
 * ADR-0005: "the control plane's environment never reaches plugins". The child
 * environment is built from scratch:
 *
 *   PATH                 fixed minimal system path (the tofu binary is spawned
 *                        by absolute path, so it needs none of the parent's)
 *   HOME/USERPROFILE/…   a per-run private directory, so no user CLI config,
 *                        `.terraformrc`, credentials helper or cache is read
 *   TEMP/TMP/TMPDIR      per-run private temp
 *   TF_IN_AUTOMATION=1, TF_INPUT=0, CHECKPOINT_DISABLE=1
 *   TF_CLI_CONFIG_FILE   a generated, empty CLI config (pins provider
 *                        installation to the registry and the plugin cache)
 *   TF_PLUGIN_CACHE_DIR  shared provider-plugin cache
 *   SystemRoot           Windows only (required by the Go runtime's network stack)
 *   …session env        `session.childProcessEnv()` — brokered cloud credentials
 *   …operator extras    explicit runner configuration (e.g. proxy settings)
 *
 * `TF_CLI_ARGS*`, `TF_LOG*`, `TF_VAR_*`, `TF_REATTACH_PROVIDERS`, `TF_DATA_DIR`
 * and `ZENITH_*` are refused from the session/extras: they change what tofu
 * does (extra flags, provider re-attachment, trace logs that print
 * credentials) or would leak control-plane configuration to plugins.
 */
import path from "node:path";

/** A read-only view of an environment: `process.env` or a test double. */
export type HostEnv = Readonly<Record<string, string | undefined>>;

export interface ChildEnvInput {
  /** private per-run directories */
  homeDir: string;
  tmpDir: string;
  cliConfigFile: string;
  pluginCacheDir: string;
  /** brokered credentials for this operation (never persisted or logged) */
  sessionEnv?: Record<string, string>;
  /** operator-supplied non-secret runner config */
  extraEnv?: Record<string, string>;
  /** override for tests */
  platform?: NodeJS.Platform;
  /** host environment used ONLY to read `SystemRoot` on Windows */
  hostEnv?: HostEnv;
}

export class TofuEnvError extends Error {
  readonly code = "tofu_env_invalid";
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the runner owns; a session may not set them. */
const RESERVED = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "TF_IN_AUTOMATION",
  "TF_INPUT",
  "TF_DATA_DIR",
  "TF_CLI_CONFIG_FILE",
  "TF_PLUGIN_CACHE_DIR",
  "TF_REATTACH_PROVIDERS",
  "TF_WORKSPACE",
  "CHECKPOINT_DISABLE",
  "TOFU_CLI_ARGS",
]);

function reservedReason(name: string): string | undefined {
  const upper = name.toUpperCase();
  if (RESERVED.has(upper)) return "is set by the runner";
  if (upper.startsWith("TF_CLI_ARGS")) return "would inject tofu arguments";
  if (upper.startsWith("TF_LOG")) return "enables trace logging that prints credentials";
  if (upper.startsWith("TF_VAR_")) return "would inject variables";
  if (upper.startsWith("TF_")) return "is a tofu setting the runner controls";
  if (upper.startsWith("TOFU_")) return "is a tofu setting the runner controls";
  if (upper.startsWith("ZENITH_")) return "is control-plane configuration";
  return undefined;
}

/** Validate a caller-supplied env map (session or operator extras). */
export function validateExtraEnv(env: Record<string, string> | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!NAME_RE.test(k)) throw new TofuEnvError(`${label} environment name "${k}" is not a valid identifier.`);
    const why = reservedReason(k);
    if (why) throw new TofuEnvError(`${label} environment name ${k} ${why}; refusing to pass it to tofu.`);
    if (typeof v !== "string") throw new TofuEnvError(`${label} environment value for ${k} must be a string.`);
    if (v.includes("\0")) throw new TofuEnvError(`${label} environment value for ${k} contains a NUL byte.`);
    out[k] = v;
  }
  return out;
}

export function minimalPath(platform: NodeJS.Platform, hostEnv: HostEnv): string {
  if (platform === "win32") {
    const root = hostEnv.SystemRoot ?? hostEnv.SYSTEMROOT ?? "C:\\Windows";
    return [path.win32.join(root, "System32"), root].join(";");
  }
  return "/usr/local/bin:/usr/bin:/bin";
}

export function buildChildEnv(input: ChildEnvInput): Record<string, string> {
  const platform = input.platform ?? process.platform;
  const host = input.hostEnv ?? process.env;
  const session = validateExtraEnv(input.sessionEnv, "Session");
  const extras = validateExtraEnv(input.extraEnv, "Runner");

  const env: Record<string, string> = {
    ...extras,
    ...session,
    PATH: minimalPath(platform, host),
    HOME: input.homeDir,
    TMPDIR: input.tmpDir,
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
    TF_CLI_CONFIG_FILE: input.cliConfigFile,
    TF_PLUGIN_CACHE_DIR: input.pluginCacheDir,
  };
  if (platform === "win32") {
    const root = host.SystemRoot ?? host.SYSTEMROOT ?? "C:\\Windows";
    env.SystemRoot = root;
    env.USERPROFILE = input.homeDir;
    env.APPDATA = path.win32.join(input.homeDir, "AppData", "Roaming");
    env.LOCALAPPDATA = path.win32.join(input.homeDir, "AppData", "Local");
    env.TEMP = input.tmpDir;
    env.TMP = input.tmpDir;
  }
  return env;
}
