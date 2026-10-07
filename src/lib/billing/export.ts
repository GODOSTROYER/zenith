/**
 * Tenant data export (PROD-MAN-06): the "you can leave" file for the platform control store.
 *
 * Available in EVERY billing state: suspended, past due, active, and `billing: disabled`. Billing is never a condition of
 * getting your own records out. It is read-only, workspace-bound in SQL (every statement filters on workspace_id), bounded
 * per section (a section that hit its bound says `truncated` instead of silently stopping), and carries a digest of its own
 * sections so a copy can be checked.
 *
 * What is in it: the workspace's environments' managed/referenced/external resource inventory, operation history summaries
 * with their digests, verified portability export records, cost estimates, and, when billing is managed, the account,
 * its audit events, metered usage and invoices. Resource specs are passed through the platform's secret scrubber; no
 * credential, approval token or plan artifact is included, and an operation's proposal body is represented by its digest.
 * It does NOT contain the customer's data inside their own databases or buckets: that is moved by `data.export`
 * (portability), which stays available while suspended.
 */
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { scrubSecrets } from "@/lib/capabilities/secret-guard";
import { listAccountEvents, listInvoices, listUsage, getAccount } from "./store";

export const EXPORT_DEFAULT_LIMIT = 2_000;
export const EXPORT_MAX_LIMIT = 10_000;

export interface ExportSection { name: string; count: number; truncated: boolean; rows: unknown[] }

export interface TenantExport {
  manifest: {
    kind: "zenith_tenant_export";
    version: 1;
    workspaceId: string;
    generatedAt: string;
    billing: "managed" | "disabled";
    limitPerSection: number;
    sections: { name: string; count: number; truncated: boolean }[];
    digest: string;
    notice: string;
  };
  sections: Record<string, unknown[]>;
}

export const EXPORT_NOTICE = "Platform records only. Data inside your own databases and buckets is exported with data.export (portability), which stays available while a workspace is suspended. Billing figures, where present, are provisional placeholders.";

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

async function bounded<T>(sql: Sql, text: string, params: unknown[], limit: number, map: (r: T) => unknown): Promise<{ rows: unknown[]; truncated: boolean }> {
  const rows = await sql.query<T>(text, [...params, limit + 1]);
  return { rows: rows.slice(0, limit).map(map), truncated: rows.length > limit };
}

export async function buildTenantExport(sql: Sql, input: { workspaceId: string; billing: "managed" | "disabled"; now: Date; limit?: number }): Promise<TenantExport> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? EXPORT_DEFAULT_LIMIT), 1), EXPORT_MAX_LIMIT);
  const ws = input.workspaceId;
  const lastParam = (n: number) => `$${n}::int`;
  const sections: ExportSection[] = [];
  const add = (name: string, r: { rows: unknown[]; truncated: boolean }) => sections.push({ name, count: r.rows.length, truncated: r.truncated, rows: r.rows });

  add("resources", await bounded<Record<string, unknown>>(sql,
    `select id, project_id, environment_id, address, kind, provider, region, native_type, ownership, external_id, spec_digest, spec, depends_on, labels, status, created_at, updated_at
       from platform.resources where workspace_id = $1 order by id limit ${lastParam(2)}`, [ws], limit,
    (r) => scrubSecrets({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) })));
  add("operations", await bounded<Record<string, unknown>>(sql,
    `select id, project_id, environment_id, resource_id, capability, status, proposal_digest, input_digest, plan_digest, correlation_id, created_at, started_at, finished_at
       from platform.operations where workspace_id = $1 order by seq desc limit ${lastParam(2)}`, [ws], limit,
    (r) => ({ ...r, created_at: iso(r.created_at), started_at: iso(r.started_at), finished_at: iso(r.finished_at) })));
  add("portability_exports", await bounded<Record<string, unknown>>(sql,
    `select id, environment_id, operation_id, resource_id, address, kind, provider, engine, engine_version, destination_label, artifact_prefix, manifest_digest, content_digest, file_count, byte_size, verified_at, created_at
       from platform.portability_exports where workspace_id = $1 order by created_at desc, id limit ${lastParam(2)}`, [ws], limit,
    (r) => ({ ...r, byte_size: Number(r.byte_size), verified_at: iso(r.verified_at), created_at: iso(r.created_at) })));
  add("cost_estimates", await bounded<Record<string, unknown>>(sql,
    `select id, environment_id, operation_id, catalog_version, monthly_usd, computed_at from platform.cost_estimates where workspace_id = $1 order by computed_at desc, id limit ${lastParam(2)}`, [ws], limit,
    (r) => ({ ...r, computed_at: iso(r.computed_at) })));

  if (input.billing === "managed") {
    const account = await getAccount(sql, ws);
    add("billing_account", { rows: account ? [account] : [], truncated: false });
    const events = await listAccountEvents(sql, ws, limit + 1);
    add("billing_events", { rows: events.slice(0, limit), truncated: events.length > limit });
    const usage = await listUsage(sql, ws, limit + 1);
    add("billing_usage", { rows: usage.slice(0, limit), truncated: usage.length > limit });
    const invoices = await listInvoices(sql, ws, limit + 1);
    add("billing_invoices", { rows: invoices.slice(0, limit), truncated: invoices.length > limit });
  }

  const body = Object.fromEntries(sections.map((s) => [s.name, s.rows]));
  return {
    manifest: {
      kind: "zenith_tenant_export", version: 1, workspaceId: ws, generatedAt: input.now.toISOString(), billing: input.billing, limitPerSection: limit,
      sections: sections.map((s) => ({ name: s.name, count: s.count, truncated: s.truncated })),
      digest: digest({ workspaceId: ws, sections: body }),
      notice: EXPORT_NOTICE,
    },
    sections: body,
  };
}
