/**
 * Bounded, time-limited Kubernetes exec.
 *
 * Wraps `Exec.exec` from `@kubernetes/client-node` (the v4/v5 channel
 * WebSocket protocol) so that one exec can never: produce unbounded memory
 * (each stream is capped), run past its timeout (the socket is closed), or
 * outlive an abort. The command is always an argv vector; the Kubernetes exec
 * API takes a repeated `command` query parameter, so there is no shell and no
 * quoting anywhere on this path.
 *
 * Honest limit: closing the WebSocket ends Zenith's session, not necessarily
 * the process in the container. After a timeout, overflow or drop the process
 * may still be running; the caller must treat a mutating exec's outcome as
 * unknown (`uncertain`) rather than as failed.
 */
import { Writable } from "node:stream";
import type { V1Status } from "@kubernetes/client-node";

/** the subset of `Exec` this module uses (structurally satisfied by the real class) */
export interface ExecClient {
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: string[],
    stdout: Writable | null,
    stderr: Writable | null,
    stdin: null,
    tty: boolean,
    statusCallback?: (status: V1Status) => void
  ): Promise<{ close(): void; on?: (event: string, listener: (...args: unknown[]) => void) => unknown }>;
}

export interface ExecLimits {
  /** per-stream capture cap in bytes */
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ExecOutcome {
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** process exit code when the API reported one */
  exitCode: number | null;
  timedOut: boolean;
  /** output far beyond the cap; the socket was closed before an exit status arrived */
  overflow: boolean;
  /** the connection ended, or the API reported a non-exit failure, without an exit status */
  failure?: string;
}

/** Captures up to `max` bytes, counts (and discards) the rest. */
export class BoundedSink extends Writable {
  private chunks: Buffer[] = [];
  private kept = 0;
  discarded = 0;
  constructor(private readonly max: number) {
    super();
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const room = this.max - this.kept;
    if (room > 0) {
      const part = b.length <= room ? b : b.subarray(0, room);
      this.chunks.push(part);
      this.kept += part.length;
      this.discarded += b.length - part.length;
    } else {
      this.discarded += b.length;
    }
    cb();
  }
  get truncated(): boolean {
    return this.discarded > 0;
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export function exitFromStatus(st: V1Status): { exitCode: number | null; failure?: string } {
  if (st.status === "Success") return { exitCode: 0 };
  const cause = st.details?.causes?.find((c) => c.reason === "ExitCode");
  if (st.reason === "NonZeroExitCode" && cause?.message !== undefined && /^\d{1,3}$/.test(cause.message)) {
    return { exitCode: Number(cause.message) };
  }
  return { exitCode: null, failure: st.message ?? st.reason ?? "exec failed" };
}

export async function runExec(client: ExecClient, namespace: string, pod: string, container: string, argv: string[], limits: ExecLimits): Promise<ExecOutcome> {
  const out = new BoundedSink(limits.maxBytes);
  const err = new BoundedSink(limits.maxBytes);
  const overflowAt = limits.maxBytes * 4 + 64 * 1024;

  return new Promise<ExecOutcome>((resolve, reject) => {
    let settled = false;
    let conn: { close(): void } | undefined;
    const closeConn = () => {
      try {
        conn?.close();
      } catch {
        /* already closed */
      }
    };
    const outcome = (over: Partial<ExecOutcome>): ExecOutcome => ({
      stdout: out.buffer(),
      stderr: err.buffer(),
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      exitCode: null,
      timedOut: false,
      overflow: false,
      ...over,
    });
    const cleanup = () => {
      clearTimeout(timer);
      limits.signal.removeEventListener("abort", onAbort);
    };
    const finish = (over: Partial<ExecOutcome>) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeConn();
      resolve(outcome(over));
    };
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeConn();
      reject(e);
    };
    const onAbort = () => fail(limits.signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish({ timedOut: true }), limits.timeoutMs);
    if (limits.signal.aborted) return onAbort();
    limits.signal.addEventListener("abort", onAbort, { once: true });

    // stop reading once a stream is far past its cap: a runaway producer is not worth the bandwidth
    const watch = (s: BoundedSink) => {
      const w = s._write.bind(s);
      s._write = (chunk, enc, cb) => {
        w(chunk, enc, cb);
        if (s.discarded > overflowAt) finish({ overflow: true });
      };
    };
    watch(out);
    watch(err);

    client
      .exec(namespace, pod, container, argv, out, err, null, false, (status) => finish(exitFromStatus(status)))
      .then((c) => {
        conn = c;
        if (settled) return closeConn();
        c.on?.("close", () => finish({ failure: "the exec connection closed before an exit status was received" }));
      })
      .catch(fail);
  });
}
