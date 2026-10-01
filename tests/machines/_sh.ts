/**
 * Runs a shell program on a POSIX shell when one is available: `sh` on Linux,
 * macOS and Git Bash, or `wsl -e sh` on a Windows machine with WSL. Used to
 * execute the real SSM document scripts against hostile parameters.
 *
 * The whole program goes to `sh -s` on stdin (no command-line quoting, which
 * differs between Windows, WSL and POSIX), with any files it needs written
 * first via quoted heredocs into a private temp directory exposed as `$T`.
 */
import { spawnSync } from "node:child_process";

export interface ShResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `files` are written under `$T/<name>` before `program` runs; `$T` is removed afterwards. */
export type ShRunner = (program: string, files?: Record<string, string>) => ShResult;

function build(program: string, files: Record<string, string>): string {
  const parts = ['T=$(mktemp -d) || exit 97', 'trap \'rm -rf "$T"\' EXIT'];
  Object.entries(files).forEach(([name, body], i) => {
    const tag = `ZENITH_HEREDOC_${i}`;
    if (body.includes(tag)) throw new Error("heredoc tag collision");
    parts.push(`cat > "$T/${name}" <<'${tag}'\n${body.replace(/\n$/, "")}\n${tag}`);
  });
  parts.push(program);
  return parts.join("\n") + "\n";
}

function attempt(cmd: string, pre: string[]): ShRunner | null {
  const run: ShRunner = (program, files = {}) => {
    const r = spawnSync(cmd, [...pre, "sh", "-s"], { input: build(program, files), encoding: "utf8", timeout: 60_000, windowsHide: true });
    return { status: r.status, stdout: (r.stdout ?? "").replace(/\r\n/g, "\n"), stderr: (r.stderr ?? "").replace(/\r\n/g, "\n") };
  };
  try {
    const probe = run("echo zenith-probe");
    return probe.status === 0 && probe.stdout.trim() === "zenith-probe" ? run : null;
  } catch {
    return null;
  }
}

/** a working POSIX `sh` runner, or null (tests then skip) */
export function findSh(): ShRunner | null {
  if (process.platform === "win32") return attempt("wsl", ["-e"]) ?? attempt("sh", []);
  return attempt("sh", []);
}

/** single-quote a value for embedding in the shell program text */
export const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
