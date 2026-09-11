/**
 * The usage ledger, the spending estimate, the 50/75/90 % alerts and the build
 * pause — plus the two outbox handlers ops owns.
 *
 * **Every dollar figure in this module is an estimate and says so.** It is
 * computed from Zenith's own counters (build milliseconds, requests, stored
 * bytes, emails) multiplied by the rate table below. It is not a bill, it is
 * not a quote, and it will not equal what a provider eventually charges:
 * invoices lag by days to a month, providers round and bundle differently, and
 * several of the rates here are planning placeholders rather than the price of
 * the plan this install is actually on. `provider_usd` is the one honest
 * number in the ledger — an amount someone typed in from a real invoice — and
 * it passes through at 1:1.
 *
 * **What the alerts do and do not stop.** Crossing 90 % pauses *builds*.
 * Running apps keep serving, customer data stays reachable, and nothing is
 * deleted. Stopping a customer's app to save money on a pilot budget would be
 * a worse failure than the overspend.
 *
 * **Each threshold fires exactly once per workspace per calendar month.** The
 * outbox row's idempotency key is `spend:<workspace>:<YYYY-MM>:<threshold>`,
 * so a restart mid-alert re-sends rather than duplicates, and a month that
 * hovers around 75 % does not send an alert per request.
 */
import { randomUUID } from "node:crypto";
import { HostedError, type HostedOutboxEntry, type UsageEntry } from "@/lib/hosted/contracts";
import { authority, registerOutboxHandler } from "@/lib/hosted/authority";
import { hostedConfig } from "@/lib/hosted/config";
import { recordEvent } from "@/lib/hosted/events";
import { REVOCATION_LEDGER_KEY, selectedBackupTarget } from "@/lib/hosted/backup/targets";
import { log } from "@/lib/log";

/* ------------------------------- rate table ------------------------------- */

/** One row of the rate table: what is counted, what it costs, and where that number came from. */
export interface RateTableEntry {
  unit: string;
  usdPerUnit: number;
  /** Where the rate came from, and how much to trust it. Shown wherever the estimate is. */
  basis: string;
}

/**
 * What one unit of each measured thing is assumed to cost, in US dollars.
 *
 * These are **planning placeholders**, not quotes from the plan this install
 * runs on. They exist so an envelope can be tracked at all; every one of them
 * should be replaced with the selected provider's published price before any
 * figure derived from them is shown to anyone outside the team.
 */
export const RATE_TABLE: Record<UsageEntry["kind"], RateTableEntry> = {
  build_ms: {
    unit: "millisecond of build time",
    usdPerUnit: 0.01 / 60_000,
    basis: "Planning placeholder: $0.01 per build minute. No build provider has been selected or priced; a local recipe build costs this install nothing but the host it already pays for.",
  },
  requests: {
    unit: "request served",
    usdPerUnit: 0.3 / 1_000_000,
    basis: "Planning placeholder: $0.30 per million requests, the order of magnitude of edge request pricing. Not the rate of any contracted plan.",
  },
  storage_bytes: {
    unit: "logical byte stored for a month",
    usdPerUnit: 0.75 / 1_073_741_824,
    basis: "Planning placeholder: $0.75 per GB-month. Each storage_bytes entry is treated as one month of that size, so a workspace measured twice in a month is counted twice.",
  },
  emails: {
    unit: "email accepted by the transport",
    usdPerUnit: 0.001,
    basis: "Planning placeholder: $1.00 per thousand transactional emails. Counted at SMTP acceptance, which is not delivery.",
  },
  provider_usd: {
    unit: "US dollar from a provider invoice",
    usdPerUnit: 1,
    basis: "Not an estimate: an amount entered from a real invoice or console figure, passed through unchanged.",
  },
};

/** The sentence that goes with every estimated figure this module produces. */
export const SPEND_DISCLOSURE =
  "Estimated from platform counters using the rate table below; provider invoices lag and can differ.";

/** The thresholds an alert is raised at, as percentages of the envelope. */
export const SPEND_THRESHOLDS = [50, 75, 90] as const;
export type SpendThreshold = (typeof SPEND_THRESHOLDS)[number];

/** The fraction at which new builds stop being started. */
export const BUILD_PAUSE_FRACTION = 0.9;

/* --------------------------------- ledger --------------------------------- */

/**
 * Append one measurement to the usage ledger.
 *
 * Durable: it resolves after the row committed. Nothing here
 * converts to dollars — the ledger stores what was measured, and the rate
 * table is applied at read time, so re-pricing history is re-reading it rather
 * than rewriting it.
 */
export async function recordUsage(
  entry: Omit<UsageEntry, "id" | "at"> & { at?: string }
): Promise<UsageEntry> {
  const a = authority();
  try {
    return await a.tx(async (repos) =>
      repos.usage.append({
        id: randomUUID(),
        workspaceId: entry.workspaceId,
        appId: entry.appId,
        kind: entry.kind,
        amount: entry.amount,
        at: entry.at,
        note: entry.note,
      })
    );
  } catch (error) {
    if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message))
      throw new HostedError("not_found", `No hosted app has the id ${entry.appId}, so usage cannot be recorded against it.`, {
        fix: "Record workspace-level usage with no appId, or pass the id of an app that exists in the control authority.",
        details: { appId: entry.appId ?? null },
      });
    throw error;
  }
}

/** Usage over a window, grouped by what was measured. */
export interface UsageSummary {
  workspaceId: string;
  since: string;
  /** One row per kind that has any measurement in the window. */
  byKind: {
    kind: UsageEntry["kind"];
    /** The measured total, in the kind's own unit. */
    amount: number;
    entries: number;
    /** `amount` priced with the rate table. An estimate for every kind but `provider_usd`. */
    estimatedUsd: number;
    unit: string;
    basis: string;
  }[];
  /** The sum of `estimatedUsd` across kinds. */
  estimatedUsd: number;
  /** How much of that came from real invoice figures rather than from the rate table. */
  invoicedUsd: number;
  disclosure: string;
}

/** Total measured usage for a workspace since `since`, grouped by kind. */
export async function usageSummary(
  workspaceId: string,
  opts: { since: string; appId?: string }
): Promise<UsageSummary> {
  const a = authority();
  const byKind: UsageSummary["byKind"] = [];
  let estimatedUsd = 0;
  let invoicedUsd = 0;

  for (const kind of Object.keys(RATE_TABLE) as UsageEntry["kind"][]) {
    const query = { workspaceId, since: opts.since, kind, ...(opts.appId ? { appId: opts.appId } : {}) };
    const amount = await a.repos.usage.sumSince(query);
    const entries = (await a.repos.usage.listSince(query, { limit: 10_000 })).length;
    if (entries === 0 && amount === 0) continue;
    const rate = RATE_TABLE[kind];
    const usd = amount * rate.usdPerUnit;
    estimatedUsd += usd;
    if (kind === "provider_usd") invoicedUsd += usd;
    byKind.push({ kind, amount, entries, estimatedUsd: usd, unit: rate.unit, basis: rate.basis });
  }

  return { workspaceId, since: opts.since, byKind, estimatedUsd, invoicedUsd, disclosure: SPEND_DISCLOSURE };
}

/* -------------------------------- spending -------------------------------- */

/** Whether one threshold has been crossed, and when the alert for it was raised. */
export interface ThresholdState {
  threshold: SpendThreshold;
  crossed: boolean;
  /** When the alert was enqueued. Absent until it is. */
  crossedAt?: string;
}

/** What a workspace has spent this month against its envelope. */
export interface SpendingStatus {
  workspaceId: string;
  /** The calendar month in UTC, `YYYY-MM`. */
  month: string;
  /** Inclusive ISO lower bound of the month. */
  since: string;
  /** `ZENITH_SPEND_ENVELOPE_USD`. Zero means no envelope is set. */
  envelopeUsd: number;
  /** The estimate, not a bill. */
  estimatedUsd: number;
  /** `estimatedUsd / envelopeUsd`, or 0 when there is no envelope. */
  fraction: number;
  thresholds: Record<SpendThreshold, ThresholdState>;
  buildsPaused: { paused: boolean; reason: string };
  usage: UsageSummary;
  disclosure: string;
}

/** The first instant of the UTC month a timestamp falls in. */
export const monthStart = (at: Date = new Date()): string =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();

/** The UTC month a timestamp falls in, `YYYY-MM`. */
export const utcMonth = (at: Date = new Date()): string => monthStart(at).slice(0, 7);

/** The idempotency key one workspace-month-threshold alert is sent under. */
export const spendAlertKey = (workspaceId: string, month: string, threshold: number): string =>
  `spend:${workspaceId}:${month}:${threshold}`;

/** Where the workspace stands this month. Reads only; raises nothing. */
export async function spendingStatus(
  workspaceId: string,
  opts: { now?: Date } = {}
): Promise<SpendingStatus> {
  const now = opts.now ?? new Date();
  const month = utcMonth(now);
  const since = monthStart(now);
  const envelopeUsd = hostedConfig().ZENITH_SPEND_ENVELOPE_USD;
  const usage = await usageSummary(workspaceId, { since });
  const estimatedUsd = usage.estimatedUsd;
  const fraction = envelopeUsd > 0 ? estimatedUsd / envelopeUsd : 0;

  const a = authority();
  const thresholds = {} as Record<SpendThreshold, ThresholdState>;
  for (const threshold of SPEND_THRESHOLDS) {
    const row = await a.repos.outbox.getByKey(spendAlertKey(workspaceId, month, threshold));
    thresholds[threshold] = row
      ? { threshold, crossed: true, crossedAt: row.createdAt }
      : { threshold, crossed: false };
  }

  return {
    workspaceId,
    month,
    since,
    envelopeUsd,
    estimatedUsd,
    fraction,
    thresholds,
    buildsPaused: pauseVerdict(envelopeUsd, estimatedUsd, fraction),
    usage,
    disclosure: SPEND_DISCLOSURE,
  };
}

/** The pause decision and the sentence that explains it. One place, so they agree. */
function pauseVerdict(envelopeUsd: number, estimatedUsd: number, fraction: number): { paused: boolean; reason: string } {
  if (envelopeUsd <= 0)
    return {
      paused: false,
      reason:
        "No monthly spending envelope is set (ZENITH_SPEND_ENVELOPE_USD is 0), so builds are never paused for spending. Nothing is being watched.",
    };
  if (fraction < BUILD_PAUSE_FRACTION)
    return {
      paused: false,
      reason: `Estimated $${estimatedUsd.toFixed(2)} of the $${envelopeUsd.toFixed(2)} envelope this month (${Math.round(fraction * 100)} %). Builds pause at 90 %.`,
    };
  return {
    paused: true,
    reason:
      `New builds are paused: this workspace has used an estimated $${estimatedUsd.toFixed(2)} of its $${envelopeUsd.toFixed(2)} monthly envelope (${Math.round(fraction * 100)} %). ` +
      "Apps that are already published keep running and their data stays reachable — only starting a new build is held. " +
      SPEND_DISCLOSURE,
  };
}

/**
 * Whether new builds are held for this workspace.
 *
 * Paused at 90 % of the envelope, and only when an envelope is set. Records
 * `build.paused` the first time it says yes in a given month; the event is
 * deduplicated on its logical id, so a runner asking on every job does not
 * write a row per job.
 */
export async function buildsPaused(
  workspaceId: string,
  opts: { now?: Date } = {}
): Promise<{ paused: boolean; reason: string }> {
  const status = await spendingStatus(workspaceId, opts);
  if (status.buildsPaused.paused)
    await recordEvent({
      event: "build.paused",
      workspaceId,
      logicalId: `pause:${workspaceId}:${status.month}`,
      outcome: "denied",
      props: {
        month: status.month,
        estimatedUsd: Number(status.estimatedUsd.toFixed(4)),
        envelopeUsd: status.envelopeUsd,
      },
    });
  return status.buildsPaused;
}

/** What a threshold check did. */
export interface ThresholdCheck {
  status: SpendingStatus;
  /** Thresholds crossed by *this* call. Empty on every call after the first. */
  crossed: SpendThreshold[];
}

/**
 * Raise an alert for every threshold newly crossed this month.
 *
 * The outbox row and the event are written in one transaction with the same
 * key, so a crash between them is impossible and a retry writes neither twice.
 * Call it after usage is recorded — from the job runner, from a nightly sweep,
 * or from the spending screen.
 */
export async function checkSpendThresholds(
  workspaceId: string,
  opts: { now?: Date } = {}
): Promise<ThresholdCheck> {
  const status = await spendingStatus(workspaceId, opts);
  const crossed: SpendThreshold[] = [];
  if (status.envelopeUsd <= 0) return { status, crossed };

  const a = authority();
  for (const threshold of SPEND_THRESHOLDS) {
    if (status.fraction < threshold / 100) continue;
    if (status.thresholds[threshold].crossed) continue;
    const key = spendAlertKey(workspaceId, status.month, threshold);
    const { inserted } = await a.tx(async (repos) =>
      repos.outbox.enqueue({
        id: randomUUID(),
        idempotencyKey: key,
        kind: "spend_alert",
        payload: {
          workspaceId,
          month: status.month,
          threshold,
          estimatedUsd: Number(status.estimatedUsd.toFixed(4)),
          envelopeUsd: status.envelopeUsd,
          fraction: Number(status.fraction.toFixed(4)),
          buildsPaused: status.buildsPaused.paused,
          disclosure: SPEND_DISCLOSURE,
        },
      })
    );
    if (!inserted) continue;
    crossed.push(threshold);
    status.thresholds[threshold] = { threshold, crossed: true, crossedAt: new Date().toISOString() };
    await recordEvent({
      event: "spend.threshold",
      workspaceId,
      logicalId: key,
      props: {
        threshold,
        month: status.month,
        estimatedUsd: Number(status.estimatedUsd.toFixed(4)),
        envelopeUsd: status.envelopeUsd,
      },
    });
  }
  if (crossed.length > 0) status.buildsPaused = pauseVerdict(status.envelopeUsd, status.estimatedUsd, status.fraction);
  return { status, crossed };
}

/* ---------------------------- outbox handlers ----------------------------- */

/**
 * Register the `spend_alert` and `revocation_ledger` handlers. Called by
 * `ensureHosted()`; idempotent, and safe to call again after a hot reload.
 */
export function registerOpsOutboxHandlers(): void {
  registerOutboxHandler("spend_alert", deliverSpendAlert);
  registerOutboxHandler("revocation_ledger", appendRevocationLedger);
}

/**
 * Deliver a spending alert.
 *
 * TODO(ceiling): this writes a warning to the server log and nothing else. The
 * workspace alert channels (`db().settings.alertChannels`, with their webhook
 * URLs and SMTP transport) live in the legacy JSON store, and reaching them
 * from here would import that store into the hosted path — pinning
 * `ZENITH_DATA` at module load, dragging the whole `Database` shape into every
 * hosted test, and coupling two subsystems that decision R3-02 keeps apart.
 * The honest state is therefore: **a spending alert is a log line an operator
 * has to be watching for.** Wiring it to the existing channels is an
 * integrator change (one adapter, injected at boot), not a W8 one.
 */
async function deliverSpendAlert(entry: HostedOutboxEntry): Promise<void> {
  const payload = entry.payload as {
    workspaceId?: string;
    month?: string;
    threshold?: number;
    estimatedUsd?: number;
    envelopeUsd?: number;
    buildsPaused?: boolean;
  };
  log.warn("hosted spending threshold crossed", {
    scope: "hosted.spend",
    workspaceId: payload.workspaceId,
    month: payload.month,
    threshold: payload.threshold,
    estimatedUsd: payload.estimatedUsd,
    envelopeUsd: payload.envelopeUsd,
    buildsPaused: payload.buildsPaused ?? false,
    disclosure: SPEND_DISCLOSURE,
    delivery: "server log only — no workspace alert channel is wired to hosted spending yet",
  });
}

/** The fields a revocation ledger line carries off-host. */
interface LedgerLine {
  seq: number;
  at: string;
  appId: string;
  grantId: string;
  subject: string;
  by: string;
  reason: string;
}

/**
 * Append one revocation to the off-host ledger.
 *
 * This is the row a clean-host restore reconciles against (G23): without it, a
 * restore of last night's snapshot silently re-admits everyone removed today.
 * So a target of `none` is a **failure**, settled with a fix naming the
 * variable — never a quiet success. The payload is accepted either as
 * `{ entry: … }` or as the entry's own fields, so W5's revoke path and a
 * script can both enqueue it.
 */
async function appendRevocationLedger(entry: HostedOutboxEntry): Promise<void> {
  const line = ledgerLineOf(entry.payload);
  const selection = selectedBackupTarget();
  if (!selection.target)
    throw new HostedError(
      "policy_unavailable",
      `Grant ${line.grantId} was revoked, but there is no backup target to append the revocation to, so a clean-host restore could not learn about it.`,
      { fix: selection.availability.fix, details: { key: REVOCATION_LEDGER_KEY, target: selection.id } }
    );
  await selection.target.append(REVOCATION_LEDGER_KEY, JSON.stringify(line));
}

function ledgerLineOf(payload: Record<string, unknown>): LedgerLine {
  const source = (
    payload.entry && typeof payload.entry === "object" ? payload.entry : payload
  ) as Record<string, unknown>;
  const text = (key: string): string => {
    const value = source[key];
    if (typeof value !== "string" || value === "")
      throw new HostedError("invalid_input", `A revocation_ledger outbox row is missing its "${key}".`, {
        fix: "Enqueue revocation_ledger with the RevocationLedgerEntry as the payload, or under a payload.entry key.",
      });
    return value;
  };
  const seq = Number(source.seq);
  if (!Number.isFinite(seq) || seq <= 0)
    throw new HostedError("invalid_input", 'A revocation_ledger outbox row is missing its "seq".', {
      fix: "Append to revocation_ledger through repos.revocations.append() first and enqueue the row it returns — the sequence number is what a restore reconciles against.",
    });
  return {
    seq,
    at: text("at"),
    appId: text("appId"),
    grantId: text("grantId"),
    subject: text("subject"),
    by: text("by"),
    reason: typeof source.reason === "string" ? source.reason : "",
  };
}
