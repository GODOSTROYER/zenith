/**
 * Apps, publish jobs, releases, rollback and suspension — everything that
 * turns a source package into a private running app without ever losing the
 * healthy one.
 *
 *   deps.ts      the seam every cross-workstream call goes through
 *   shared.ts    phases, leases, bounded logs, the two refusals a worker owes
 *   apps.ts      creating and reading apps (app + owner grant in one tx)
 *   intent.ts    what a publish is, canonically, and how it is hashed
 *   publish.ts   intake → build → artifact → verify → stage → probe → activate
 *   rollback.ts  putting an app back onto a proven release, data untouched
 *   suspend.ts   stop admitting requests without destroying anything
 *   runner.ts    the ticker, the claim policy and the lease heartbeat
 *
 * The job runner is started by `ensureHosted()`.
 *
 * Workstream W7 (hosted R3).
 */
export {
  RETAINED_RELEASES,
  appGrants,
  appSummary,
  createApp,
  getApp,
  listApps,
  requireOwnedApp,
  retainedReleases,
  setAppState,
  type AppSummary,
  type CreateAppInput,
} from "./apps";

export {
  releaseDeps,
  resetReleaseDeps,
  setReleaseDepsForTests,
  type ReleaseDeps,
} from "./deps";

export {
  FIXTURES,
  PublishSource,
  decodeTarball,
  fixtureDirectory,
  publishIntent,
  rollbackIntent,
  sha256,
  stateIntent,
  type PublishIntent,
  type PublishIntentInput,
} from "./intent";

export {
  PUBLISH_PHASES,
  admitPublish,
  assertPublishable,
  buildSlot,
  runPublish,
  type AdmitPublishInput,
  type PublishPhase,
} from "./publish";

export {
  ROLLBACK_PHASES,
  ROLLBACK_SOURCE_STATUSES,
  admitRollback,
  assertRollbackTarget,
  runRollback,
  type AdmitRollbackInput,
} from "./rollback";

export {
  SUSPEND_DEFAULT_REASON,
  admitResume,
  admitSuspend,
  runResume,
  runSuspend,
  type AdmitStateChangeInput,
} from "./suspend";

export {
  JOB_TICK_MS,
  claimJob,
  hostedJobRunnerRunning,
  jobLogs,
  jobOwner,
  queuedJobs,
  reclaimExpiredJobs,
  runClaimedJob,
  runJobOnce,
  startHostedJobRunner,
  stopHostedJobRunner,
  tickJobs,
} from "./runner";

export {
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  JOB_LOG_LINES,
  LeaseLost,
  logsOf,
  redactLine,
  renewLease,
  requireApp,
  requireAppIn,
  runOf,
  type JobRun,
  type PhaseData,
} from "./shared";
