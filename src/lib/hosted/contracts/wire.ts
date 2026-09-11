/**
 * The hosted control API's response bodies, declared once.
 *
 * These shapes were written down three times: as an object literal in each
 * route under `src/app/api/hosted`, as the `*Wire` interfaces in
 * `src/lib/client/hosted.ts`, and as prose in `docs/hosted/CONTRACTS-R3.md`.
 * Two of those are code, and they are this file now: a route annotates its
 * return with the type here, the client imports the same type instead of
 * restating it, and a field that only one of them believes in stops compiling.
 *
 * The starting point was the client's interfaces, because the consumer's view
 * is the one that has to be true; where a route was already sending more than
 * the browser read (the selected builder, the rate table), the extra field is
 * declared here rather than dropped.
 *
 * L0, like everything in `contracts/`: types only, no imports outside this
 * directory, safe in the browser. The producing modules (`hosted/release`,
 * `hosted/quota`, `hosted/usage`, `hosted/health`) keep their own domain types
 * and satisfy these structurally — that is deliberate, so a wire shape cannot
 * quietly follow an internal refactor.
 *
 * This file is deliberately not re-exported from `contracts/index.ts`: it is
 * the HTTP surface, not the vocabulary, and importing it should say so.
 */
import type {
  AppGrant,
  AppInvite,
  AppState,
  BuildRunnerId,
  HostedApp,
  HostedJob,
  HostedLimits,
  InviteDelivery,
  LimitEnforcement,
  QuotaCounter,
  Release,
  RuntimeId,
  UsageEntry,
} from "./types";
import type { Availability } from "./interfaces";

/* ------------------------------- apps and jobs ----------------------------- */

/** The runtime serving app hosts, describing itself. Shown word for word. */
export interface RuntimeInfo {
  id: RuntimeId;
  label: string;
  availability: Availability;
}

/** One build runner this install knows about, and its own isolation sentence. */
export interface BuilderInfo {
  id: BuildRunnerId;
  label: string;
  boundary: string;
  availability: Availability;
}

/** `GET /api/hosted/apps/:id`, and one entry of the apps list. */
export interface AppSummaryWire {
  app: HostedApp;
  activeRelease: Release | null;
  releases: Release[];
  runningJob: HostedJob | null;
  recentJobs: HostedJob[];
  hostname: string;
  origin: string;
  /**
   * Active grants, so a card can say who has access without an owner-only
   * read. Optional because a screen fixture may state an app without them.
   */
  grantCount?: number;
  /** Pending invitations, on the same terms. */
  inviteCount?: number;
  /** owner only — its presence is how the caller learns they are one */
  grants?: AppGrant[];
  invites?: AppInvite[];
}

/** `GET /api/hosted/apps`. */
export interface HostedAppsWire {
  apps: AppSummaryWire[];
  limits: HostedLimits;
  /** null when the runtime could not be reached to ask */
  enforcement: LimitEnforcement | null;
  runtime: RuntimeInfo;
  builder: BuilderInfo[];
  /** Which runner `ZENITH_BUILD_RUNNER` selected, or null with the reason. */
  selectedBuilder: BuildRunnerId | null;
  selectedBuilderReason: string | null;
  buildsPaused: { paused: boolean; reason?: string };
  appDomain?: string;
  appScheme?: string;
}

/** `POST /api/hosted/apps`. */
export interface AppCreatedWire {
  app: HostedApp;
}

/** `GET /api/hosted/apps/:id/releases`. */
export interface ReleasesWire {
  releases: Release[];
  /** Read from the app record, not searched for among the releases. */
  activeReleaseId: string | null;
  activeFence: number;
}

/**
 * A job's kept output. The runner stores each line as `<iso> <text>`, so the
 * timestamp is split off for display rather than shown inside the message.
 */
export interface HostedJobPayload {
  job: HostedJob;
  logs: string[];
}

/** What every route that queues durable work answers with, at 202. */
export interface JobAccepted {
  job: HostedJob;
  jobId: string;
  /** false when this job id already existed: the same intent was replayed */
  created: boolean;
}

/* --------------------------------- access ---------------------------------- */

export interface AppGrantsWire {
  grants: AppGrant[];
}

export interface AppGrantWire {
  grant: AppGrant;
}

/** `DELETE …/grants/:id` — the revoked grant, and what it took with it. */
export interface GrantRevokedWire {
  grant: AppGrant;
  sessionsTerminated: number;
  revocationSeq: number;
}

export interface AppInvitesWire {
  invites: AppInvite[];
}

export interface AppInviteWire {
  invite: AppInvite;
}

/** 201 from creating or resending an invitation. The link is in clear once. */
export interface IssuedInviteWire {
  invite: AppInvite;
  delivery: InviteDelivery;
  /** in clear, this once only */
  acceptUrl: string;
}

/** `POST /api/hosted/invites/accept`. */
export interface AcceptResult {
  app: { id: string; slug: string; name: string };
  grant: AppGrant;
  launchUrl: string;
}

/** `POST /api/hosted/apps/:id/launch` — where the browser goes next. */
export interface LaunchWire {
  redirect: string;
}

/** `POST /api/hosted/session/terminate`. */
export interface SessionsTerminatedWire {
  terminated: number;
}

/* --------------------------- health, usage, spend -------------------------- */

/** What the app's own event rows said over the last day. Counts, not a log. */
export interface EventDigest {
  since: string;
  total: number;
  writes: number;
  denials: number;
  conflicts: number;
  errors: number;
  byEvent: Record<string, number>;
}

export interface HostedHealth {
  /** the health route measures; it never generates a result */
  simulated: boolean;
  appId: string;
  slug: string;
  state: AppState;
  stateReason?: string;
  checkedAt: string;
  runtime: { id: RuntimeId; label: string; enforcement: LimitEnforcement };
  /** the release the checks were run against, or null when nothing is serving */
  release: { id: string; number: number; digest: string } | null;
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string }[];
  lastEvents: EventDigest;
  quota: { day: string; requests: number; denied: number; limit: number };
}

/** `GET /api/hosted/apps/:id/health`. */
export interface HostedHealthWire {
  health: HostedHealth;
}

/** One rendered line of an app's own activity log. */
export interface AppLogLineWire {
  ts: string;
  releaseId: string | null;
  event: string;
  outcome: string;
  /** `<ts> [<releaseId>] <event> <outcome>`, plus any counts the event carried. */
  line: string;
}

/**
 * `GET /api/hosted/apps/:id/events` — counts and the app's own log lines.
 *
 * `events` are the pseudonymous event rows the authority keeps; they are the
 * event table's own shape, which no browser code reads field by field today.
 */
export interface AppEventsWire {
  events: unknown[];
  logs: AppLogLineWire[];
  /** how the lines were produced, shown verbatim */
  disclosure: string;
}

export interface QuotaSummary {
  appId: string;
  today: string;
  current: QuotaCounter;
  limit: number;
  days: QuotaCounter[];
  /** how the number was produced — shown verbatim */
  disclosure: string;
}

export interface UsageSummary {
  workspaceId: string;
  since: string;
  byKind: {
    kind: UsageEntry["kind"];
    amount: number;
    entries: number;
    estimatedUsd: number;
    unit: string;
    basis: string;
  }[];
  estimatedUsd: number;
  invoicedUsd: number;
  disclosure: string;
}

export type EnforcementKey = LimitEnforcement[keyof HostedLimits];

/** One row of the rate table: what a unit is, and what it is priced at. */
export interface RateTableEntryWire {
  unit: string;
  usdPerUnit: number;
  /** where the number came from — a planning placeholder says so here */
  basis: string;
}

export type RateTableWire = Record<UsageEntry["kind"], RateTableEntryWire>;

/** `GET /api/hosted/apps/:id/usage`. */
export interface HostedUsage {
  quota: QuotaSummary;
  usage: UsageSummary;
  limits: HostedLimits;
  enforcement: LimitEnforcement;
  /** the API's own words for each enforcement value */
  enforcementLabels: Record<EnforcementKey, string>;
  /** The arithmetic behind the estimate, so it is checkable. */
  rateTable?: RateTableWire;
  disclosure: string;
}

export interface ThresholdState {
  threshold: number;
  crossed: boolean;
  crossedAt?: string;
}

export interface SpendingStatus {
  workspaceId: string;
  month: string;
  since: string;
  envelopeUsd: number;
  /** an estimate, never a bill */
  estimatedUsd: number;
  fraction: number;
  thresholds: Record<string, ThresholdState>;
  buildsPaused: { paused: boolean; reason: string };
  usage: UsageSummary;
  disclosure: string;
}

/** `GET /api/hosted/ops/spending`. */
export interface HostedSpendingPayload {
  workspace: { id: string; name: string };
  spending: SpendingStatus;
  /** Thresholds this read was the first to notice. Normally empty. */
  alertsRaised: number[];
  rateTable: RateTableWire;
  disclosure: string;
}
