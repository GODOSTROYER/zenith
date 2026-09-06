/**
 * Alert delivery: the part that leaves the browser.
 *
 * Three channel kinds, and the honesty rules that go with each:
 *
 *  - **webhook** — a POST of JSON. When the channel has a secret, the exact
 *    bytes of the body are signed with HMAC-SHA256 and sent as
 *    `X-Orrery-Signature: sha256=<hex>`, so a receiver can prove Zenith.ai sent it.
 *    Without a secret the request is unsigned and the UI says so.
 *  - **slack** — the same alert as a Slack incoming-webhook payload (`text`
 *    plus `blocks`). The URL *is* the credential, so it is masked everywhere.
 *  - **email** — SMTP through `nodemailer`, configured by `ORRERY_SMTP_URL` and
 *    `ORRERY_ALERT_FROM`. The package is loaded at send time: a workspace with
 *    no email channel never needs it installed, and one that does gets an error
 *    naming `npm install nodemailer` instead of a crash at import.
 *
 * Delivery never blocks evaluation, and it is not held in memory either. A
 * transition writes one **outbox row per selected channel** into
 * `db().alertOutbox`, in the same save as the event that caused it: once the
 * evaluator returns, the *intent* is on disk even if the process dies before a
 * byte leaves. The rows are then claimed (`sending`, durably) before the
 * network call and settled (`delivered` / `failed`) after it, so a crash
 * mid-flight is retried at the next boot rather than lost. Each row carries a
 * stable `idempotencyKey` — sent as `X-Orrery-Idempotency-Key` — so a receiver
 * that already saw the first attempt can recognise the retry as the same
 * message. Every terminal outcome is appended to `event.deliveries` and stamped
 * on the channel as `lastDelivery`: a failure is recorded, not thrown.
 *
 * ponytail: no dead-lettering and no per-channel circuit breaker. Three
 * attempts with backoff, then the row is `failed` with its reason on the event
 * and the operator retries with Test on the channel. A `failed` row is never
 * re-driven on its own; that is what a dead-letter screen would add.
 */
import { createHmac } from "node:crypto";
import { db, flush, q, save } from "@/lib/db/store";
import {
  id,
  type AlertChannel,
  type AlertDelivery,
  type AlertEvent,
  type AlertOutboxEntry,
} from "@/lib/domain/types";
import { env, SMTP_FIX } from "@/lib/env";
import { log } from "@/lib/log";
import { channelsForRule, channelsOf, findChannel } from "./channels";

/** Per attempt, not per delivery: three attempts can take 30s in the worst case. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Total attempts, including the first. */
export const DELIVERY_ATTEMPTS = 3;

/** Waits *between* attempts, so there are ATTEMPTS - 1 of them. */
const BACKOFF_MS = [1_000, 4_000];

/** The header a receiver verifies. */
export const SIGNATURE_HEADER = "X-Orrery-Signature";

/**
 * The header a receiver de-duplicates on. Stable across every retry of one
 * transition to one channel — including a retry after this server restarted
 * mid-send — so a receiver that stores the key can drop the second copy.
 */
export const IDEMPOTENCY_HEADER = "X-Orrery-Idempotency-Key";

/** What a channel is asked to send. `test` is a human pressing Test in Settings. */
export type AlertPhase = "fired" | "resolved" | "test";

export interface AlertMessage {
  phase: AlertPhase;
  /** the one line an operator reads first */
  title: string;
  /** the sentence under it — the event's own detail, or the test's explanation */
  body: string;
  severity: AlertEvent["severity"];
  /** true when the condition read generated or estimated data */
  simulated: boolean;
  eventId?: string;
  ruleId?: string;
  projectId?: string;
  environmentId?: string;
  firedAt?: string;
  resolvedAt?: string;
  resolvedReason?: string;
}

const SIMULATED_SUFFIX =
  "This condition reads generated health or estimated cost, not a measurement.";

/* --------------------------------- payloads -------------------------------- */

const eventName = (phase: AlertPhase) => `alert.${phase}`;

/** The line every channel leads with, and the Slack/email fallback text. */
export function messageText(msg: AlertMessage): string {
  const lead =
    msg.phase === "resolved" ? "Resolved" : msg.phase === "test" ? "Test" : msg.severity.toUpperCase();
  return `[Zenith.ai] ${lead}: ${msg.title}`;
}

/**
 * The webhook body, as the exact string that is signed and sent. Built once so
 * the signature can never be computed over different bytes than were posted.
 */
export function webhookBody(msg: AlertMessage, sentAt = new Date().toISOString()): string {
  return JSON.stringify({
    source: "orrery",
    event: eventName(msg.phase),
    sentAt,
    text: messageText(msg),
    alert: {
      id: msg.eventId,
      ruleId: msg.ruleId,
      projectId: msg.projectId,
      environmentId: msg.environmentId,
      severity: msg.severity,
      simulated: msg.simulated,
      summary: msg.title,
      detail: msg.body,
      firedAt: msg.firedAt,
      resolvedAt: msg.resolvedAt,
      resolvedReason: msg.resolvedReason,
    },
  });
}

/** `sha256=<hex>`, over the exact bytes of `body`. */
export const sign = (body: string, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

/** A Slack incoming-webhook payload: notification text plus rendered blocks. */
export function slackBody(msg: AlertMessage): Record<string, unknown> {
  const text = messageText(msg);
  const context = [
    msg.phase === "resolved"
      ? `Closed${msg.resolvedReason ? `: ${msg.resolvedReason}` : "."}`
      : msg.phase === "test"
        ? "Test message from Settings → Alerts."
        : `Severity ${msg.severity}.`,
    msg.simulated ? `Simulated — ${SIMULATED_SUFFIX}` : "",
    "Sent by Zenith.ai.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${text}*\n${msg.body}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: context }] },
    ],
  };
}

/** Subject and body for the email channel. */
export const emailBody = (msg: AlertMessage): { subject: string; text: string } => ({
  subject: messageText(msg),
  text: [
    msg.body,
    msg.simulated ? `\nSimulated: ${SIMULATED_SUFFIX}` : "",
    msg.phase === "resolved" && msg.resolvedReason ? `\nClosed: ${msg.resolvedReason}` : "",
    "\nSent by Zenith.ai. Reply-to is not monitored — acknowledge the alert in Observe → Alerts.",
  ]
    .filter(Boolean)
    .join("\n"),
});

/* ---------------------------------- email ---------------------------------- */

interface MailTransport {
  sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  close?(): void;
}
interface NodemailerLike {
  createTransport(url: string): MailTransport;
}

export const MISSING_NODEMAILER =
  "The nodemailer package is not installed, so email alerts cannot be sent. Run `npm install` in the Zenith.ai repo (nodemailer is in package.json) and restart the server. Webhook and Slack channels do not need it.";

/**
 * The module specifier, in an object so a test can point it at something that
 * is not installed and prove the refusal without uninstalling anything. Not a
 * literal at the import site on purpose: `tsc` must pass before the package is
 * installed, and the bundler must leave the import to Node.
 */
export const NODEMAILER = { spec: "nodemailer" };

async function loadNodemailer(): Promise<NodemailerLike> {
  let mod: unknown;
  try {
    mod = await import(/* webpackIgnore: true */ NODEMAILER.spec);
  } catch {
    // Permanent: an uninstalled package will not install itself between retries.
    throw new Permanent(MISSING_NODEMAILER);
  }
  // CJS through an ESM import lands on `default` in some runtimes and on the
  // namespace in others. Take whichever one actually has the function.
  const m = mod as Partial<NodemailerLike> & { default?: Partial<NodemailerLike> };
  const ns = typeof m.createTransport === "function" ? m : m.default;
  if (!ns || typeof ns.createTransport !== "function") throw new Permanent(MISSING_NODEMAILER);
  return ns as NodemailerLike;
}

/** Why email cannot be sent right now, or undefined when it can be attempted. */
export function emailProblem(): string | undefined {
  const e = env();
  if (!e.ORRERY_SMTP_URL) return `No SMTP server is configured. ${SMTP_FIX}`;
  if (!e.ORRERY_ALERT_FROM)
    return `ORRERY_SMTP_URL is set but ORRERY_ALERT_FROM is not, so the mail would have no From address. ${SMTP_FIX}`;
  return undefined;
}

async function sendEmail(channel: AlertChannel, msg: AlertMessage): Promise<void> {
  // Permanent: a missing environment variable does not appear on a retry.
  const problem = emailProblem();
  if (problem) throw new Permanent(problem);
  const e = env();
  const nodemailer = await loadNodemailer();
  const transport = nodemailer.createTransport(e.ORRERY_SMTP_URL!);
  const { subject, text } = emailBody(msg);
  try {
    // ponytail: the timeout races the send rather than aborting the socket —
    // nodemailer's own connectionTimeout/socketTimeout would need the URL taken
    // apart. Pass them as query params on ORRERY_SMTP_URL if a hung SMTP
    // connection ever needs to be closed rather than abandoned.
    await withTimeout(
      transport.sendMail({ from: e.ORRERY_ALERT_FROM!, to: channel.target, subject, text }),
      `The SMTP server did not accept the message within ${DELIVERY_TIMEOUT_MS / 1000}s. Check ORRERY_SMTP_URL — a wrong port is the usual cause.`
    );
  } finally {
    transport.close?.();
  }
}

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), DELIVERY_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/* ---------------------------------- send ----------------------------------- */

/** A non-retryable failure: trying again would fail the same way. */
class Permanent extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

/** A 4xx that is not 429 is a wrong URL or a revoked token, not a bad moment. */
const retryable = (status: number) => status === 429 || status >= 500;

async function post(url: string, body: string, headers: Record<string, string>): Promise<number> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError")
      throw new Error(
        `No response within ${DELIVERY_TIMEOUT_MS / 1000}s. Check that this server can reach the endpoint — a proxy or an egress rule is the usual cause.`
      );
    throw new Error(
      `Could not reach the endpoint: ${err instanceof Error ? err.message : String(err)}. Check the URL in Settings → Alerts and that this server has outbound network access.`
    );
  }
  if (res.ok) return res.status;

  const reason =
    res.status === 404
      ? "The endpoint answered 404. Check the URL — a Slack incoming webhook that was revoked answers 404 for good."
      : res.status === 403 || res.status === 401
        ? `The endpoint refused the request (${res.status}). Check the URL, and the signing secret if the receiver verifies one.`
        : `The endpoint answered ${res.status}. Check its own logs for why it rejected the alert.`;
  if (retryable(res.status)) throw new Error(reason);
  throw new Permanent(reason, res.status);
}

/** One attempt at one channel. Returns the HTTP status when there is one. */
async function attempt(
  channel: AlertChannel,
  msg: AlertMessage,
  idempotencyKey: string
): Promise<number | undefined> {
  if (channel.kind === "email") {
    await sendEmail(channel, msg);
    return undefined;
  }
  if (channel.kind === "slack") return post(channel.target, JSON.stringify(slackBody(msg)), {});
  const body = webhookBody(msg);
  // The signature covers the body, which carries a fresh `sentAt` per attempt;
  // the idempotency key does not change, so it — not the bytes — is what tells
  // a receiver that attempt 2 is the same notification as attempt 1.
  return post(channel.target, body, {
    "X-Orrery-Event": eventName(msg.phase),
    [IDEMPOTENCY_HEADER]: idempotencyKey,
    ...(channel.secret ? { [SIGNATURE_HEADER]: sign(body, channel.secret) } : {}),
  });
}

/** Backoff, collapsed by ORRERY_FAST the same way simulated step durations are. */
const wait = (ms: number) =>
  new Promise<void>((r) => {
    if (env().ORRERY_FAST || ms <= 0) return r();
    // Cast because `lib.dom` types setTimeout as returning a number; a backoff
    // must never be the reason a script or a test run refuses to exit.
    (setTimeout(r, ms) as unknown as { unref?: () => void }).unref?.();
  });

/**
 * Deliver one message to one channel, with retries. Never throws: the outcome
 * is the return value, and it is stamped on the channel as `lastDelivery`.
 *
 * `idempotencyKey` comes from the outbox row when this is a queued transition,
 * so a replay after a crash reuses the key the receiver already saw. A caller
 * with no row — `alerts.testChannel`, which sends inline and shows the answer —
 * gets a fresh key per press, because pressing Test twice *is* two messages.
 */
export async function deliverToChannel(
  channel: AlertChannel,
  msg: AlertMessage,
  idempotencyKey = idempotencyKeyFor(msg.eventId ?? id(), msg.phase, channel.id)
): Promise<AlertDelivery> {
  let last = "";
  for (let n = 1; n <= DELIVERY_ATTEMPTS; n++) {
    try {
      const status = await attempt(channel, msg, idempotencyKey);
      return record(channel, { channelId: channel.id, at: iso(), ok: true, status, attempts: n });
    } catch (err) {
      const permanent = err instanceof Permanent;
      last = err instanceof Error ? err.message : String(err);
      if (permanent || n === DELIVERY_ATTEMPTS)
        return record(channel, {
          channelId: channel.id,
          at: iso(),
          ok: false,
          status: permanent ? (err as Permanent).status : undefined,
          error: permanent
            ? last
            : `${last} Tried ${n} time${n === 1 ? "" : "s"}${n > 1 ? " with backoff" : ""}.`,
          attempts: n,
        });
      await wait(BACKOFF_MS[n - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
  }
  // Unreachable: the loop always returns. Kept so the type is honest.
  return record(channel, {
    channelId: channel.id,
    at: iso(),
    ok: false,
    error: last,
    attempts: DELIVERY_ATTEMPTS,
  });
}

const iso = () => new Date().toISOString();

function record(channel: AlertChannel, delivery: AlertDelivery): AlertDelivery {
  channel.lastDelivery = delivery;
  if (delivery.ok)
    log.info("alert delivered", {
      scope: "alerts",
      channelId: channel.id,
      kind: channel.kind,
      attempts: delivery.attempts,
    });
  else
    log.warn("alert delivery failed", {
      scope: "alerts",
      channelId: channel.id,
      kind: channel.kind,
      attempts: delivery.attempts,
      error: delivery.error,
    });
  return delivery;
}

/* ---------------------------------- queue ---------------------------------- */

/** The message for one event, in the phase it just entered. */
export function messageForEvent(event: AlertEvent, phase: "fired" | "resolved"): AlertMessage {
  return {
    phase,
    title: event.summary,
    body: event.detail,
    severity: event.severity,
    simulated: event.simulated,
    eventId: event.id,
    ruleId: event.ruleId,
    projectId: event.projectId,
    environmentId: event.environmentId,
    firedAt: event.firedAt,
    resolvedAt: event.resolvedAt,
    resolvedReason: event.resolvedReason,
  };
}

/**
 * Every channel this event should reach, and the workspace it belongs to. The
 * rule decides; a rule that was deleted in the same pass that closed its event
 * falls back to every enabled channel in the workspace, because the receiver
 * still has an open alert.
 */
function targetsFor(event: AlertEvent): { workspaceId: string; channels: AlertChannel[] } {
  const workspaceId = q.project(event.projectId)?.workspaceId;
  if (!workspaceId) return { workspaceId: "", channels: [] };
  const rule = db().alertRules.find((r) => r.id === event.ruleId);
  return {
    workspaceId,
    channels: rule
      ? channelsForRule(rule, workspaceId)
      : channelsOf(workspaceId).filter((c) => c.enabled),
  };
}

/* --------------------------------- outbox ---------------------------------- */

/**
 * The durable queue, backfilled in place — the same trick as `tables()` in
 * ./index, for a snapshot written before the collection existed.
 */
function outbox(): AlertOutboxEntry[] {
  const d = db() as ReturnType<typeof db> & { alertOutbox?: AlertOutboxEntry[] };
  d.alertOutbox ??= [];
  return d.alertOutbox;
}

/**
 * How long a claim is trusted before another runner may take the row back.
 * Comfortably longer than the worst case one row can legitimately take —
 * 3 × 10s of timeout plus 1s + 4s of backoff — so a live send is never stolen
 * from underneath itself.
 */
export const OUTBOX_LEASE_MS = 120_000;

/**
 * The key a receiver de-duplicates on: one transition, one channel, forever.
 * Derived rather than random, so a row rebuilt from disk after a crash produces
 * the identical key without having to trust anything but the row's own fields.
 */
export const idempotencyKeyFor = (
  eventId: string,
  transition: AlertPhase,
  channelId: string
): string => `orrery-${transition}-${eventId}-${channelId}`;

/**
 * Write the intent to deliver one transition to every selected channel.
 *
 * Synchronous and store-only: the rows land in `db()` next to the event the
 * caller just opened or closed, and the `save()` here coalesces with the
 * caller's own into a single atomic write of `state.json`. After it returns,
 * a crash can no longer lose the notification — only delay it to the next boot.
 */
export function enqueueDeliveries(
  event: AlertEvent,
  transition: "fired" | "resolved"
): AlertOutboxEntry[] {
  const { workspaceId, channels } = targetsFor(event);
  if (channels.length === 0) {
    // An empty array is a fact: Zenith.ai tried and there was nowhere to send.
    // That is a different thing from `undefined` — an event recorded before
    // channels existed — and the Observe screen says which one it is looking at.
    event.deliveries ??= [];
    save(event.projectId);
    return [];
  }
  const rows = outbox();
  const created: AlertOutboxEntry[] = [];
  const at = iso();
  for (const channel of channels) {
    const idempotencyKey = idempotencyKeyFor(event.id, transition, channel.id);
    // One intent per (event, channel, transition). A second call for the same
    // transition — a re-entrant close, a replayed evaluation — must not become
    // a second notification.
    if (rows.some((r) => r.idempotencyKey === idempotencyKey)) continue;
    const row: AlertOutboxEntry = {
      id: id(),
      workspaceId,
      channelId: channel.id,
      eventId: event.id,
      transition,
      idempotencyKey,
      status: "pending",
      attempts: 0,
      createdAt: at,
    };
    rows.push(row);
    created.push(row);
  }
  save(event.projectId);
  return created;
}

/**
 * Take every pending row, mark it `sending`, and make that durable *before* the
 * first byte leaves. A crash from here on leaves a claimed row this process no
 * longer owns, which the next boot reclaims — the send is retried with the same
 * idempotency key rather than dropped.
 */
function claimPending(): AlertOutboxEntry[] {
  const batch = outbox().filter((r) => r.status === "pending");
  if (batch.length === 0) return [];
  const at = iso();
  for (const row of batch) {
    row.status = "sending";
    row.claimedAt = at;
  }
  save();
  flush(); // the whole batch costs one write, not one per row
  return batch;
}

/**
 * Record the terminal outcome, on the row and on the event the UI reads.
 * Flushed, not just queued: an outcome that only lives in memory is exactly the
 * duplicate the receiver would see after a crash.
 */
function settle(row: AlertOutboxEntry, delivery: AlertDelivery): void {
  row.status = delivery.ok ? "delivered" : "failed";
  row.attempts = delivery.attempts ?? row.attempts;
  row.settledAt = delivery.at;
  delete row.claimedAt;
  if (delivery.error) row.error = delivery.error;
  else delete row.error;
  if (delivery.status !== undefined) row.httpStatus = delivery.status;
  else delete row.httpStatus;
  // The honest per-event log: one entry per terminal outcome, never per attempt.
  const event = db().alertEvents.find((e) => e.id === row.eventId);
  if (event) event.deliveries = [...(event.deliveries ?? []), delivery];
  save(event?.projectId);
  flush();
}

/** Send one claimed row, then settle it. Never throws. */
async function deliverEntry(row: AlertOutboxEntry): Promise<void> {
  const fail = (error: string): void =>
    settle(row, {
      channelId: row.channelId,
      at: iso(),
      ok: false,
      error,
      attempts: row.attempts,
    });

  const channel = findChannel(row.channelId);
  if (!channel)
    return fail(
      `The delivery channel "${row.channelId}" was deleted before this alert could be sent, so it never went out. Recreate the channel under Settings → Alerts if this workspace still needs it.`
    );
  if (row.transition === "test")
    return fail(
      "A test message is sent inline from Settings → Alerts and is never queued, so this row cannot be replayed. Press Test on the channel again."
    );
  const event = db().alertEvents.find((e) => e.id === row.eventId);
  if (!event)
    return fail(
      `The alert "${row.eventId}" is no longer in the event log, so there is nothing left to send about it.`
    );

  const msg = messageForEvent(event, row.transition);
  settle(row, await deliverToChannel(channel, msg, row.idempotencyKey));
}

/* ---------------------------------- queue ---------------------------------- */

type G = typeof globalThis & {
  __orreryDeliveryInFlight?: Promise<void>;
  __orreryDeliveryScheduled?: boolean;
};
const g = globalThis as G;

/**
 * Queue a transition. The caller keeps going: the row is written here, in the
 * caller's own save, and the outbox is drained on a microtask — after the
 * evaluator's `save()` and after the request that triggered a read-time
 * evaluation has its response.
 */
export function queueDelivery(event: AlertEvent, phase: "fired" | "resolved"): void {
  enqueueDeliveries(event, phase);
  if (g.__orreryDeliveryScheduled) return;
  g.__orreryDeliveryScheduled = true;
  queueMicrotask(() => {
    g.__orreryDeliveryScheduled = false;
    drain();
  });
}

function drain(): void {
  const batch = claimPending();
  if (batch.length === 0) return;
  g.__orreryDeliveryInFlight = (g.__orreryDeliveryInFlight ?? Promise.resolve())
    .then(() => Promise.all(batch.map((row) => deliverEntry(row))))
    .then(
      () => undefined,
      (err) => {
        // deliverEntry never throws, so this is a bug rather than a bad
        // endpoint. It must not become an unhandled rejection either way.
        log.error("alert delivery batch failed", { scope: "alerts", error: err });
      }
    );
}

/**
 * Deliver one transition now and answer with what happened. Scripts and the
 * odd caller that wants the result; the evaluator uses `queueDelivery`.
 */
export async function deliverEvent(
  event: AlertEvent,
  phase: "fired" | "resolved"
): Promise<AlertDelivery[]> {
  const before = event.deliveries?.length ?? 0;
  enqueueDeliveries(event, phase);
  await flushDeliveries();
  return (event.deliveries ?? []).slice(before);
}

/**
 * Hand back rows a dead process was holding. A claim older than the lease
 * cannot still be in flight — nothing legitimately takes that long — so the row
 * goes back to `pending` and is sent again under its original key.
 */
export function reclaimStale(leaseMs = OUTBOX_LEASE_MS, now = Date.now()): number {
  let reclaimed = 0;
  for (const row of outbox()) {
    if (row.status !== "sending") continue;
    const claimed = row.claimedAt ? Date.parse(row.claimedAt) : 0;
    // An unparseable or missing claim stamp is treated as expired: a row nobody
    // can prove is in flight is a row nobody is sending.
    if (Number.isFinite(claimed) && claimed > now - leaseMs) continue;
    row.status = "pending";
    delete row.claimedAt;
    reclaimed++;
  }
  if (reclaimed) {
    save();
    flush();
  }
  return reclaimed;
}

/**
 * Boot: pick up whatever the last process left behind.
 *
 * The default lease of 0 reclaims *every* row still marked `sending`, which is
 * correct precisely here — `claimDataDir()` has just proved this process is the
 * only writer of this data directory, so no live runner can be holding one.
 * Pass a real lease to reclaim only rows abandoned longer ago than that.
 */
export async function replayOutbox(leaseMs = 0): Promise<number> {
  const reclaimed = reclaimStale(leaseMs);
  const pending = outbox().filter((r) => r.status === "pending").length;
  if (pending === 0) return 0;
  log.info("replaying alert outbox", { scope: "alerts", pending, reclaimed });
  await flushDeliveries();
  return pending;
}

/** Tests and scripts: drain what is queued and wait for everything in flight. */
export async function flushDeliveries(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    drain();
    await g.__orreryDeliveryInFlight;
    if (!outbox().some((r) => r.status === "pending")) return;
  }
}
