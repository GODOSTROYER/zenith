import { defaultMaintenanceAcceptance } from "./default";
import { constants, closeSync, fchmodSync, fsyncSync, fstatSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSERTION_DIAGNOSTIC_CODES = new Map<string, string>([
  ["Not run: needs the Mac default stack and ZENITH_TEST_MAINTENANCE=1.", "maintenance_gate_not_enabled"],
  ["Requires ZENITH_TEST_MAINTENANCE=1.", "maintenance_gate_not_enabled"],
  ["Acceptance endpoints must be loopback.", "endpoint_not_loopback"],
  ["Migration-seeded cleanup epoch is missing or invalid; refuse without changing it.", "cleanup_epoch_invalid"],
  ["Requires an isolated j4-* Temporal namespace.", "temporal_namespace_invalid"],
  ["Temporal must be loopback.", "temporal_endpoint_not_loopback"],
  ["Requires the actual product/control PostgreSQL stores.", "postgres_store_required"],
  ["Rehearsal uses real billing records without a Stripe account.", "managed_billing_required"],
  ["Use the explicit serverless profile so only durable timers and requested fallback routes run.", "serverless_profile_required"],
  ["Rehearsal needs the local ephemeral signer.", "local_signer_required"],
  ["Requires a fresh dedicated maintenance database.", "maintenance_database_not_fresh"],
  ["Default maintenance rehearsal must contain no provider connections.", "provider_connections_present"],
  ["Owned worker identity is unavailable.", "worker_identity_unavailable"],
  ["Owned worker exited before the planned stop.", "worker_exited_before_planned_stop"],
  ["Could not signal the owned worker for shutdown.", "worker_shutdown_signal_failed"],
  ["Owned worker did not close after SIGKILL.", "worker_close_unconfirmed"],
  ["Owned worker required forced termination.", "worker_required_forced_termination"],
  ["Owned worker did not stop cleanly after SIGTERM.", "worker_shutdown_unclean"],
  ["Owned worker close event was not a graceful SIGTERM settlement.", "worker_closeout_invalid"],
  ["Default maintenance acceptance deadline exceeded.", "maintenance_deadline_exceeded"],
  ["Isolated namespace already has a worker.", "temporal_worker_already_present"],
  ["Cron-secret file is empty.", "cron_secret_empty"],
  ["Default tick/status HTTP request failed.", "maintenance_http_request_failed"],
  ["Owned worker exited.", "owned_worker_exited"],
  ["Natural action is absent.", "natural_action_absent"],
  ["Natural maintenance action overlapped a held core-job lease.", "core_job_lease_overlap"],
  ["Natural maintenance timer never fired.", "natural_timer_not_fired"],
  ["Default housekeeping did not prune the seeded expired nonce.", "housekeeping_effect_missing"],
  ["Default billing did not examine durable accounts.", "billing_effect_missing"],
  ["Billing HTTP fallback did not yield to the durable timer.", "billing_fallback_did_not_defer"],
  ["HTTP fallback did not defer.", "runbooks_fallback_did_not_defer"],
  ["A second runbook pass overlapped.", "runbooks_lease_overlap"],
  ["Billing HTTP fallback did not defer behind the held lease.", "billing_lease_overlap"],
  ["A second billing pass overlapped.", "billing_lease_overlap"],
  ["Owned worker closeout proof is unavailable.", "worker_closeout_unavailable"],
  ["Fallback did not resume during the worker outage.", "fallback_did_not_resume"],
  ["Billing fallback did not resume during the real worker outage.", "billing_fallback_did_not_resume"],
  ["Repeated authenticated billing fallback did not converge.", "billing_fallback_not_idempotent"],
  ["Schedule history did not survive worker restart.", "schedule_history_not_preserved"],
  ["Natural outage was not counted.", "natural_outage_not_counted"],
  ["A durable-only addendum did not record missed ticks across the worker outage.", "addendum_missed_ticks_not_counted"],
  ["Default API health does not match durable readback.", "durable_api_health_mismatch"],
  ["Published cleanup epoch changed.", "cleanup_epoch_changed"],
  ["Running workflow remains; retain namespace/database.", "workflow_cleanup_unconfirmed"],
  ["Owned maintenance cleanup is unconfirmed; retain namespace/database.", "cleanup_unconfirmed"],
]);

/** Return only fixed, source-owned diagnostic codes. Never echo exception text or stacks. */
export function maintenanceDiagnosticCode(error: unknown): string {
  try {
    if (error instanceof AggregateError && error.message === "Owned maintenance cleanup is unconfirmed; retain namespace/database.") {
      return "cleanup_unconfirmed";
    }
    if (error && typeof error === "object") {
      const candidate = error as { name?: unknown; message?: unknown };
      if (typeof candidate.message !== "string") return "acceptance_failed_unclassified";
      const known = ASSERTION_DIAGNOSTIC_CODES.get(candidate.message);
      if (known) return known;
      for (const job of ["engine", "alerts", "outbox", "housekeeping", "runner-reaper", "runbooks", "reconcile",
        "billing", "key-rewrap", "data-minimize", "data-retention", "managed-serving"] as const) {
        if (candidate.message === `No successful run record exists for ${job}.`) return "scheduled_job_record_missing";
        if (candidate.message === `Natural maintenance action overlapped the held ${job} lease.`) return "scheduled_job_lease_overlap";
        if (candidate.message === `A run record was added while the ${job} lease was held.`) return "scheduled_job_record_changed_while_lease_held";
      }
      if (candidate.name === "AssertionError") return "acceptance_assertion_failed";
    }
  } catch {
    return "acceptance_failed_unclassified";
  }
  return "acceptance_failed_unclassified";
}

const SQLSTATE_CODES = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01", "28P01", "3D000", "3F000",
  "40001", "40P01", "42501", "42703", "42P01", "42P05", "42P07", "53300", "57P01", "57P02", "57P03", "23505",
]);
const DIAGNOSTIC_TYPES = new Set(["assertion", "aggregate", "error", "unknown"] as const);
type MaintenanceDiagnosticType = "assertion" | "aggregate" | "error" | "unknown";

type MaintenanceDiagnosticFields = { code: string; type: MaintenanceDiagnosticType; sqlState?: string };

function maintenanceDiagnosticFields(error: unknown): MaintenanceDiagnosticFields {
  let type: MaintenanceDiagnosticType = "unknown";
  let sqlState: string | undefined;
  try {
    if (error instanceof AggregateError) type = "aggregate";
    else if (error instanceof Error) type = error.name === "AssertionError" ? "assertion" : "error";
    if (error && typeof error === "object") {
      const candidate = error as { code?: unknown };
      if (typeof candidate.code === "string" && SQLSTATE_CODES.has(candidate.code)) sqlState = candidate.code;
    }
  } catch {
    type = "unknown";
    sqlState = undefined;
  }
  const code = maintenanceDiagnosticCode(error);
  return {
    code: code === "acceptance_failed_unclassified" && sqlState ? "postgres_sqlstate" : code,
    type: DIAGNOSTIC_TYPES.has(type) ? type : "unknown",
    ...(sqlState ? { sqlState } : {}),
  };
}

/** Include at most one sanitized causal record; never recurse through an error chain. */
export function maintenanceDiagnosticRecord(error: unknown): MaintenanceDiagnosticFields & { cause?: MaintenanceDiagnosticFields } {
  const record = maintenanceDiagnosticFields(error);
  try {
    if (error instanceof AggregateError && Object.prototype.hasOwnProperty.call(error, "cause")) {
      const cause = (error as AggregateError & { cause?: unknown }).cause;
      return { ...record, cause: maintenanceDiagnosticFields(cause) };
    }
  } catch {
    return record;
  }
  return record;
}

function privateDiagnosticPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.ZENITH_LOCAL_TARGETS !== "1" || env.ZENITH_LOCAL_JOINED_DRIVERS !== "1"
    || env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || env.ZENITH_TEST_MAINTENANCE !== "1") return undefined;
  if (typeof process.getuid !== "function") return undefined;
  const root = env.ZENITH_LOCAL_ROOT ?? "";
  const stack = env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR ?? "";
  if (!path.isAbsolute(root) || path.resolve(root) !== root || !path.isAbsolute(stack) || path.resolve(stack) !== stack
    || env.ZENITH_LOCAL_STACK_DIRECTORY !== stack) return undefined;
  const uid = process.getuid();
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== uid || (rootStat.mode & 0o777) !== 0o700
      || realpathSync(root) !== root) return undefined;
    const stackStat = lstatSync(stack);
    if (!stackStat.isDirectory() || stackStat.isSymbolicLink() || stackStat.uid !== uid || realpathSync(stack) !== stack) return undefined;
  } catch {
    return undefined;
  }
  const target = env.ZENITH_LOCAL_MAINTENANCE_DIAGNOSTIC_FILE ?? "";
  if (!path.isAbsolute(target) || path.resolve(target) !== target || path.dirname(target) !== root
    || !/^[A-Za-z0-9_.-]{1,80}$/.test(path.basename(target)) || path.basename(target) === "." || path.basename(target) === "..") return undefined;
  try {
    lstatSync(target);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  return target;
}

/** Best-effort, exclusive, private failure receipt for the owned J4 joined runner only. */
export function writeMaintenanceDiagnostic(error: unknown, env: NodeJS.ProcessEnv): boolean {
  const target = privateDiagnosticPath(env);
  if (!target || typeof constants.O_NOFOLLOW !== "number") return false;
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) return false;
    writeFileSync(fd, `${JSON.stringify(maintenanceDiagnosticRecord(error))}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const directory = openSync(env.ZENITH_LOCAL_ROOT!, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve the original failure exit. */ }
    }
  }
}

export async function runMaintenanceCli(
  execute: () => Promise<Record<string, unknown>> = defaultMaintenanceAcceptance,
  env: NodeJS.ProcessEnv = process.env,
  io: { stdout: (value: string) => void; stderr: (value: string) => void } = {
    stdout: value => { process.stdout.write(value); },
    stderr: value => { process.stderr.write(value); },
  },
): Promise<number> {
  try {
    io.stdout(`${JSON.stringify(await execute())}\n`);
    return 0;
  } catch (error) {
    writeMaintenanceDiagnostic(error, env);
    io.stderr(`J4 maintenance acceptance failed; retain the owned local database/namespace for inspection. code=${maintenanceDiagnosticCode(error)}\n`);
    return 1;
  }
}

export function isDirectInvocation(argv1: string | undefined = process.argv[1], moduleUrl: string | URL = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  void runMaintenanceCli().then(code => { process.exitCode = code; });
}
