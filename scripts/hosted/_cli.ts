/**
 * The three lines every ops script shares: how a result is announced, and how
 * a failure is reported.
 *
 * A hosted refusal carries a fix, and a script that swallowed it into a stack
 * trace would throw away the only actionable part. So `fail()` prints the
 * message and the fix, on stderr, and exits non-zero.
 *
 * Workstream W8 (hosted R3).
 */
import { HostedError } from "@/lib/hosted/contracts";

/** Print a closing line on stderr, so stdout stays machine-readable. */
export function finish(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Print a failure with its fix and exit. Never a bare stack trace. */
export function fail(error: unknown): never {
  if (error instanceof HostedError) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    if (error.fix) process.stderr.write(`Fix: ${error.fix}\n`);
    if (error.details) process.stderr.write(`Details: ${JSON.stringify(error.details)}\n`);
  } else {
    process.stderr.write(`\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  process.exit(1);
}
