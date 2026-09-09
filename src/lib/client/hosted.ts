"use client";
/**
 * Hosted apps — the browser's typed view of the control HTTP surface in
 * docs/hosted/CONTRACTS-R3.md ("Control HTTP surface"), as W5, W7 and W8 built
 * it. Every request the Apps screens make goes through this module, and every
 * wire shape is flattened here, so a change in the API is one file's problem.
 *
 * Nothing here invents an endpoint or a field. Where a screen wants something
 * the API does not send (how many people were invited, the domain apps sit
 * under before the first app exists) the value is optional and the screen says
 * what it does not know.
 *
 * Job ids are the client's: one UUID per user intent, kept in component state,
 * so a retry replays the same intent instead of starting a second one.
 *
 * Workstream W9 (hosted R3)
 */
import { useEffect, useMemo, useState } from "react";
import { api, useJson, type Loadable } from "@/lib/client/api";
import { downloadFile } from "@/components/screens/download-file";
import type {
  AppGrant,
  AppInvite,
  AppRole,
  AppState,
  Availability,
  BuildRunnerId,
  HostedApp,
  HostedJob,
  HostedLimits,
  InviteDelivery,
  JobStatus,
  LimitEnforcement,
  QuotaCounter,
  Release,
  RuntimeId,
  UsageEntry,
} from "@/lib/hosted/contracts";

/* ------------------------------ wire shapes ------------------------------- */

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
  /** owner only — its presence is how the caller learns they are one */
  grants?: AppGrant[];
  invites?: AppInvite[];
}

export interface HostedAppsWire {
  apps: AppSummaryWire[];
  limits: HostedLimits;
  /** null when the runtime could not be reached to ask */
  enforcement: LimitEnforcement | null;
  runtime: RuntimeInfo;
  builder: BuilderInfo[];
  /** not sent today; read when the API starts sending it */
  appDomain?: string;
  appScheme?: string;
}

/* ------------------------------ view models ------------------------------- */

/** An app plus the few read-only extras a card or a heading needs. */
export interface HostedAppSummary extends HostedApp {
  hostname: string;
  /** the private URL, ready to copy */
  url: string;
  activeRelease: Release | null;
  runningJob: HostedJob | null;
  /** present only where the API sends the audience (the owner's own app read) */
  grantCount?: number;
  inviteCount?: number;
}

export interface HostedAppsView {
  apps: HostedAppSummary[];
  limits: HostedLimits;
  enforcement: LimitEnforcement | null;
  runtime: RuntimeInfo;
  builders: BuilderInfo[];
  appDomain?: string;
  appScheme?: string;
}

export interface HostedAppView {
  app: HostedAppSummary;
  activeRelease: Release | null;
  releases: Release[];
  runningJob: HostedJob | null;
  recentJobs: HostedJob[];
  grants?: AppGrant[];
  invites?: AppInvite[];
  /** the API attaches grants only for an owner, so their presence is the role */
  isOwner: boolean;
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

export interface HostedUsage {
  quota: QuotaSummary;
  usage: UsageSummary;
  limits: HostedLimits;
  enforcement: LimitEnforcement;
  /** the API's own words for each enforcement value */
  enforcementLabels: Record<EnforcementKey, string>;
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

export interface HostedSpendingPayload {
  workspace: { id: string; name: string };
  spending: SpendingStatus;
  alertsRaised: number[];
  disclosure: string;
}

/* --------------------------------- jobs ----------------------------------- */

/**
 * A job's kept output. The runner stores each line as `<iso> <text>`, so the
 * timestamp is split off for display rather than shown inside the message.
 */
export interface HostedJobPayload {
  job: HostedJob;
  logs: string[];
}

export interface JobAccepted {
  job: HostedJob;
  jobId: string;
  /** false when this job id already existed: the same intent was replayed */
  created: boolean;
}

export type FixtureName = "tracker-app" | "minimal-app";

/** Exactly the discriminated union the publish route accepts; it is `.strict()`. */
export type PublishSource =
  | { kind: "fixture"; name: FixtureName }
  | { kind: "tarball"; base64: string };

export interface IssuedInvite {
  invite: AppInvite;
  delivery: InviteDelivery;
  /** in clear, this once only */
  acceptUrl: string;
}

export interface AcceptResult {
  app: { id: string; slug: string; name: string };
  grant: AppGrant;
  launchUrl: string;
}

/* -------------------------------- helpers --------------------------------- */

/** How often a screen re-reads an app while one of its jobs is moving. */
export const APP_POLL_MS = 5_000;
/** How often the job panel re-reads a job that has not settled. */
export const JOB_POLL_MS = 1_500;

export const isTerminalJob = (status: JobStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

const randomBytes = (n: number): Uint8Array => {
  const bytes = new Uint8Array(n);
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === "function") source.getRandomValues(bytes);
  else for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");

/**
 * One id per user intent. Generate it once, keep it in state, and reuse it on
 * every retry: the authority answers the same id and the same intent by
 * resuming the job it already has, so a retry cannot start a second publish.
 */
export function newJobId(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Opaque value echoed back by the app host on the launch callback. */
export const newLaunchState = (): string => hex(randomBytes(16));

/** The wire summary as one flat object the screens can read. */
export function flattenApp(wire: AppSummaryWire): HostedAppSummary {
  return {
    ...wire.app,
    hostname: wire.hostname,
    url: `${wire.origin.replace(/\/+$/, "")}/`,
    activeRelease: wire.activeRelease,
    runningJob: wire.runningJob,
    grantCount: wire.grants?.filter((g) => g.state === "active").length,
    inviteCount: wire.invites?.filter((i) => i.state === "pending").length,
  };
}

export interface DomainHint {
  appDomain?: string;
  appScheme: string;
}

/**
 * The domain new apps will sit under. The API states it when it can; otherwise
 * it is read back from an app that already exists. With neither, the screen
 * says the address appears once the app is created rather than guessing one.
 */
export function domainHint(view: HostedAppsView | undefined): DomainHint {
  if (view?.appDomain) return { appDomain: view.appDomain, appScheme: view.appScheme ?? "http" };
  for (const app of view?.apps ?? []) {
    const suffix = `${app.slug}.`;
    if (!app.hostname.startsWith(suffix)) continue;
    return {
      appDomain: app.hostname.slice(suffix.length),
      appScheme: app.url.startsWith("https") ? "https" : "http",
    };
  }
  return { appScheme: view?.appScheme ?? "http" };
}

/**
 * A `.tar.gz` as base64, read in the browser. `FileReader` gives a data URL;
 * everything after the comma is the payload the publish body carries.
 */
export function readTarballBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(
        new Error(
          `The browser could not read ${file.name}. Choose the file again, or copy it somewhere local first.`
        )
      );
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(
          new Error(
            `${file.name} could not be encoded for upload. Choose the file again, or rebuild the archive.`
          )
        );
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Keep a hook's loading/error/refresh, change only what `data` looks like. */
function useMapped<A, B>(source: Loadable<A>, project: (value: A) => B): Loadable<B> {
  const { data, error, loading, refresh } = source;
  const mapped = useMemo(() => (data === undefined ? undefined : project(data)), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data: mapped, error, loading, refresh };
}

/* --------------------------------- reads ---------------------------------- */

/** Every app in the workspace, plus the runtime, the runners and the limits. */
export function useHostedApps(): Loadable<HostedAppsView> {
  const [pollMs, setPollMs] = useState(0);
  const query = useJson<HostedAppsWire>("/api/hosted/apps", pollMs);
  const view = useMapped(query, (wire) => ({
    apps: wire.apps.map(flattenApp),
    limits: wire.limits,
    enforcement: wire.enforcement,
    runtime: wire.runtime,
    builders: wire.builder ?? [],
    appDomain: wire.appDomain,
    appScheme: wire.appScheme,
  }));
  const moving = (view.data?.apps ?? []).some(
    (app) =>
      (app.runningJob ? !isTerminalJob(app.runningJob.status) : false) || app.state === "recovering"
  );
  useEffect(() => {
    setPollMs(moving ? APP_POLL_MS : 0);
  }, [moving]);
  return view;
}

/** One app. Re-reads every 5 s while a job is running, and stops when it is not. */
export function useHostedApp(appId: string | null): Loadable<HostedAppView> {
  const [pollMs, setPollMs] = useState(0);
  const query = useJson<AppSummaryWire>(
    appId ? `/api/hosted/apps/${encodeURIComponent(appId)}` : null,
    pollMs
  );
  const view = useMapped(query, (wire) => ({
    app: flattenApp(wire),
    activeRelease: wire.activeRelease,
    releases: wire.releases,
    runningJob: wire.runningJob,
    recentJobs: wire.recentJobs,
    grants: wire.grants,
    invites: wire.invites,
    isOwner: Array.isArray(wire.grants),
  }));
  const job = view.data?.runningJob ?? null;
  const moving = Boolean(
    (job && !isTerminalJob(job.status)) || view.data?.app.state === "recovering"
  );
  useEffect(() => {
    setPollMs(moving ? APP_POLL_MS : 0);
  }, [moving]);
  return view;
}

/** One job and its logs, polled every 1.5 s until it succeeds, fails or is cancelled. */
export function useHostedJob(
  appId: string | null,
  jobId: string | null
): Loadable<HostedJobPayload> {
  const [pollMs, setPollMs] = useState(JOB_POLL_MS);
  const query = useJson<HostedJobPayload>(
    appId && jobId
      ? `/api/hosted/apps/${encodeURIComponent(appId)}/jobs/${encodeURIComponent(jobId)}`
      : null,
    pollMs
  );
  const settled = Boolean(query.data && isTerminalJob(query.data.job.status));
  useEffect(() => {
    setPollMs(settled ? 0 : JOB_POLL_MS);
  }, [settled]);
  return query;
}

export function useHostedGrants(appId: string | null): Loadable<{ grants: AppGrant[] }> {
  return useJson<{ grants: AppGrant[] }>(
    appId ? `/api/hosted/apps/${encodeURIComponent(appId)}/grants` : null
  );
}

export function useHostedInvites(appId: string | null): Loadable<{ invites: AppInvite[] }> {
  return useJson<{ invites: AppInvite[] }>(
    appId ? `/api/hosted/apps/${encodeURIComponent(appId)}/invites` : null
  );
}

/** Real probes against the app that is serving. Owner only. */
export function useHostedHealth(appId: string | null): Loadable<HostedHealth> {
  const query = useJson<{ health: HostedHealth }>(
    appId ? `/api/hosted/apps/${encodeURIComponent(appId)}/health` : null
  );
  return useMapped(query, (payload) => payload.health);
}

/** Counters, ledger, limits and the API's own enforcement wording. Owner only. */
export function useHostedUsage(appId: string | null): Loadable<HostedUsage> {
  return useJson<HostedUsage>(
    appId ? `/api/hosted/apps/${encodeURIComponent(appId)}/usage` : null
  );
}

/** Workspace spending. Pass `false` when the caller is not a workspace admin. */
export function useSpending(enabled = true): Loadable<HostedSpendingPayload> {
  return useJson<HostedSpendingPayload>(enabled ? "/api/hosted/ops/spending" : null);
}

/* -------------------------------- mutations ------------------------------- */

const post = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const createHostedApp = (input: { name: string; slug: string }): Promise<{ app: HostedApp }> =>
  post<{ app: HostedApp }>("/api/hosted/apps", input);

export const publishHostedApp = (
  appId: string,
  input: { jobId: string; source: PublishSource }
): Promise<JobAccepted> =>
  post<JobAccepted>(`/api/hosted/apps/${encodeURIComponent(appId)}/publish`, input);

export const rollbackHostedApp = (
  appId: string,
  input: { jobId: string; releaseId: string }
): Promise<JobAccepted> =>
  post<JobAccepted>(`/api/hosted/apps/${encodeURIComponent(appId)}/rollback`, input);

export const suspendHostedApp = (
  appId: string,
  input: { jobId: string; reason?: string }
): Promise<JobAccepted> =>
  post<JobAccepted>(`/api/hosted/apps/${encodeURIComponent(appId)}/suspend`, input);

export const resumeHostedApp = (
  appId: string,
  input: { jobId: string; reason?: string }
): Promise<JobAccepted> =>
  post<JobAccepted>(`/api/hosted/apps/${encodeURIComponent(appId)}/resume`, input);

export const changeGrantRole = (
  appId: string,
  grantId: string,
  role: AppRole
): Promise<{ grant: AppGrant }> =>
  api<{ grant: AppGrant }>(
    `/api/hosted/apps/${encodeURIComponent(appId)}/grants/${encodeURIComponent(grantId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) }
  );

export const revokeGrant = (
  appId: string,
  grantId: string,
  reason?: string
): Promise<{ grant: AppGrant; sessionsTerminated?: number }> =>
  api<{ grant: AppGrant; sessionsTerminated?: number }>(
    `/api/hosted/apps/${encodeURIComponent(appId)}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE", body: JSON.stringify(reason ? { reason } : {}) }
  );

export const createInvite = (
  appId: string,
  input: { email: string; role: AppRole }
): Promise<IssuedInvite> =>
  post<IssuedInvite>(`/api/hosted/apps/${encodeURIComponent(appId)}/invites`, input);

export const resendInvite = (appId: string, inviteId: string): Promise<IssuedInvite> =>
  post<IssuedInvite>(
    `/api/hosted/apps/${encodeURIComponent(appId)}/invites/${encodeURIComponent(inviteId)}/resend`,
    {}
  );

export const revokeInvite = (appId: string, inviteId: string): Promise<{ invite: AppInvite }> =>
  api<{ invite: AppInvite }>(
    `/api/hosted/apps/${encodeURIComponent(appId)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" }
  );

export const acceptHostedInvite = (token: string): Promise<AcceptResult> =>
  post<AcceptResult>("/api/hosted/invites/accept", { token });

/**
 * Ask for a single-use exchange code and follow the redirect to the app host.
 * The state is generated here and echoed back on the callback, so a redirect
 * that did not start with this click cannot complete.
 */
export async function launchHostedApp(appId: string): Promise<string> {
  const { redirect } = await post<{ redirect: string }>(
    `/api/hosted/apps/${encodeURIComponent(appId)}/launch`,
    { state: newLaunchState() }
  );
  if (typeof location !== "undefined") location.assign(redirect);
  return redirect;
}

/** Export bundle, saved by the browser — the same helper every export screen uses. */
export async function exportHostedApp(appId: string, slug?: string): Promise<void> {
  const bundle = await api<{ app?: { slug?: string }; exportedAt?: string }>(
    `/api/hosted/apps/${encodeURIComponent(appId)}/export`
  );
  const name = bundle.app?.slug ?? slug ?? "app";
  const stamp = (bundle.exportedAt ?? new Date().toISOString()).slice(0, 10);
  downloadFile(`zenith-${name}-${stamp}.json`, JSON.stringify(bundle, null, 2), "application/json");
}
