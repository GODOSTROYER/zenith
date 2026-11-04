/**
 * Bounded child-process execution for the tofu runner.
 *
 * - `spawn` without a shell; the file and args are never joined into a string.
 * - The environment is exactly what the caller passes (see `env.ts`).
 * - Wall-clock timeout and `AbortSignal`: POSIX sends SIGINT to the child's
 *   process group, then SIGKILL after `graceMs`; Windows has no graceful
 *   signal, so the whole tree is killed with `taskkill /T /F` (provider
 *   plugins are grandchildren and would otherwise be orphaned).
 * - Combined stdout+stderr is kept head + tail within `maxOutputBytes` and a
 *   truncation flag is set; the middle is dropped, so both the invocation
 *   banner and the final error survive.
 * - Structured stdout (e.g. `show -json`) is captured separately up to
 *   `captureStdoutBytes` and never truncated silently: overflow is flagged so
 *   the caller refuses to parse a partial document. In that mode stdout is
 *   NOT part of the displayable `output` (only stderr is), because a JSON
 *   document like `tofu output -json` carries unmasked values.
 *
 * Redaction is applied by the caller-supplied `redact` to the combined output
 * only; raw structured stdout is returned unredacted because it is parsed, not
 * displayed (the plan normalizer masks sensitive values itself).
 */
import { spawn } from "node:child_process";

export interface RunProcessOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** POSIX: SIGINT→SIGKILL grace. Default 5 s. */
  graceMs?: number;
  /** combined-output cap (head + tail) */
  maxOutputBytes: number;
  /** capture stdout separately, up to this many bytes (0/undefined: not captured) */
  captureStdoutBytes?: number;
  signal?: AbortSignal;
  redact?: (text: string) => string;
  stdin?: string;
}

export interface RunProcessResult {
  exitCode: number;
  /** terminating signal, when the process was killed by one */
  signal?: string;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdout?: string;
  stdoutOverflow: boolean;
}

/** Keeps the first `head` and last `tail` bytes of a stream of chunks. */
class HeadTail {
  private headBuf: Buffer[] = [];
  private headLen = 0;
  private tailBuf: Buffer[] = [];
  private tailLen = 0;
  dropped = 0;
  constructor(
    private readonly head: number,
    private readonly tail: number
  ) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headLen < this.head) {
      const take = Math.min(this.head - this.headLen, rest.length);
      this.headBuf.push(rest.subarray(0, take));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tailBuf.push(rest);
    this.tailLen += rest.length;
    while (this.tailLen > this.tail) {
      const first = this.tailBuf[0];
      const excess = this.tailLen - this.tail;
      if (first.length <= excess) {
        this.tailBuf.shift();
        this.tailLen -= first.length;
        this.dropped += first.length;
      } else {
        this.tailBuf[0] = first.subarray(excess);
        this.tailLen -= excess;
        this.dropped += excess;
      }
    }
  }

  toString(): string {
    const head = Buffer.concat(this.headBuf).toString("utf8");
    const tail = Buffer.concat(this.tailBuf).toString("utf8");
    if (this.dropped === 0) return head + tail;
    return `${head}\n[… ${this.dropped} bytes of output truncated …]\n${tail}`;
  }
}

function killTreeWindows(pid: number): void {
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
    killer.on("error", () => undefined);
    killer.unref();
  } catch {
    /* the process may already be gone */
  }
}

export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  const started = Date.now();
  const isWin = process.platform === "win32";
  const graceMs = opts.graceMs ?? 5000;
  const cap = Math.max(1024, opts.maxOutputBytes);
  const collector = new HeadTail(Math.floor(cap / 2), Math.ceil(cap / 2));
  const stdoutLimit = opts.captureStdoutBytes ?? 0;
  const stdoutChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stdoutOverflow = false;

  return new Promise<RunProcessResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: -1, output: "", truncated: false, timedOut: false, aborted: true, durationMs: 0, stdoutOverflow: false });
      return;
    }

    const child = spawn(opts.file, [...opts.args], {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // own process group on POSIX so SIGINT/SIGKILL reach provider plugins
      detached: !isWin,
    });

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (isWin) {
        killTreeWindows(pid);
        return;
      }
      try {
        process.kill(-pid, "SIGINT");
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, graceMs);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number, signal?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const redact = opts.redact ?? ((t: string) => t);
      let output = collector.toString();
      if (timedOut) output += `\n[zenith] command timed out after ${opts.timeoutMs} ms and was terminated`;
      if (aborted) output += "\n[zenith] command was aborted and terminated";
      resolve({
        exitCode,
        signal,
        output: redact(output),
        truncated: collector.dropped > 0,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        stdout: stdoutLimit > 0 ? Buffer.concat(stdoutChunks).toString("utf8") : undefined,
        stdoutOverflow,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      // structured mode: stdout is a document (show/output/validate -json) that
      // can hold unmasked values, so it never enters the displayable output
      if (stdoutLimit === 0) collector.push(chunk);
      if (stdoutLimit > 0 && !stdoutOverflow) {
        if (stdoutLen + chunk.length > stdoutLimit) {
          stdoutOverflow = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => collector.push(chunk));
    // stdin is always closed at once: tofu never waits for interactive input
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    // `exit` fires when the process ends even if a grandchild still holds the
    // pipes open; give the streams a moment to drain, then stop waiting.
    child.on("exit", (code, signal) => {
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code ?? -1, signal ?? undefined);
      }, 2000);
      closeTimer.unref?.();
    });
    child.on("close", (code, signal) => finish(code ?? -1, signal ?? undefined));
  });
}
