/**
 * What every build runner needs and none of them should re-implement.
 *
 * A runner differs from its siblings only in where the build happens — a child
 * process, a container, a remote sandbox. Collecting log lines under a byte
 * ceiling and shaping the final `BuildResult` are the same job in all three, so
 * they live here and the runners keep only their boundary-specific code.
 */
import type { BuildLogLine, BuildResult } from "@/lib/hosted/contracts";

/** Splits a byte stream into log lines and stops at a byte ceiling. */
export class LogSink {
  readonly lines: BuildLogLine[] = [];
  private bytes = 0;
  private truncated = false;
  private readonly partial = new Map<BuildLogLine["stream"], string>();

  constructor(private readonly maxBytes: number) {}

  push(stream: BuildLogLine["stream"], chunk: string): void {
    const carried = (this.partial.get(stream) ?? "") + chunk;
    const parts = carried.split(/\r?\n/);
    this.partial.set(stream, parts.pop() ?? "");
    for (const line of parts) this.line(stream, line);
  }

  /** Flush whatever a stream ended on without a newline. */
  end(): void {
    for (const [stream, rest] of this.partial) if (rest !== "") this.line(stream, rest);
    this.partial.clear();
  }

  line(stream: BuildLogLine["stream"], raw: string): void {
    if (this.truncated) return;
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
    if (line === "") return;
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true;
      this.lines.push({
        ts: new Date().toISOString(),
        stream: "info",
        line: `Log truncated at ${this.maxBytes} bytes. Shorten the build output to see the rest.`,
      });
      return;
    }
    this.bytes += size;
    this.lines.push({ ts: new Date().toISOString(), stream, line });
  }
}

/** The part of a `BuildResult` a runner decides; the rest is bookkeeping. */
export type BuildOutcome = Omit<BuildResult, "logs" | "durationMs" | "runner" | "boundary">;

/**
 * The `done()` a runner returns from.
 *
 * It flushes the sink first, so a stream that ended mid-line still reports its
 * last line, and stamps the duration from `started` — meaning every exit from
 * `run()`, including the early refusals, carries the same four fields.
 */
export function buildResult(
  sink: LogSink,
  runner: BuildResult["runner"],
  boundary: BuildResult["boundary"],
  started: number
): (partial: BuildOutcome) => BuildResult {
  return (partial) => {
    sink.end();
    return {
      ...partial,
      logs: sink.lines,
      durationMs: Date.now() - started,
      runner,
      boundary,
    };
  };
}
