/**
 * Command-line wiring for `cleanup.ts`: parse, run the safety gates, sweep,
 * print the JSON report, exit non-zero when anything is left or went wrong.
 *
 * Exit codes: 0 every run clean (or, in a dry run, nothing unsupported);
 * 1 the sweep found problems (see the report); 2 a safety gate or a usage
 * error stopped it before any change.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ambientAccess } from "./aws-access";
import { UsageError, parseArgs } from "./args";
import { cleanupRuns } from "./cleanup";
import { LiveConfigError, defaultStateBucket, loadLiveConfig } from "./config";
import { defaultEvidenceRoot } from "./evidence";
import { readCleanupBlock, readRunState, runStatePath } from "./run-state";
import { redactCredentials } from "@/lib/credentials/redact";
import { LiveSafetyError, establishLiveSession, resolveLiveTarget } from "./safety";
import { ScopeError } from "../release/scope";

export const CLEANUP_USAGE = `Usage: npx tsx scripts/acceptance/cleanup.ts (--run-id <id> | --older-than <hours>) [options]

  --run-id <id>        clean one run (zlive-<yyyymmddhhmm>-<4 chars>)
  --older-than <h>     clean every zlive-* run whose id is older than <h> hours
  --execute            request deletion (refused until mutation quiescence can be established)
  --region <r>         AWS region (or ZENITH_LIVE_REGION); there is no default
  --out <dir>          evidence parent directory (default: <os tmp>/zenith-acceptance)
  --report <file>      also write the JSON report here
  --no-tofu            disable OpenTofu planning; never bypass cleanup admission

Requires ZENITH_LIVE_AWS_ACCOUNT_ID and the ambient AWS credentials of that sandbox account; the account must carry /zenith/live-sandbox=true.
Current harness authorities cannot establish provider quiescence. Execute requests retain read-only discovery and report the missing native-resolution prerequisite; --no-tofu and missing run state do not bypass it.`;

/**
 * PROD-REL-04: the scope gate. The real entry point (`cleanup.ts` run as a program) passes one that loads the approved scope
 * manifest and requires the `aws-cleanup` grant; it runs before any cloud call. Unit tests drive this function with modeled AWS
 * clients and no gate, exactly as `runAzureLive` is unit tested with fakes.
 */
export type CleanupScopeGate = (action: "read" | "teardown_run_tagged") => void;

export async function runCleanupCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env, io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, scopeGate?: CleanupScopeGate): Promise<number> {
  try {
    const args = parseArgs(argv, { booleans: ["execute", "no-tofu", "help"], strings: ["run-id", "older-than", "region", "out", "report"] });
    if (args.flags.has("help")) {
      io.out(`${CLEANUP_USAGE}\n`);
      return 0;
    }
    if (args.positional.length) throw new UsageError("Positional arguments are not accepted.");
    const runId = args.values.get("run-id");
    const olderRaw = args.values.get("older-than");
    if ((runId === undefined) === (olderRaw === undefined)) throw new UsageError("Give exactly one of --run-id or --older-than.");
    const older = olderRaw === undefined ? undefined : Number(olderRaw);
    if (older !== undefined && (!Number.isFinite(older) || older < 0)) throw new UsageError("--older-than needs a number of hours.");
    const execute = args.flags.has("execute");

    const config = loadLiveConfig(env, { region: args.values.get("region") });
    const target = resolveLiveTarget(config);
    // PROD-REL-04: the approved scope manifest must grant this harness (read for a dry run, run-tagged teardown for execute) before any cloud call.
    scopeGate?.(execute ? "teardown_run_tagged" : "read");
    const access = ambientAccess({ accountId: target.accountId, region: target.region });
    // The same gates as a live run: right account, opt-in marker, allowed region.
    await establishLiveSession({ config, access, confirmBillable: execute, mutating: execute });

    const outDir = args.values.get("out") ?? defaultEvidenceRoot();
    const report = await cleanupRuns({
      access,
      selector: runId !== undefined ? { runId } : { olderThanHours: older! },
      dryRun: !execute,
      stateBucket: config.stateBucket ?? defaultStateBucket(target.accountId, target.region),
      workspaceId: config.workspaceId,
      stateKmsKeyArn: config.stateKmsKeyArn,
      useTofu: !args.flags.has("no-tofu"),
      loadRunState: (id) => readRunState(runStatePath(outDir, id), { runId: id, accountId: target.accountId, region: target.region }),
      loadCleanupBlock: (id) => readCleanupBlock(runStatePath(outDir, id), { runId: id, accountId: target.accountId, region: target.region }),
      log: (m) => io.err(`${m}\n`),
    });

    const text = `${JSON.stringify(report, null, 2)}\n`;
    const reportFile = args.values.get("report");
    if (reportFile) {
      await mkdir(path.dirname(reportFile), { recursive: true });
      await writeFile(reportFile, text, { mode: 0o600 });
    }
    if (runId !== undefined) {
      const dir = path.join(outDir, runId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, `cleanup-report-${execute ? "execute" : "dry-run"}.json`), text, { mode: 0o600 });
    }
    io.out(text);
    if (!report.ok) io.err(`CLEANUP INCOMPLETE: ${report.summary.blockedRuns} runs blocked pending authoritative mutation resolution; ${report.summary.failed} failed, ${report.summary.unsupported} unsupported, ${report.summary.refused} refused, ${report.summary.unverified} unverified, ${report.summary.remaining} still listed.${execute ? " Execute requests lack native quiescence authority, including empty discovery." : ""} Read the report; resources may still be costing money.\n`);
    return report.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError || err instanceof LiveConfigError) {
      io.err(`${err.message}\n\n${CLEANUP_USAGE}\n`);
      return 2;
    }
    if (err instanceof LiveSafetyError || err instanceof ScopeError) {
      io.err(`REFUSED (${err.code}): ${err.message}\n`);
      return 2;
    }
    io.err(redactCredentials(`Cleanup failed unexpectedly: ${err instanceof Error ? err.name : "error"}: ${err instanceof Error ? err.message : ""}`).slice(0, 400));
    return 1;
  }
}
