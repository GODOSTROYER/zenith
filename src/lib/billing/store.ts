/**
 * Control-store access for metering and billing (PROD-MAN-06).
 *
 * Tenancy classification (tests/controlplane/tenancy.test.ts conventions):
 *   getAccount / assignPlan / applyStanding / setStripeCustomer / listAccountEvents / recordAccountEvent
 *   upsertUsage / aggregateUsage / listUsage / isPeriodClosed
 *   getInvoice / getInvoiceByPeriod / listInvoices / insertDraftInvoice / markInvoiceOpen / markInvoiceNoCharge
 *   recordInvoiceError / transitionInvoice / unpaidInvoices
 *                                    WORKSPACE-BOUND: every statement filters on workspace_id
 *   listAccounts / listStandingCandidates
 *                                    SYSTEM reads for the scheduled pass and the operator surface: each returned row
 *                                    carries its workspace id; no payloads
 *   findInvoiceByProviderId          SYSTEM lookup by the provider's globally unique invoice id; the caller must then
 *                                    check the returned workspace against the event's own metadata
 *   beginWebhookEvent / finishWebhookEvent
 *                                    SYSTEM, keyed by the provider's globally unique event id; stores a digest and an outcome only
 *
 * Nothing in this module deletes a row, and the tables refuse deletion by trigger. Deliberately NOT exported from
 * `controlplane/db/repos` (same stance as src/lib/ops/store.ts), so callers pass the platform `Sql` explicitly.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "@/lib/controlplane/db/errors";
import { json, newId } from "@/lib/controlplane/db/sql";
import { isPeriod } from "./period";
import { isMeter, isPlanId, type Meter } from "./plans";

/* --------------------------------- types ---------------------------------- */

export type Standing = "active" | "past_due" | "suspended";
export type SuspensionReason = "nonpayment" | "operator";
export type AccountEventKind = "plan_assigned" | "past_due" | "suspended" | "reinstated" | "payment_received" | "export_requested";

export interface BillingAccount {
  workspaceId: string;
  planId: string;
  status: Standing;
  suspensionReason?: SuspensionReason;
  pastDueSince?: string;
  suspendedAt?: string;
  stripeCustomerId?: string;
  assignedBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface AccountRow {
  workspace_id: string; plan_id: string; status: Standing; suspension_reason: SuspensionReason | null; past_due_since: string | null;
  suspended_at: string | null; stripe_customer_id: string | null; assigned_by: string; version: number; created_at: string; updated_at: string;
}
const ACCOUNT_COLUMNS = "workspace_id, plan_id, status, suspension_reason, past_due_since, suspended_at, stripe_customer_id, assigned_by, version, created_at, updated_at";
const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const toAccount = (r: AccountRow): BillingAccount => ({
  workspaceId: r.workspace_id, planId: r.plan_id, status: r.status,
  ...(r.suspension_reason ? { suspensionReason: r.suspension_reason } : {}),
  ...(r.past_due_since ? { pastDueSince: iso(r.past_due_since) } : {}),
  ...(r.suspended_at ? { suspendedAt: iso(r.suspended_at) } : {}),
  ...(r.stripe_customer_id ? { stripeCustomerId: r.stripe_customer_id } : {}),
  assignedBy: r.assigned_by, version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export interface AccountEvent { seq: number; workspaceId: string; kind: AccountEventKind; actor: string; reason?: string; detail: Record<string, unknown>; at: string }

export interface InvoiceLine {
  /** stable key: `base` or the meter name */
  key: string;
  description: string;
  quantity: number;
  unit: string;
  unitCents: number;
  amountCents: number;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "failed" | "void" | "no_charge";

export interface Invoice {
  id: string;
  workspaceId: string;
  period: string;
  planId: string;
  planProvisional: boolean;
  currency: "usd";
  lines: InvoiceLine[];
  subtotalCents: number;
  digest: string;
  status: InvoiceStatus;
  stripeInvoiceId?: string;
  stripeCustomerId?: string;
  attempts: number;
  dueAt?: string;
  paidAt?: string;
  amountPaidCents?: number;
  lastEventCreated: number;
  lastError?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface InvoiceRow {
  id: string; workspace_id: string; period: string; plan_id: string; plan_provisional: boolean; currency: "usd"; lines: InvoiceLine[];
  subtotal_cents: string | number; digest: string; status: InvoiceStatus; stripe_invoice_id: string | null; stripe_customer_id: string | null;
  attempts: number; due_at: string | null; paid_at: string | null; amount_paid_cents: string | number | null; last_event_created: string | number;
  last_error: string | null; version: number; created_at: string; updated_at: string;
}
const INVOICE_COLUMNS = "id, workspace_id, period, plan_id, plan_provisional, currency, lines, subtotal_cents, digest, status, stripe_invoice_id, stripe_customer_id, attempts, due_at, paid_at, amount_paid_cents, last_event_created, last_error, version, created_at, updated_at";
const toInvoice = (r: InvoiceRow): Invoice => ({
  id: r.id, workspaceId: r.workspace_id, period: r.period, planId: r.plan_id, planProvisional: r.plan_provisional, currency: r.currency,
  lines: r.lines, subtotalCents: Number(r.subtotal_cents), digest: r.digest, status: r.status,
  ...(r.stripe_invoice_id ? { stripeInvoiceId: r.stripe_invoice_id } : {}),
  ...(r.stripe_customer_id ? { stripeCustomerId: r.stripe_customer_id } : {}),
  attempts: r.attempts,
  ...(r.due_at ? { dueAt: iso(r.due_at) } : {}),
  ...(r.paid_at ? { paidAt: iso(r.paid_at) } : {}),
  ...(r.amount_paid_cents !== null ? { amountPaidCents: Number(r.amount_paid_cents) } : {}),
  lastEventCreated: Number(r.last_event_created),
  ...(r.last_error ? { lastError: r.last_error } : {}),
  version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

const ws = (value: string): string => requireText("workspaceId", value, 128);
const period = (value: string): string => {
  if (!isPeriod(value)) throw new ControlStoreError("invalid_input", "period must be YYYY-MM.", { field: "period" });
  return value;
};

/* -------------------------------- accounts -------------------------------- */

export async function getAccount(sql: Sql, workspaceId: string): Promise<BillingAccount | null> {
  const rows = await sql.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from platform.billing_accounts where workspace_id = $1`, [ws(workspaceId)]);
  return rows.length ? toAccount(rows[0]) : null;
}

export async function listAccounts(sql: Sql, limit = 200): Promise<BillingAccount[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const rows = await sql.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from platform.billing_accounts order by workspace_id limit $1::int`, [n]);
  return rows.map(toAccount);
}

export async function recordAccountEvent(
  sql: Sql,
  input: { workspaceId: string; kind: AccountEventKind; actor: string; reason?: string; detail?: Record<string, unknown> }
): Promise<void> {
  await sql.query(
    "insert into platform.billing_account_events (workspace_id, kind, actor, reason, detail) values ($1, $2, $3, $4, $5::text::jsonb)",
    [ws(input.workspaceId), input.kind, requireText("actor", input.actor, 200), input.reason ? input.reason.slice(0, 300) : null, json(input.detail ?? {})]
  );
}

export async function listAccountEvents(sql: Sql, workspaceId: string, limit = 100): Promise<AccountEvent[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const rows = await sql.query<{ seq: string | number; workspace_id: string; kind: AccountEventKind; actor: string; reason: string | null; detail: Record<string, unknown>; at: string }>(
    "select seq, workspace_id, kind, actor, reason, detail, at from platform.billing_account_events where workspace_id = $1 order by seq desc limit $2::int", [ws(workspaceId), n]);
  return rows.map((r) => ({ seq: Number(r.seq), workspaceId: r.workspace_id, kind: r.kind, actor: r.actor, ...(r.reason ? { reason: r.reason } : {}), detail: r.detail, at: iso(r.at) }));
}

export interface AssignPlanInput { workspaceId: string; planId: string; actor: string; reason?: string; expectedVersion?: number }

/** Assign (or change) a workspace's plan. Standing is untouched: assigning a plan never lifts a suspension. */
export async function assignPlan(sql: Sql, input: AssignPlanInput): Promise<BillingAccount> {
  const workspaceId = ws(input.workspaceId);
  if (!isPlanId(input.planId)) throw new ControlStoreError("invalid_input", "planId is not a known plan.", { field: "planId" });
  const actor = requireText("actor", input.actor, 200);
  return sql.tx(async (tx) => {
    const before = await getAccount(tx, workspaceId);
    const rows = await tx.query<AccountRow>(
      `insert into platform.billing_accounts as a (workspace_id, plan_id, assigned_by) values ($1, $2, $3)
       on conflict (workspace_id) do update
         set plan_id = excluded.plan_id, assigned_by = excluded.assigned_by, version = a.version + 1, updated_at = clock_timestamp()
       where ($4::int is null or a.version = $4::int)
       returning ${ACCOUNT_COLUMNS}`,
      [workspaceId, input.planId, actor, input.expectedVersion ?? null]
    );
    if (!rows.length) throw new ControlStoreError("conflict", "The billing account changed since you read it; reload and retry.", { currentVersion: before?.version });
    await recordAccountEvent(tx, { workspaceId, kind: "plan_assigned", actor, reason: input.reason, detail: { from: before?.planId ?? null, to: input.planId } });
    return toAccount(rows[0]);
  });
}

export async function setStripeCustomer(sql: Sql, workspaceId: string, customerId: string): Promise<BillingAccount> {
  const rows = await sql.query<AccountRow>(
    `update platform.billing_accounts set stripe_customer_id = $2, version = version + 1, updated_at = clock_timestamp()
      where workspace_id = $1 and (stripe_customer_id is null or stripe_customer_id = $2) returning ${ACCOUNT_COLUMNS}`,
    [ws(workspaceId), requireText("customerId", customerId, 100)]
  );
  if (!rows.length) throw new ControlStoreError("conflict", "The billing account already has a different provider customer.");
  return toAccount(rows[0]);
}

export interface StandingTarget { status: Standing; suspensionReason?: SuspensionReason; pastDueSince?: Date | null }

/**
 * Move an account's standing. A no-op (same status, reason and past-due anchor) writes nothing and records no event, so a
 * level-triggered sweep can call it every pass. Returns the account and whether anything changed. Standing is the ONLY
 * thing suspension changes: no resource, operation, record or export is touched here or anywhere it is read.
 */
export async function applyStanding(
  sql: Sql,
  input: { workspaceId: string; target: StandingTarget; actor: string; eventKind: AccountEventKind; reason?: string; now: Date }
): Promise<{ account: BillingAccount; changed: boolean } | null> {
  const workspaceId = ws(input.workspaceId);
  return sql.tx(async (tx) => {
    const rows = await tx.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from platform.billing_accounts where workspace_id = $1 for update`, [workspaceId]);
    if (!rows.length) return null;
    const current = toAccount(rows[0]);
    const { target } = input;
    const wantReason = target.status === "suspended" ? target.suspensionReason ?? null : null;
    const wantDue = target.status === "active" ? null : target.pastDueSince === undefined ? (current.pastDueSince ? new Date(current.pastDueSince) : null) : target.pastDueSince;
    const sameDue = (wantDue?.getTime() ?? null) === (current.pastDueSince ? new Date(current.pastDueSince).getTime() : null);
    if (current.status === target.status && (current.suspensionReason ?? null) === wantReason && sameDue) return { account: current, changed: false };
    const updated = await tx.query<AccountRow>(
      `update platform.billing_accounts
          set status = $2, suspension_reason = $3, past_due_since = $4::timestamptz,
              suspended_at = case when $2 = 'suspended' then coalesce(suspended_at, $5::timestamptz) else null end,
              version = version + 1, updated_at = clock_timestamp()
        where workspace_id = $1 returning ${ACCOUNT_COLUMNS}`,
      [workspaceId, target.status, wantReason, wantDue ? wantDue.toISOString() : null, input.now.toISOString()]
    );
    const account = toAccount(updated[0]);
    await recordAccountEvent(tx, { workspaceId, kind: input.eventKind, actor: input.actor, reason: input.reason, detail: { from: current.status, to: target.status, ...(wantReason ? { suspensionReason: wantReason } : {}) } });
    return { account, changed: true };
  });
}

/* ---------------------------------- usage ---------------------------------- */

export interface UsageInput { workspaceId: string; meter: Meter; sourceId: string; period: string; quantity: number; unit: string; estimated: boolean; detail?: Record<string, unknown> }

export async function isPeriodClosed(sql: Sql, workspaceId: string, p: string): Promise<boolean> {
  const rows = await sql.query<{ n: number }>(
    "select 1 as n from platform.billing_invoices where workspace_id = $1 and period = $2 and status <> 'void' limit 1", [ws(workspaceId), period(p)]);
  return rows.length > 0;
}

/** Idempotent per (workspace, meter, source, period). Returns `closed` for a period that has an invoice, `unchanged` when nothing moved. */
export async function upsertUsage(sql: Sql, input: UsageInput): Promise<"written" | "unchanged" | "closed"> {
  if (!isMeter(input.meter)) throw new ControlStoreError("invalid_input", "meter is not known.", { field: "meter" });
  if (!Number.isFinite(input.quantity) || input.quantity < 0) throw new ControlStoreError("invalid_input", "quantity must be a non-negative number.", { field: "quantity" });
  const workspaceId = ws(input.workspaceId);
  const p = period(input.period);
  if (await isPeriodClosed(sql, workspaceId, p)) return "closed";
  try {
    const rows = await sql.query<{ id: string }>(
      `insert into platform.billing_usage_events as u (id, workspace_id, meter, source_id, period, quantity, unit, estimated, detail)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::text::jsonb)
       on conflict (workspace_id, meter, source_id, period) do update
         set quantity = excluded.quantity, detail = excluded.detail, observed_at = clock_timestamp()
       where u.quantity is distinct from excluded.quantity
       returning id`,
      [newId("use"), workspaceId, input.meter, requireText("sourceId", input.sourceId, 300), p, input.quantity.toFixed(6), input.unit, input.estimated, json(input.detail ?? {})]
    );
    return rows.length ? "written" : "unchanged";
  } catch (error) {
    if (/Usage for an invoiced period is closed/.test(error instanceof Error ? error.message : "")) return "closed";
    throw error;
  }
}

export interface UsageTotal { meter: Meter; quantity: number; estimated: boolean; sources: number }

export async function aggregateUsage(sql: Sql, workspaceId: string, p: string): Promise<UsageTotal[]> {
  const rows = await sql.query<{ meter: Meter; quantity: string | number; estimated: boolean; sources: string | number }>(
    `select meter, sum(quantity) as quantity, bool_or(estimated) as estimated, count(*) as sources
       from platform.billing_usage_events where workspace_id = $1 and period = $2 group by meter order by meter`, [ws(workspaceId), period(p)]);
  return rows.map((r) => ({ meter: r.meter, quantity: Number(r.quantity), estimated: r.estimated, sources: Number(r.sources) }));
}

export interface UsageRecord { id: string; meter: Meter; sourceId: string; period: string; quantity: number; unit: string; estimated: boolean; detail: Record<string, unknown>; observedAt: string }

export async function listUsage(sql: Sql, workspaceId: string, limit = 1000): Promise<UsageRecord[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 10_000);
  const rows = await sql.query<{ id: string; meter: Meter; source_id: string; period: string; quantity: string | number; unit: string; estimated: boolean; detail: Record<string, unknown>; observed_at: string }>(
    "select id, meter, source_id, period, quantity, unit, estimated, detail, observed_at from platform.billing_usage_events where workspace_id = $1 order by period desc, meter, source_id limit $2::int", [ws(workspaceId), n]);
  return rows.map((r) => ({ id: r.id, meter: r.meter, sourceId: r.source_id, period: r.period, quantity: Number(r.quantity), unit: r.unit, estimated: r.estimated, detail: r.detail, observedAt: iso(r.observed_at) }));
}

/* -------------------------------- invoices --------------------------------- */

export async function getInvoice(sql: Sql, workspaceId: string, id: string): Promise<Invoice | null> {
  const rows = await sql.query<InvoiceRow>(`select ${INVOICE_COLUMNS} from platform.billing_invoices where workspace_id = $1 and id = $2`, [ws(workspaceId), requireText("id", id, 128)]);
  return rows.length ? toInvoice(rows[0]) : null;
}

export async function getInvoiceByPeriod(sql: Sql, workspaceId: string, p: string): Promise<Invoice | null> {
  const rows = await sql.query<InvoiceRow>(`select ${INVOICE_COLUMNS} from platform.billing_invoices where workspace_id = $1 and period = $2`, [ws(workspaceId), period(p)]);
  return rows.length ? toInvoice(rows[0]) : null;
}

export async function listInvoices(sql: Sql, workspaceId: string, limit = 24): Promise<Invoice[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const rows = await sql.query<InvoiceRow>(`select ${INVOICE_COLUMNS} from platform.billing_invoices where workspace_id = $1 order by period desc limit $2::int`, [ws(workspaceId), n]);
  return rows.map(toInvoice);
}

export async function findInvoiceByProviderId(sql: Sql, providerInvoiceId: string): Promise<Invoice | null> {
  const rows = await sql.query<InvoiceRow>(`select ${INVOICE_COLUMNS} from platform.billing_invoices where stripe_invoice_id = $1`, [requireText("providerInvoiceId", providerInvoiceId, 100)]);
  return rows.length ? toInvoice(rows[0]) : null;
}

export interface DraftInvoiceInput {
  id?: string; workspaceId: string; period: string; planId: string; planProvisional: boolean;
  lines: InvoiceLine[]; subtotalCents: number; digest: string; dueAt: Date;
}

/** Insert the one invoice for (workspace, period), or return the existing one unchanged. `created` says which. */
export async function insertDraftInvoice(sql: Sql, input: DraftInvoiceInput): Promise<{ invoice: Invoice; created: boolean }> {
  const workspaceId = ws(input.workspaceId);
  const p = period(input.period);
  const rows = await sql.query<InvoiceRow>(
    `insert into platform.billing_invoices (id, workspace_id, period, plan_id, plan_provisional, currency, lines, subtotal_cents, digest, due_at)
     values ($1, $2, $3, $4, $5, 'usd', $6::text::jsonb, $7::bigint, $8, $9::timestamptz)
     on conflict (workspace_id, period) do nothing returning ${INVOICE_COLUMNS}`,
    [input.id ?? newId("inv"), workspaceId, p, input.planId, input.planProvisional, json(input.lines), input.subtotalCents, input.digest, input.dueAt.toISOString()]
  );
  if (rows.length) return { invoice: toInvoice(rows[0]), created: true };
  const existing = await getInvoiceByPeriod(sql, workspaceId, p);
  if (!existing) throw new ControlStoreError("conflict", "The invoice could not be created or found.");
  return { invoice: existing, created: false };
}

async function updateInvoice(sql: Sql, workspaceId: string, id: string, fromStatuses: readonly InvoiceStatus[], set: string, params: readonly unknown[]): Promise<Invoice | null> {
  const rows = await sql.query<InvoiceRow>(
    `update platform.billing_invoices set ${set}, version = version + 1, updated_at = clock_timestamp()
      where workspace_id = $1 and id = $2 and status = any($3::text[]) returning ${INVOICE_COLUMNS}`,
    [ws(workspaceId), requireText("id", id, 128), `{${fromStatuses.join(",")}}`, ...params]
  );
  return rows.length ? toInvoice(rows[0]) : null;
}

export const markInvoiceOpen = (sql: Sql, workspaceId: string, id: string, ids: { stripeInvoiceId: string; stripeCustomerId: string }): Promise<Invoice | null> =>
  updateInvoice(sql, workspaceId, id, ["draft"], "status = 'open', stripe_invoice_id = $4, stripe_customer_id = $5, last_error = null", [requireText("stripeInvoiceId", ids.stripeInvoiceId, 100), requireText("stripeCustomerId", ids.stripeCustomerId, 100)]);

export const markInvoiceNoCharge = (sql: Sql, workspaceId: string, id: string): Promise<Invoice | null> =>
  updateInvoice(sql, workspaceId, id, ["draft"], "status = 'no_charge', last_error = null", []);

export const recordInvoiceError = (sql: Sql, workspaceId: string, id: string, message: string): Promise<Invoice | null> =>
  updateInvoice(sql, workspaceId, id, ["draft"], "last_error = $4", [message.slice(0, 300)]);

export interface InvoiceTransition {
  to: "paid" | "failed" | "void";
  eventCreated: number;
  amountPaidCents?: number;
  now: Date;
}

/**
 * Apply a settlement outcome reported by the provider. The legal moves are open|failed -> paid, open|failed -> failed (an
 * attempt) and open|failed -> void; `paid` is terminal and a stale (older) failure never counts. Returns the invoice, and
 * `applied` false when the move was not legal or was out of date (the event is still recorded by the caller).
 */
export async function transitionInvoice(sql: Sql, workspaceId: string, id: string, t: InvoiceTransition): Promise<{ invoice: Invoice; applied: boolean } | null> {
  const current = await getInvoice(sql, workspaceId, id);
  if (!current) return null;
  if (current.status !== "open" && current.status !== "failed") return { invoice: current, applied: false };
  if (t.to === "failed" && t.eventCreated < current.lastEventCreated) return { invoice: current, applied: false };
  const next = t.to === "paid"
    ? await updateInvoice(sql, workspaceId, id, ["open", "failed"], "status = 'paid', paid_at = $4::timestamptz, amount_paid_cents = $5::bigint, last_event_created = greatest(last_event_created, $6::bigint)",
      [t.now.toISOString(), t.amountPaidCents ?? current.subtotalCents, t.eventCreated])
    : t.to === "failed"
      ? await updateInvoice(sql, workspaceId, id, ["open", "failed"], "status = 'failed', attempts = attempts + 1, last_event_created = greatest(last_event_created, $4::bigint)", [t.eventCreated])
      : await updateInvoice(sql, workspaceId, id, ["open", "failed"], "status = 'void', last_event_created = greatest(last_event_created, $4::bigint)", [t.eventCreated]);
  return next ? { invoice: next, applied: true } : { invoice: current, applied: false };
}

export interface UnpaidInvoice { id: string; status: "open" | "failed"; dueAt: string; period: string }

export async function unpaidInvoices(sql: Sql, workspaceId: string): Promise<UnpaidInvoice[]> {
  const rows = await sql.query<{ id: string; status: "open" | "failed"; due_at: string; period: string }>(
    "select id, status, due_at, period from platform.billing_invoices where workspace_id = $1 and status in ('open','failed') order by due_at, id", [ws(workspaceId)]);
  return rows.map((r) => ({ id: r.id, status: r.status, dueAt: iso(r.due_at), period: r.period }));
}

/** Accounts whose standing might need to move: not active, or holding an unpaid invoice that failed or is overdue. */
export async function listStandingCandidates(sql: Sql, now: Date, limit = 500): Promise<string[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 5000);
  const rows = await sql.query<{ workspace_id: string }>(
    `select a.workspace_id from platform.billing_accounts a
      where a.status <> 'active'
         or exists (select 1 from platform.billing_invoices i where i.workspace_id = a.workspace_id and i.status in ('open','failed') and (i.status = 'failed' or i.due_at <= $1::timestamptz))
      order by a.workspace_id limit $2::int`, [now.toISOString(), n]);
  return rows.map((r) => r.workspace_id);
}

/* ------------------------------ webhook events ----------------------------- */

/** First sight of a provider event id. `false` means it was already recorded: the caller must change nothing. */
export async function beginWebhookEvent(sql: Sql, e: { id: string; type: string; payloadSha256: string; created: number }): Promise<boolean> {
  const rows = await sql.query<{ stripe_event_id: string }>(
    `insert into platform.billing_webhook_events (stripe_event_id, event_type, payload_sha256, stripe_created) values ($1, $2, $3, $4::bigint)
     on conflict (stripe_event_id) do nothing returning stripe_event_id`,
    [requireText("eventId", e.id, 100), requireText("eventType", e.type, 120), e.payloadSha256, e.created]
  );
  return rows.length > 0;
}

export type WebhookOutcome = "applied" | "ignored" | "unmatched" | "rejected" | "amount_mismatch";

export async function finishWebhookEvent(sql: Sql, eventId: string, outcome: WebhookOutcome, workspaceId?: string): Promise<void> {
  await sql.query("update platform.billing_webhook_events set outcome = $2, workspace_id = $3 where stripe_event_id = $1 and outcome = 'received'", [eventId, outcome, workspaceId ?? null]);
}

export async function webhookOutcome(sql: Sql, eventId: string): Promise<WebhookOutcome | "received" | null> {
  const rows = await sql.query<{ outcome: WebhookOutcome | "received" }>("select outcome from platform.billing_webhook_events where stripe_event_id = $1", [eventId]);
  return rows.length ? rows[0].outcome : null;
}
