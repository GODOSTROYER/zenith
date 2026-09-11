/**
 * Activation and lifecycle events: pseudonymous, deduplicated, founder/test
 * aware — and the scorecard computed from them.
 *
 * Three properties this module exists to guarantee.
 *
 *  - **A subject is never stored.** `recordEvent` writes `subjectHash`, an
 *    HMAC-SHA256 of the subject under `ZENITH_EVENTS_SALT`. The salt lives
 *    outside the database, so a copy of `control.sqlite` cannot be walked back
 *    to a person by hashing candidate ids. With no salt set the hash is
 *    *omitted* rather than replaced by a plain SHA-256 of the subject, which
 *    would be a reversible pseudonym pretending to be a private one; the
 *    per-subject measures then report `unknown` instead of a number.
 *  - **Recording never breaks a request.** Every path here is wrapped: a
 *    closed authority, a busy database or a malformed prop is a `log.warn`,
 *    not a 500 on a customer's save. Analytics that can take the product down
 *    is worse than no analytics.
 *  - **A retry is one operation, not two.** `(event, logicalId)` is unique in
 *    the authority, so a replayed publish or a retried write records once. A
 *    metric that counted attempts would report growth that never happened.
 *
 * The scorecard implements the gap analysis' section-11 definitions. Every
 * measure carries its `n` and says `unknown` — never 0, never a guess — when
 * it has no data or an immature cohort. Founder and test actors are excluded
 * from the human-behaviour measures; each metric states its own exclusion rule
 * in `definition`, because they are not the same rule.
 */
import { createHmac, randomUUID } from "node:crypto";
import {
  HOSTED_EVENTS,
  type ActorClass,
  type HostedEvent,
  type HostedEventName,
  type Subject,
} from "@/lib/hosted/contracts";
import { authority, authorityOpen, type EventQuery } from "@/lib/hosted/authority";
import { hostedConfig } from "@/lib/hosted/config";
import { log } from "@/lib/log";

/* --------------------------------- input ---------------------------------- */

/** What a caller supplies to record one event. */
export interface RecordEventInput {
  event: HostedEventName;
  workspaceId: string;
  appId?: string;
  /** The acting subject. Hashed on the way in; never stored as given. */
  subject?: Subject;
  /**
   * The acting identity's email, used only to classify the actor (an
   * `example.test` address is a test actor). Never stored, never hashed into
   * the row.
   */
  email?: string;
  releaseId?: string;
  outcome?: "ok" | "error" | "denied";
  logicalId?: string;
  assisted?: boolean;
  props?: Record<string, string | number | boolean>;
  /** Overrides the timestamp. Tests and back-fills only. */
  ts?: string;
}

/**
 * The workspace id install-wide events are filed under.
 *
 * `hosted_events.workspace_id` is NOT NULL, and a backup or a restore belongs
 * to the install rather than to any one workspace. A sentinel that cannot
 * collide with a real workspace id is more honest than filing those events
 * under whichever workspace happened to sort first.
 */
export const INSTALL_WORKSPACE = "__install";

/** Email domains whose holders are test actors, excluded from activation metrics. */
export const TEST_EMAIL_DOMAINS = ["example.test", "zenith.test"] as const;

/* ------------------------------ pseudonymity ------------------------------ */

type EventsGlobal = typeof globalThis & { __zenithEventsSaltWarned?: boolean };

/** The configured salt, or undefined. Read per call so a test can set it late. */
const eventsSalt = (): string | undefined => {
  const raw = process.env.ZENITH_EVENTS_SALT;
  return raw === undefined || raw.trim() === "" ? undefined : raw;
};

/** Subjects named as test actors by `ZENITH_TEST_SUBJECTS` (comma separated). */
function testSubjects(): Set<string> {
  const raw = process.env.ZENITH_TEST_SUBJECTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * The stored pseudonym for a subject, or undefined when no salt is configured.
 *
 * Exported because the scorecard has to hash an app's `createdBy` subject to
 * ask "was this write by someone other than the person who built the app?" —
 * the events themselves hold only hashes.
 *
 * Not `subjectHashUnchecked` from `@/lib/hosted/access/internal`: that one
 * always returns a hash, salted or not; this one refuses and warns.
 */
export function subjectHash(subject: Subject): string | undefined {
  const salt = eventsSalt();
  if (!salt) {
    const g = globalThis as EventsGlobal;
    if (!g.__zenithEventsSaltWarned) {
      g.__zenithEventsSaltWarned = true;
      log.warn("ZENITH_EVENTS_SALT is not set, so hosted events are recorded without a subject hash", {
        scope: "hosted.events",
        effect:
          "Per-person measures (recipient conversion, time to useful action, next-week return) will report unknown.",
        fix: "Set ZENITH_EVENTS_SALT in .env.local to a random string and keep it stable — changing it renames every existing pseudonym.",
      });
    }
    return undefined;
  }
  return createHmac("sha256", salt).update(subject, "utf8").digest("hex");
}

/** True when this process can compute subject hashes at all. */
export const eventsSalted = (): boolean => eventsSalt() !== undefined;

/**
 * Which class of actor this is, for the exclusions the scorecard applies.
 *
 * Order matters: a founder subject that also carries a test address is a
 * founder, and no subject at all is the system acting on its own behalf
 * (a scheduled backup, a restore, an outbox handler).
 */
export function actorClassOf(subject?: Subject, email?: string): ActorClass {
  if (!subject) return "system";
  if (hostedConfig().founderSubjects.has(subject)) return "founder";
  if (testSubjects().has(subject)) return "test";
  const domain = (email ?? "").toLowerCase().split("@")[1] ?? "";
  if (domain && (TEST_EMAIL_DOMAINS as readonly string[]).includes(domain)) return "test";
  return "external";
}

/* -------------------------------- recording ------------------------------- */

/**
 * Record one event. Returns true only when this call wrote a new row —
 * `false` means it was a duplicate of an already recorded logical operation,
 * or that recording was not possible and the reason was logged.
 *
 * Never throws. Callers put this on the happy path of a request handler.
 */
export async function recordEvent(input: RecordEventInput): Promise<boolean> {
  try {
    if (!authorityOpen()) return false;
    if (!(HOSTED_EVENTS as readonly string[]).includes(input.event)) {
      log.warn("refused to record an unknown hosted event name", {
        scope: "hosted.events",
        event: input.event,
      });
      return false;
    }
    const a = authority();
    const { inserted } = await a.tx(async (repos) =>
      repos.events.append({
        id: randomUUID(),
        event: input.event,
        workspaceId: input.workspaceId,
        appId: input.appId,
        subjectHash: input.subject === undefined ? undefined : subjectHash(input.subject),
        releaseId: input.releaseId,
        outcome: input.outcome ?? "ok",
        logicalId: input.logicalId,
        assisted: input.assisted ?? false,
        actorClass: actorClassOf(input.subject, input.email),
        props: input.props,
        ts: input.ts,
      })
    );
    return inserted;
  } catch (error) {
    log.warn("hosted event was not recorded", {
      scope: "hosted.events",
      event: input.event,
      appId: input.appId,
      error,
    });
    return false;
  }
}

/** Which slice of the event log to read. */
export interface ListEventsQuery extends EventQuery {
  limit?: number;
}

/** Events in the slice, oldest first. Bounded; the default is the repository's. */
export async function listEvents(query: ListEventsQuery = {}): Promise<HostedEvent[]> {
  const { limit, ...slice } = query;
  return authority().repos.events.listSince(slice, limit === undefined ? {} : { limit });
}

/* -------------------------------- scorecard ------------------------------- */

/** One measure, with everything a reader needs to judge it. */
export interface ScorecardMetric {
  id: string;
  label: string;
  /** Exactly what is counted, including which actors are excluded. */
  definition: string;
  /** The headline number, or null when the measure is unknown. */
  value: number | null;
  unit: "count" | "ratio" | "milliseconds";
  /** How many observations `value` rests on. */
  n: number;
  /** True when there is not enough data; `value` is then null. */
  unknown: boolean;
  /** Why it is unknown. Present only when it is. */
  reason?: string;
  /** Supporting counts. Always present, even when the headline is unknown. */
  detail: Record<string, number | string | null>;
}

/** The six section-11 measures, plus what was excluded to compute them. */
export interface Scorecard {
  since: string;
  until: string;
  generatedAt: string;
  /** False when `ZENITH_EVENTS_SALT` is unset: per-person measures are unknown. */
  salted: boolean;
  /** How many events in the window each actor class contributed. */
  actors: Record<ActorClass, number>;
  events: number;
  metrics: {
    teamActivation: ScorecardMetric;
    publishSuccess: ScorecardMetric;
    recipientConversion: ScorecardMetric;
    timeToUsefulAction: ScorecardMetric;
    nextWeekReturn: ScorecardMetric;
    founderAssistance: ScorecardMetric;
  };
  /** What this scorecard cannot answer, in the reader's own words. */
  limitations: string[];
}

/** The window a scorecard covers. */
export interface ScorecardWindow {
  since: string;
  until?: string;
  /** Rows to scan. Defaults to 100 000; a pilot produces far fewer. */
  limit?: number;
}

const WRITE_EVENTS: readonly HostedEventName[] = ["record.created", "record.updated"];
const DAY_MS = 24 * 60 * 60_000;
const COHORT_MATURITY_MS = 14 * DAY_MS;

const unknownMetric = (
  base: Omit<ScorecardMetric, "value" | "unknown" | "reason">,
  reason: string
): ScorecardMetric => ({ ...base, value: null, unknown: true, reason });

/** The median of a non-empty list of numbers. Even lengths take the mean of the middle two. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The activation scorecard for one window.
 *
 * Reads the event table and the app table; writes nothing. Every measure that
 * cannot be computed says so with a reason rather than reporting a zero that
 * would read as "we measured, and it is none".
 */
export async function scorecard(window: ScorecardWindow): Promise<Scorecard> {
  const since = window.since;
  const until = window.until ?? new Date().toISOString();
  const a = authority();
  const events = (
    await a.repos.events.listSince({ since }, { limit: window.limit ?? 100_000 })
  ).filter((event) => event.ts <= until);

  const apps = new Map((await a.repos.apps.listAll()).map((app) => [app.id, app]));
  const salted = eventsSalted();
  // The pseudonym of each app's creator, so "someone other than the builder"
  // is answerable from hashes alone.
  const builderHash = new Map<string, string | undefined>();
  for (const [id, app] of apps) builderHash.set(id, salted ? subjectHash(app.createdBy) : undefined);

  const actors: Record<ActorClass, number> = { founder: 0, test: 0, external: 0, system: 0 };
  for (const event of events) actors[event.actorClass] += 1;

  const writes = events.filter((event) => WRITE_EVENTS.includes(event.event) && event.outcome === "ok");
  /**
   * The writes every human measure is built on: a successful record write, by
   * an external actor, that is not the write of the person who created the
   * app. The builder saving something in their own app is the one action that
   * proves nothing about anybody else adopting it — the gap analysis calls
   * this "non-builder action" and applies it to activation *and* to return.
   * A write whose app is no longer in the table keeps the benefit of the
   * doubt: it cannot be shown to be the builder's.
   */
  const humanWrites = writes.filter(
    (event) =>
      event.actorClass === "external" &&
      event.subjectHash !== undefined &&
      (event.appId === undefined || event.subjectHash !== builderHash.get(event.appId))
  );

  return {
    since,
    until,
    generatedAt: new Date().toISOString(),
    salted,
    actors,
    events: events.length,
    metrics: {
      teamActivation: teamActivation(humanWrites, apps, salted),
      publishSuccess: publishSuccess(events),
      recipientConversion: recipientConversion(events, humanWrites, salted),
      timeToUsefulAction: timeToUsefulAction(events, humanWrites, salted),
      nextWeekReturn: nextWeekReturn(humanWrites, until, salted),
      founderAssistance: founderAssistance(events),
    },
    limitations: [
      "Counted from this install's own event table only. Events are recorded on the control host; anything that never reached it was never counted.",
      "Founder assistance is counted as events flagged `assisted`; the minutes a founder actually spent are not instrumented anywhere and are reported as unknown.",
      "Recipient conversion uses invitations *sent*, not delivered: SMTP acceptance is not mailbox delivery, so the denominator is generous by exactly the number of bounces.",
      salted
        ? "Per-person measures identify people by an HMAC of their subject; two accounts held by one human count as two people."
        : "ZENITH_EVENTS_SALT is unset, so no event carries a subject hash and every per-person measure is unknown.",
    ],
  };
}

/**
 * Team activation: a workspace where someone other than the person who created
 * the app saved real work.
 */
function teamActivation(
  humanWrites: HostedEvent[],
  apps: Map<string, { workspaceId: string }>,
  salted: boolean
): ScorecardMetric {
  const base = {
    id: "team_activation",
    label: "Teams activated",
    definition:
      "A workspace counts as activated when, inside the window, at least one equipment request was created or updated for one of its apps by an external actor (not founder, not test, not the system) whose subject hash differs from the hash of that app's creator. Workspaces holding at least one app are the denominator.",
    unit: "count" as const,
  };
  const workspaces = new Set<string>();
  for (const app of apps.values()) workspaces.add(app.workspaceId);
  if (workspaces.size === 0)
    return unknownMetric(
      { ...base, n: 0, detail: { workspaces: 0, activated: 0 } },
      "No app has been created yet."
    );
  if (!salted)
    return unknownMetric(
      { ...base, n: workspaces.size, detail: { workspaces: workspaces.size, activated: null } },
      "ZENITH_EVENTS_SALT is unset, so a write cannot be told apart from a write by the app's own builder."
    );

  const activated = new Set<string>();
  let qualifying = 0;
  for (const event of humanWrites) {
    const app = event.appId ? apps.get(event.appId) : undefined;
    if (!app) continue;
    qualifying += 1;
    activated.add(app.workspaceId);
  }
  return {
    ...base,
    value: activated.size,
    n: workspaces.size,
    unknown: false,
    detail: { workspaces: workspaces.size, activated: activated.size, qualifyingWrites: qualifying },
  };
}

/** Publish success: activated releases over started builds, by logical job. */
function publishSuccess(events: HostedEvent[]): ScorecardMetric {
  const base = {
    id: "publish_success",
    label: "Publish success rate",
    definition:
      "Distinct logical jobs that reached `release.activated`, over distinct logical jobs that reached `build.started`, inside the window. Test actors are excluded; founder attempts are counted, because this measures the platform rather than a customer's behaviour. A job that started before the window and activated inside it inflates the ratio; one still running deflates it.",
    unit: "ratio" as const,
  };
  const jobs = (name: HostedEventName): Set<string> => {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.event !== name || event.actorClass === "test") continue;
      ids.add(event.logicalId ?? event.id);
    }
    return ids;
  };
  const started = jobs("build.started");
  const activated = jobs("release.activated");
  if (started.size === 0)
    return unknownMetric(
      { ...base, n: 0, detail: { started: 0, activated: activated.size } },
      "No build was started inside the window."
    );
  return {
    ...base,
    value: activated.size / started.size,
    n: started.size,
    unknown: false,
    detail: { started: started.size, activated: activated.size },
  };
}

/** Recipient conversion: invitation sent → accepted → first useful action. */
function recipientConversion(
  events: HostedEvent[],
  humanWrites: HostedEvent[],
  salted: boolean
): ScorecardMetric {
  const base = {
    id: "recipient_conversion",
    label: "Recipient conversion",
    definition:
      "Of the invitations *sent* in the window (the denominator — delivery is not verified), how many were accepted, and of those acceptors how many then created or updated a request. Acceptance and the useful action count external actors only; the send is counted whoever sent it, because the actor on a send is the inviter rather than the recipient.",
    unit: "ratio" as const,
  };
  const sent = new Set(events.filter((e) => e.event === "invite.sent").map((e) => e.logicalId ?? e.id));
  if (sent.size === 0)
    return unknownMetric(
      { ...base, n: 0, detail: { sent: 0, accepted: null, useful: null } },
      "No invitation was sent inside the window."
    );
  if (!salted)
    return unknownMetric(
      { ...base, n: sent.size, detail: { sent: sent.size, accepted: null, useful: null } },
      "ZENITH_EVENTS_SALT is unset, so an acceptance cannot be linked to the action that followed it."
    );

  const accepted = new Set<string>();
  for (const event of events)
    if (event.event === "invite.accepted" && event.actorClass === "external" && event.subjectHash)
      accepted.add(event.subjectHash);
  const acted = new Set<string>();
  for (const event of humanWrites)
    if (event.subjectHash && accepted.has(event.subjectHash)) acted.add(event.subjectHash);
  return {
    ...base,
    value: acted.size / sent.size,
    n: sent.size,
    unknown: false,
    detail: { sent: sent.size, accepted: accepted.size, useful: acted.size },
  };
}

/** Time to useful action: acceptance → first record write, median. */
function timeToUsefulAction(
  events: HostedEvent[],
  humanWrites: HostedEvent[],
  salted: boolean
): ScorecardMetric {
  const base = {
    id: "time_to_useful_action",
    label: "Time to first useful action (median)",
    definition:
      "Median milliseconds from `invite.accepted` to that person's first `record.created`/`record.updated`, per subject hash, external actors only. People who accepted but never wrote are not in the median and are counted separately; email delivery delay happens before the acceptance and is therefore not included.",
    unit: "milliseconds" as const,
  };
  if (!salted)
    return unknownMetric(
      { ...base, n: 0, detail: { accepted: null, acted: null } },
      "ZENITH_EVENTS_SALT is unset, so per-person timings cannot be computed."
    );

  const acceptedAt = new Map<string, string>();
  for (const event of events) {
    if (event.event !== "invite.accepted" || event.actorClass !== "external" || !event.subjectHash) continue;
    const seen = acceptedAt.get(event.subjectHash);
    if (seen === undefined || event.ts < seen) acceptedAt.set(event.subjectHash, event.ts);
  }
  const firstWrite = new Map<string, string>();
  for (const event of humanWrites) {
    if (!event.subjectHash) continue;
    const seen = firstWrite.get(event.subjectHash);
    if (seen === undefined || event.ts < seen) firstWrite.set(event.subjectHash, event.ts);
  }
  const deltas: number[] = [];
  for (const [hash, accepted] of acceptedAt) {
    const wrote = firstWrite.get(hash);
    if (wrote === undefined) continue;
    const delta = Date.parse(wrote) - Date.parse(accepted);
    if (Number.isFinite(delta) && delta >= 0) deltas.push(delta);
  }
  const detail: Record<string, number | string | null> = {
    accepted: acceptedAt.size,
    acted: deltas.length,
    minMs: deltas.length ? Math.min(...deltas) : null,
    maxMs: deltas.length ? Math.max(...deltas) : null,
  };
  if (deltas.length === 0)
    return unknownMetric(
      { ...base, n: 0, detail },
      "Nobody who accepted an invitation in this window has written a request yet."
    );
  return { ...base, value: median(deltas), n: deltas.length, unknown: false, detail };
}

/** Next-week return: a second week of real work, mature cohorts only. */
function nextWeekReturn(humanWrites: HostedEvent[], until: string, salted: boolean): ScorecardMetric {
  const base = {
    id: "next_week_return",
    label: "Next-week return",
    definition:
      "Of the external, non-builder actors whose first request write is at least 14 days before the end of the window (a mature cohort), how many wrote another request on days 7-13 after that first write. Page views do not count — only a created or updated record does, and a write in an app by the person who created it never counts.",
    unit: "ratio" as const,
  };
  if (!salted)
    return unknownMetric(
      { ...base, n: 0, detail: { cohort: null, immature: null, returned: null } },
      "ZENITH_EVENTS_SALT is unset, so a return visit cannot be attributed to the same person."
    );

  const first = new Map<string, string>();
  const byPerson = new Map<string, string[]>();
  for (const event of humanWrites) {
    if (!event.subjectHash) continue;
    const seen = first.get(event.subjectHash);
    if (seen === undefined || event.ts < seen) first.set(event.subjectHash, event.ts);
    const all = byPerson.get(event.subjectHash) ?? [];
    all.push(event.ts);
    byPerson.set(event.subjectHash, all);
  }
  const end = Date.parse(until);
  let mature = 0;
  let immature = 0;
  let returned = 0;
  for (const [hash, firstTs] of first) {
    const start = Date.parse(firstTs);
    if (end - start < COHORT_MATURITY_MS) {
      immature += 1;
      continue;
    }
    mature += 1;
    const from = start + 7 * DAY_MS;
    const to = start + 14 * DAY_MS;
    const again = (byPerson.get(hash) ?? []).some((ts) => {
      const at = Date.parse(ts);
      return at >= from && at < to;
    });
    if (again) returned += 1;
  }
  const detail = { cohort: mature, immature, returned };
  if (mature === 0)
    return unknownMetric(
      { ...base, n: 0, detail },
      immature > 0
        ? `Every cohort is younger than 14 days (${immature} ${immature === 1 ? "person" : "people"}), so days 7-13 cannot be observed yet.`
        : "No external actor has written a request inside the window."
    );
  return { ...base, value: returned / mature, n: mature, unknown: false, detail };
}

/** Founder assistance: how much of what happened was helped along. */
function founderAssistance(events: HostedEvent[]): ScorecardMetric {
  const base = {
    id: "founder_assistance",
    label: "Founder-assisted events",
    definition:
      "Events inside the window flagged `assisted` — an action a founder walked someone through or performed on their behalf. The minutes spent are not instrumented and are reported as unknown; a falling share here is what would justify calling the product self-service.",
    unit: "count" as const,
  };
  if (events.length === 0)
    return unknownMetric(
      { ...base, n: 0, detail: { events: 0, assisted: 0, minutes: "unknown" } },
      "No event was recorded inside the window."
    );
  const assisted = events.filter((event) => event.assisted).length;
  return {
    ...base,
    value: assisted,
    n: events.length,
    unknown: false,
    detail: { events: events.length, assisted, share: assisted / events.length, minutes: "unknown" },
  };
}
