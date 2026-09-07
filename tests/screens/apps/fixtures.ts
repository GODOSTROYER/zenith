/**
 * Payloads the Apps screens are given, shaped exactly like the control HTTP
 * surface W5, W7 and W8 built, and flattened through the client module's own
 * mapper so a change there breaks these too. Not a test file — vitest only
 * picks up `*.test.tsx` here.
 *
 * Workstream W9 (hosted R3)
 */
import {
  flattenApp,
  type AppSummaryWire,
  type BuilderInfo,
  type HostedAppSummary,
  type HostedAppView,
  type HostedAppsView,
  type HostedHealth,
  type HostedUsage,
  type RuntimeInfo,
} from "@/lib/client/hosted";
import {
  DEFAULT_LIMITS,
  type AppGrant,
  type AppInvite,
  type HostedJob,
  type InviteDelivery,
  type LimitEnforcement,
  type Release,
} from "@/lib/hosted/contracts/types";

export const ISO = "2026-09-07T09:00:00.000Z";

export const DIGEST = "3f2a".repeat(16);

export const enforcement: LimitEnforcement = {
  buildsPerApp: "enforced",
  buildsPilotWide: "enforced",
  buildTimeoutMs: "enforced",
  requestCpuMs: "provider",
  outboundSubrequests: "provider",
  bodyBytes: "enforced",
  requestsPerDay: "enforced",
  storageBytes: "not_enforced",
};

export const runtime = (over: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  id: "local",
  label: "Local runtime — this control process serves the app from this machine.",
  availability: { available: true },
  ...over,
});

export const builder = (over: Partial<BuilderInfo> = {}): BuilderInfo => ({
  id: "recipe-local",
  label: "Recipe runner on this machine",
  boundary:
    "The build runs as a child process on this same host with a clean environment. It is not a sandbox for hostile code.",
  availability: { available: true },
  ...over,
});

export const release = (over: Partial<Release> = {}): Release => ({
  id: "rel-2",
  appId: "app-1",
  number: 2,
  artifactDigest: DIGEST,
  schemaVersion: 1,
  jobId: "job-1",
  status: "active",
  runtime: "local",
  runtimeRef: {},
  probe: {
    ok: true,
    checkedAt: ISO,
    checks: [{ id: "index_fetch", ok: true, detail: "The first page loaded." }],
    testDatabase: "candidate-test.sqlite",
  },
  createdAt: ISO,
  activatedAt: ISO,
  ...over,
});

export const job = (over: Partial<HostedJob> = {}): HostedJob => ({
  id: "11111111-2222-4333-8444-555555555555",
  kind: "publish",
  workspaceId: "ws-1",
  appId: "app-1",
  actor: "sub-owner",
  intentHash: "hash",
  status: "running",
  phase: "build",
  phaseData: {},
  attempts: 1,
  fenceToken: 3,
  createdAt: ISO,
  updatedAt: ISO,
  ...over,
});

/** An override where the app's own fields may be given one at a time. */
export type SummaryOverride = Partial<Omit<AppSummaryWire, "app">> & {
  app?: Partial<AppSummaryWire["app"]>;
};

/** `GET /api/hosted/apps/:id` as W7 answers it. */
export const summary = ({ app: appOver, ...rest }: SummaryOverride = {}): AppSummaryWire => ({
  app: {
    id: "app-1",
    workspaceId: "ws-1",
    slug: "equipment",
    name: "Equipment requests",
    contractVersion: 1,
    schemaVersion: 1,
    state: "active",
    createdBy: "sub-owner",
    createdAt: ISO,
    updatedAt: ISO,
    activeReleaseId: "rel-2",
    activeFence: 2,
    runtime: "local",
    ...appOver,
  },
  activeRelease: release(),
  releases: [release()],
  runningJob: null,
  recentJobs: [],
  hostname: "equipment.apps.localhost",
  origin: "http://equipment.apps.localhost",
  grants: [grant()],
  invites: [invite()],
  ...rest,
});

/** The flat app a card or a heading is handed. */
export const app = (over: SummaryOverride = {}): HostedAppSummary => flattenApp(summary(over));

export const listPayload = (over: Partial<HostedAppsView> = {}): HostedAppsView => ({
  apps: [app()],
  limits: DEFAULT_LIMITS,
  enforcement,
  runtime: runtime(),
  builders: [builder()],
  ...over,
});

export const detail = (over: Partial<HostedAppView> = {}): HostedAppView => {
  const wire = summary();
  return {
    app: flattenApp(wire),
    activeRelease: wire.activeRelease,
    releases: wire.releases,
    runningJob: wire.runningJob,
    recentJobs: wire.recentJobs,
    grants: wire.grants,
    invites: wire.invites,
    isOwner: true,
    ...over,
  };
};

export function grant(over: Partial<AppGrant> = {}): AppGrant {
  return {
    id: "grant-owner",
    appId: "app-1",
    subject: "sub-owner",
    email: "owner@example.com",
    role: "owner",
    state: "active",
    grantedBy: "sub-owner",
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

export function invite(over: Partial<AppInvite> = {}): AppInvite {
  return {
    id: "invite-1",
    appId: "app-1",
    email: "guest@example.com",
    role: "viewer",
    tokenHash: "hashed",
    state: "pending",
    createdBy: "sub-owner",
    createdAt: ISO,
    expiresAt: "2026-09-09T09:00:00.000Z",
    ...over,
  };
}

export const delivery = (over: Partial<InviteDelivery> = {}): InviteDelivery => ({
  id: "delivery-1",
  inviteId: "invite-1",
  state: "sent",
  attempts: 1,
  createdAt: ISO,
  transport: "smtp",
  ...over,
});

export const health = (over: Partial<HostedHealth> = {}): HostedHealth => ({
  simulated: false,
  appId: "app-1",
  slug: "equipment",
  state: "active",
  checkedAt: ISO,
  runtime: { id: "local", label: "This control host (single machine, labelled as such)", enforcement },
  release: { id: "rel-2", number: 2, digest: DIGEST },
  ok: true,
  checks: [
    { id: "active_release", ok: true, detail: "Release 2 is serving." },
    { id: "data_quick_check", ok: true, detail: "A record was written and read back." },
  ],
  lastEvents: {
    since: ISO,
    total: 14,
    writes: 9,
    denials: 1,
    conflicts: 0,
    errors: 0,
    byEvent: { "record.created": 9, "access.denied": 1 },
  },
  quota: { day: "2026-09-07", requests: 42, denied: 1, limit: DEFAULT_LIMITS.requestsPerDay },
  ...over,
});

export const usage = (over: Partial<HostedUsage> = {}): HostedUsage => ({
  quota: {
    appId: "app-1",
    today: "2026-09-07",
    current: { appId: "app-1", day: "2026-09-07", requests: 42, denied: 1 },
    limit: DEFAULT_LIMITS.requestsPerDay,
    days: [],
    disclosure:
      "Counted by Zenith on every request that resolved to this app, whatever the outcome, and reset at 00:00 UTC.",
  },
  usage: {
    workspaceId: "ws-1",
    since: ISO,
    byKind: [
      {
        kind: "storage_bytes",
        amount: 2 * 1_048_576,
        entries: 1,
        estimatedUsd: 0,
        unit: "bytes",
        basis: "logical bytes of stored fields",
      },
    ],
    estimatedUsd: 0.12,
    invoicedUsd: 0,
    disclosure: "Estimated from the rate table, not a bill.",
  },
  limits: DEFAULT_LIMITS,
  enforcement,
  enforcementLabels: {
    enforced: "Enforced here by Zenith, and tested.",
    provider: "Enforced by the provider (Cloudflare), not by Zenith.",
    not_enforced: "Not enforced by this runtime — shown because it applies on Cloudflare.",
  },
  disclosure: "Estimates, not invoices.",
  ...over,
});

/** What `useShell()` hands a screen. Only `boot` is read by these screens. */
export const shell = (role: "admin" | "editor" | "viewer" | null = "editor") => ({
  boot: {
    workspace: { id: "ws-1", name: "Kepler Labs" },
    role,
    user: { id: "sub-owner", email: "owner@example.com", name: "Owner" },
  },
  loading: false,
  error: undefined,
  refresh: () => {},
  catalog: [],
});

/** A `Loadable` with data in it. */
export const loaded = <T,>(data: T) => ({
  data,
  error: undefined,
  loading: false,
  refresh: () => {},
});

export const idle = () => ({
  data: undefined,
  error: undefined,
  loading: false,
  refresh: () => {},
});
