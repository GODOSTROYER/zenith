/**
 * Shared fixtures for the PROD-MAN-06 billing suites.
 *
 * Nothing here is a real credential or a real provider id: every key, secret and provider id is generated at run time
 * from random bytes, and `FakeInvoiceProvider` is a CONTRACT-LEVEL stand-in for the `InvoiceProvider` interface (it records
 * calls and honours idempotency keys the way Stripe documents). It is never a claim that Stripe was reached.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { BillingProviderError, type CreateInvoiceInput, type EnsureCustomerInput, type InvoiceProvider } from "@/lib/billing/provider";
import { signStripePayload } from "@/lib/billing/stripe";
import type { Invoice } from "@/lib/billing/store";
import { proposalFor, user } from "../controlplane/_support/harness";

export const hex = (bytes = 16): string => randomBytes(bytes).toString("hex");
export const testSecretKey = (): string => `sk_test_${hex(16)}`;
export const liveLookingKey = (): string => `sk_live_${hex(16)}`;
export const webhookSecret = (): string => `whsec_${hex(24)}`;

/** A fixed instant after March 2026 ended, so March is an invoiceable period and April is the current one. */
export const NOW = new Date("2026-04-02T12:00:00.000Z");
export const PERIOD = "2026-03";
export const DAY = 86_400_000;

export class FakeInvoiceProvider implements InvoiceProvider {
  readonly kind = "fake_contract_level";
  customers = new Map<string, string>();
  invoices = new Map<string, string>();
  calls: { op: "customer" | "invoice"; key: string }[] = [];
  failNext = 0;

  async ensureCustomer(input: EnsureCustomerInput): Promise<{ customerId: string }> {
    this.calls.push({ op: "customer", key: input.idempotencyKey });
    if (this.failNext > 0) { this.failNext -= 1; throw new BillingProviderError("provider_unavailable", "simulated outage"); }
    if (!this.customers.has(input.idempotencyKey)) this.customers.set(input.idempotencyKey, `cus_${hex(8)}`);
    return { customerId: this.customers.get(input.idempotencyKey)! };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<{ providerInvoiceId: string }> {
    this.calls.push({ op: "invoice", key: input.idempotencyKey });
    if (this.failNext > 0) { this.failNext -= 1; throw new BillingProviderError("provider_unavailable", "simulated outage"); }
    if (!this.invoices.has(input.idempotencyKey)) this.invoices.set(input.idempotencyKey, `in_${hex(8)}`);
    return { providerInvoiceId: this.invoices.get(input.idempotencyKey)! };
  }

  get distinctInvoices(): number { return new Set(this.invoices.values()).size; }
}

export interface EventOptions {
  id?: string;
  createdSec?: number;
  amountPaid?: number;
  metadataWorkspace?: string | null;
  currency?: string;
}

/** A signed Stripe-shaped invoice event body for one of OUR invoices. */
export function invoiceEvent(type: string, invoice: Invoice, secret: string, nowMs: number, over: EventOptions = {}): { raw: string; header: string; id: string } {
  const createdSec = over.createdSec ?? Math.floor(nowMs / 1000);
  const id = over.id ?? `evt_${hex(10)}`;
  const body = {
    id, type, created: createdSec, object: "event", livemode: false,
    data: { object: {
      id: invoice.stripeInvoiceId, object: "invoice", customer: invoice.stripeCustomerId, currency: over.currency ?? "usd",
      amount_paid: over.amountPaid ?? invoice.subtotalCents, amount_due: invoice.subtotalCents,
      metadata: over.metadataWorkspace === null ? {} : { zenith_workspace_id: over.metadataWorkspace ?? invoice.workspaceId, zenith_invoice_id: invoice.id },
    } },
  };
  const raw = JSON.stringify(body);
  return { raw, header: signStripePayload(secret, raw, Math.floor(nowMs / 1000)), id };
}

/** An operation row for a workspace (the FK target for build launches, and the thing metering counts). */
export async function seedOperation(db: PlatformDbHandle, workspaceId: string, over: { status?: string; finishedAt?: string } = {}) {
  const { operation } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId) });
  if (over.status) await db.query("update platform.operations set status = $3, finished_at = $4::timestamptz where workspace_id = $1 and id = $2", [workspaceId, operation.id, over.status, over.finishedAt ?? null]);
  return operation;
}

export async function seedResource(db: PlatformDbHandle, workspaceId: string, over: { ownership?: string; status?: string; createdAt: string; updatedAt?: string; kind?: string }): Promise<string> {
  const id = `res_${randomUUID()}`;
  await db.query(
    `insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, spec_digest, spec, status, created_at, updated_at)
     values ($1, $2, 'env_billing', $3, $4, 'aws', 'aws:ecs_service', $5, $6, $7::text::jsonb, $8, $9::timestamptz, $10::timestamptz)`,
    [id, workspaceId, `${over.kind ?? "container_service"}/${hex(4)}`, over.kind ?? "container_service", over.ownership ?? "managed", "a".repeat(64), JSON.stringify({ replicas: 1 }), over.status ?? "active", over.createdAt, over.updatedAt ?? over.createdAt]);
  return id;
}

export async function seedBuild(db: PlatformDbHandle, workspaceId: string, acceptedAt: string, finishedAt: string): Promise<void> {
  const op = await seedOperation(db, workspaceId);
  const binding = { workspaceId, operationId: op.id, environmentId: op.environmentId!, serviceAddress: "container_service/web" };
  const d = "b".repeat(64);
  await db.query(
    `insert into platform.build_launches
       (workspace_id, operation_id, service_address, environment_id, attempt_id, binding, binding_digest, proposal_digest, input_digest, plan_digest, fence_token,
        phase, build_id, request_ids, accepted_at, terminal_status, provider_finished_at, terminal_request_id, observed_at)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $7, $7, $7, 1, 'terminal', $8, '["req"]'::jsonb, $9::timestamptz, 'SUCCEEDED', $10::timestamptz, 'term-req', $10::timestamptz)`,
    [workspaceId, op.id, binding.serviceAddress, op.environmentId, randomUUID(), JSON.stringify(binding), d, `build:${randomUUID()}`, acceptedAt, finishedAt]);
}

export async function seedPortabilityExport(db: PlatformDbHandle, workspaceId: string, byteSize: number, createdAt: string): Promise<void> {
  const op = await seedOperation(db, workspaceId);
  await db.query(
    `insert into platform.portability_exports
       (id, workspace_id, environment_id, operation_id, resource_id, address, kind, provider, engine, destination_label, artifact_prefix, manifest_digest, content_digest, file_count, byte_size, verified_at, created_at)
     values ($1, $2, $3, $4, $5, 'object_store/backups', 'object_store', 'aws', 's3', 'tenant bucket', 'exports/x', $6, $6, 1, $7::bigint, $8::timestamptz, $8::timestamptz)`,
    [`pex_${randomUUID()}`, workspaceId, op.environmentId, op.id, `res_${randomUUID()}`, "c".repeat(64), byteSize, createdAt]);
}

export async function seedCostEstimate(db: PlatformDbHandle, workspaceId: string, environmentId: string, egressGb: number, computedAt: string): Promise<void> {
  const estimate = { kind: "estimate", catalogVersion: "test", currency: "USD", monthlyUsd: 10, lines: [], assumptions: { egressGb }, included: [], excluded: [], computedAt };
  await db.query(
    `insert into platform.cost_estimates (id, workspace_id, environment_id, catalog_version, monthly_usd, estimate, computed_at) values ($1, $2, $3, 'test', 10, $4::text::jsonb, $5::timestamptz)`,
    [`cost_${randomUUID()}`, workspaceId, environmentId, JSON.stringify(estimate), computedAt]);
}

/** The platform tables whose row counts must never fall because a workspace is suspended. */
export const RETAINED_TABLES = ["resources", "operations", "portability_exports", "cost_estimates", "billing_accounts", "billing_invoices", "billing_usage_events", "billing_account_events", "billing_webhook_events"] as const;

export async function retainedCounts(db: PlatformDbHandle, workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of RETAINED_TABLES) {
    const rows = await db.query<{ n: string }>(`select count(*) as n from platform.${t} where workspace_id = $1`, [workspaceId]);
    out[t] = Number(rows[0].n);
  }
  return out;
}

/** An Sql that fails the test the moment anything touches it: proves a code path did no store I/O. */
export const forbiddenSql = {
  query: async () => { throw new Error("billing disabled: the store must not be touched"); },
  tx: async () => { throw new Error("billing disabled: the store must not be touched"); },
} as never;
