/**
 * Real health and real logs for a hosted app, with release attribution (G28).
 *
 * Every check below reads something: a row in the control authority, a pragma
 * on the app's own database, the artifact's bytes re-hashed from disk, the
 * event table. **There is no `simulated: true` anywhere in this file, and
 * there never will be** — the infrastructure product has a labelled simulated
 * health surface and that is a different thing entirely. A probe that cannot
 * run answers `ok: false` with the reason, which is a *result*; inventing a
 * green tick would be a lie the moment someone relied on it.
 *
 * "Logs" here are the app's own event rows rendered as lines, not the server's
 * stdout. They are content-free by construction — an event carries counts,
 * codes and a release id, never a record's contents or a person's identity —
 * so showing them to an app owner discloses nothing about what their
 * colleagues wrote. Each line carries the release that served the request,
 * which is what makes "it broke after the update" answerable.
 *
 * Workstream W8 (hosted R3).
 */
import {
  DEFAULT_LIMITS,
  type AppState,
  type ArtifactStore,
  type HostedEvent,
  type LimitEnforcement,
  type RuntimeId,
} from "@/lib/hosted/contracts";
import { authority, utcDay } from "@/lib/hosted/authority";
import { FsArtifactStore } from "@/lib/hosted/artifacts";
import { hostedConfig } from "@/lib/hosted/config";
import { LATEST_TRACKER_SCHEMA_VERSION, openAppData, trackerSql } from "@/lib/hosted/data";
import { enforcementFor } from "@/lib/hosted/quota";

/** One probe and what it found. */
export interface HealthCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** What the app's own event rows said over a window. */
export interface EventDigest {
  since: string;
  total: number;
  /** `record.created` + `record.updated` that succeeded. */
  writes: number;
  /** Anything recorded with outcome `denied`, whatever the event. */
  denials: number;
  /** `record.conflict`: two editors, one record. */
  conflicts: number;
  /** Anything recorded with outcome `error`. */
  errors: number;
  /** Count per event name, so a reader can see what actually happened. */
  byEvent: Record<string, number>;
}

/** The health of one hosted app. Never simulated. */
export interface AppHealth {
  /** Always false. Hosted health is measured or it is a failed check. */
  simulated: false;
  appId: string;
  slug: string;
  state: AppState;
  stateReason?: string;
  checkedAt: string;
  runtime: { id: RuntimeId; label: string; enforcement: LimitEnforcement };
  /** The release that is serving, or null when nothing is. */
  release: { id: string; number: number; digest: string } | null;
  /** True only when every check passed. */
  ok: boolean;
  checks: HealthCheck[];
  lastEvents: EventDigest;
  quota: { day: string; requests: number; denied: number; limit: number };
}

/** How long back the event digest looks. */
const EVENT_WINDOW_MS = 24 * 60 * 60_000;

const RUNTIME_LABELS: Record<RuntimeId, string> = {
  local: "This control host (single machine, labelled as such)",
  cloudflare: "Cloudflare Workers for Platforms",
};

/** Probe one app for real and report what every probe found. */
export async function appHealth(
  appId: string,
  options: { artifacts?: ArtifactStore; now?: Date } = {}
): Promise<AppHealth> {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const a = authority();
  const runtimeId = hostedConfig().ZENITH_RUNTIME;
  const runtime = { id: runtimeId, label: RUNTIME_LABELS[runtimeId], enforcement: enforcementFor(runtimeId) };
  const checks: HealthCheck[] = [];

  const app = a.repos.apps.get(appId);
  if (!app) {
    return {
      simulated: false,
      appId,
      slug: "",
      state: "deleted",
      checkedAt,
      runtime,
      release: null,
      ok: false,
      checks: [
        {
          id: "authority_row",
          ok: false,
          detail: `The control authority holds no app with the id ${appId}.`,
        },
      ],
      lastEvents: emptyDigest(new Date(now.getTime() - EVENT_WINDOW_MS).toISOString()),
      quota: { day: utcDay(now), requests: 0, denied: 0, limit: DEFAULT_LIMITS.requestsPerDay },
    };
  }

  checks.push({
    id: "authority_row",
    ok: app.state === "active",
    detail:
      app.state === "active"
        ? `The app row is present and active, fence ${app.activeFence}.`
        : `The app row is present but its state is "${app.state}"${app.stateReason ? `: ${app.stateReason}` : "."}`,
  });

  /* ------------------------------- release ------------------------------- */

  const release = app.activeReleaseId ? a.repos.releases.get(app.activeReleaseId) : null;
  if (!app.activeReleaseId)
    checks.push({
      id: "active_release",
      ok: false,
      detail: "This app has never activated a release, so there is nothing for it to serve.",
    });
  else if (!release)
    checks.push({
      id: "active_release",
      ok: false,
      detail: `The active pointer names release ${app.activeReleaseId} and no such release exists.`,
    });
  else
    checks.push({
      id: "active_release",
      ok: true,
      detail: `Release ${release.number} (${release.id.slice(0, 8)}) activated ${release.activatedAt ?? "at an unrecorded time"}.`,
    });

  if (release) {
    const store = options.artifacts ?? new FsArtifactStore();
    try {
      const verdict = await store.verify(release.artifactDigest);
      checks.push({
        id: "artifact_verified",
        ok: verdict.ok,
        detail: verdict.ok
          ? `Artifact ${release.artifactDigest.slice(0, 12)} re-hashed from its stored bytes: ${verdict.detail}`
          : `Artifact ${release.artifactDigest.slice(0, 12)} does not match its own manifest: ${verdict.detail}`,
      });
    } catch (error) {
      checks.push({
        id: "artifact_verified",
        ok: false,
        detail: `Artifact ${release.artifactDigest.slice(0, 12)} could not be read: ${message(error)}`,
      });
    }
  }

  /* --------------------------------- data -------------------------------- */

  let records: number | null = null;
  try {
    const data = openAppData(appId);
    // Reads only: a pragma and two counts. A health check never writes to a
    // customer's database.
    const rows = data.backend.all<{ quick_check?: unknown }>("PRAGMA quick_check");
    const ok = rows.length === 1 && String(rows[0]?.quick_check) === "ok";
    checks.push({
      id: "data_quick_check",
      ok,
      detail: ok
        ? "PRAGMA quick_check on the app's database reported ok."
        : `PRAGMA quick_check reported: ${rows.map((row) => String(row?.quick_check)).join("; ") || "no result"}`,
    });

    const version = await data.store.schemaVersion(appId);
    checks.push({
      id: "schema_version",
      ok: version === LATEST_TRACKER_SCHEMA_VERSION,
      detail:
        version === LATEST_TRACKER_SCHEMA_VERSION
          ? `Tracker schema version ${version}, which this build serves.`
          : `Tracker schema version ${version}; this build serves version ${LATEST_TRACKER_SCHEMA_VERSION}.`,
    });

    records = Number(data.backend.get<{ total: number }>(trackerSql.COUNT_REQUESTS)?.total ?? 0);
    const bytes = await data.store.storageBytes(appId);
    checks.push({
      id: "records",
      ok: true,
      detail: `${records} equipment request(s), ${bytes} of ${data.store.storageLimitBytes} logical bytes used.`,
    });
  } catch (error) {
    checks.push({ id: "data_quick_check", ok: false, detail: `The app's database could not be opened: ${message(error)}` });
    checks.push({ id: "schema_version", ok: false, detail: "Not checked: the app's database could not be opened." });
    checks.push({ id: "records", ok: false, detail: "Not counted: the app's database could not be opened." });
  }

  /* ------------------------------- activity ------------------------------ */

  const since = new Date(now.getTime() - EVENT_WINDOW_MS).toISOString();
  const lastEvents = digest(a.repos.events.listSince({ appId, since }, { limit: 5000 }), since);
  const day = utcDay(now);
  const counter = a.repos.quotas.get(appId, day);

  return {
    simulated: false,
    appId,
    slug: app.slug,
    state: app.state,
    stateReason: app.stateReason,
    checkedAt,
    runtime,
    release: release ? { id: release.id, number: release.number, digest: release.artifactDigest } : null,
    ok: checks.every((check) => check.ok),
    checks,
    lastEvents,
    quota: { day, requests: counter.requests, denied: counter.denied, limit: DEFAULT_LIMITS.requestsPerDay },
  };
}

const emptyDigest = (since: string): EventDigest => ({
  since,
  total: 0,
  writes: 0,
  denials: 0,
  conflicts: 0,
  errors: 0,
  byEvent: {},
});

function digest(events: HostedEvent[], since: string): EventDigest {
  const out = emptyDigest(since);
  out.total = events.length;
  for (const event of events) {
    out.byEvent[event.event] = (out.byEvent[event.event] ?? 0) + 1;
    if (event.outcome === "denied") out.denials += 1;
    if (event.outcome === "error") out.errors += 1;
    if (event.event === "record.conflict") out.conflicts += 1;
    if ((event.event === "record.created" || event.event === "record.updated") && event.outcome === "ok")
      out.writes += 1;
  }
  return out;
}

/* ---------------------------------- logs ---------------------------------- */

/** One rendered log line and the fields it was rendered from. */
export interface AppLogLine {
  ts: string;
  releaseId: string | null;
  event: string;
  outcome: HostedEvent["outcome"];
  /** `<ts> [<releaseId>] <event> <outcome>`, plus any counts the event carried. */
  line: string;
}

/** Recent activity for one app, newest last, rendered as lines. */
export function appLogs(
  appId: string,
  options: { limit?: number; since?: string } = {}
): { appId: string; lines: AppLogLine[]; disclosure: string } {
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100)));
  const events = authority().repos.events.listSince(
    { appId, ...(options.since ? { since: options.since } : {}) },
    { limit }
  );
  return {
    appId,
    lines: events.map(render),
    disclosure:
      "These are this app's own recorded events, not the server's output. They carry the release that served each request, counts and outcomes — never a record's contents and never a person's identity.",
  };
}

function render(event: HostedEvent): AppLogLine {
  const release = event.releaseId ?? null;
  const props = event.props
    ? Object.entries(event.props)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ")
    : "";
  return {
    ts: event.ts,
    releaseId: release,
    event: event.event,
    outcome: event.outcome,
    line: `${event.ts} [${release ?? "no-release"}] ${event.event} ${event.outcome}${props ? ` ${props}` : ""}`,
  };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
