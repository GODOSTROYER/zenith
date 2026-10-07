/**
 * Environment spend view and gated refresh (PROD-COST-01).
 *
 * The view keeps the three money kinds apart in separate fields:
 * `estimate` (modeled), `actualSpend` (provider-reported) and `forecast`
 * (derived from actual spend only). `comparison` sets an estimate beside actual
 * spend without turning one into the other. Nothing here is a spending cap and
 * every payload says so (`disclosure`).
 *
 * Refresh reads the provider's billing API through the GATED live reader. The
 * billing scope (account, subscription, tenancy or export table) is derived on
 * the server from the environment's own connection, never from the request, so
 * a caller cannot point the operator's billing credentials at another account.
 * A repeated refresh inside `REFRESH_MIN_INTERVAL_MS` returns the stored
 * snapshot instead of calling the provider again (billing APIs can be metered).
 */
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import type { ConnectionConfig } from "@/lib/credentials/types";
import { BillingError, type ActualSpendReader } from "@/lib/cost/billing/types";
import { createLiveBillingReader } from "@/lib/cost/billing/live";
import { validateQueryShape } from "@/lib/cost/billing/reader";
import { compareEstimateToActual, forecastFromActual, BILLING_PROVIDERS, CostKindError, type ActualSpend, type BillingProvider, type Estimate, type Forecast, type SpendComparison } from "@/lib/cost/kinds";
import { costDisclosure, type CostDisclosure } from "@/lib/cost/wording";

export const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;

export interface SpendEnvironment {
  id: string;
  projectId: string;
  connectionId?: string;
}

export interface StoredSpend {
  id: string;
  snapshot: ActualSpend;
  recordedAt: string;
}

export interface SpendDeps {
  environment(workspaceId: string, environmentId: string): Promise<SpendEnvironment | null>;
  connectionConfig(workspaceId: string, legacyConnectionId: string): Promise<ConnectionConfig | null>;
  latestEstimate(workspaceId: string, environmentId: string): Promise<Estimate | null>;
  listActualSpend(workspaceId: string, environmentId: string): Promise<StoredSpend[]>;
  saveActualSpend(input: { workspaceId: string; projectId: string; environmentId: string; snapshot: ActualSpend; recordedBy: string }): Promise<StoredSpend>;
  liveReader(provider: BillingProvider): Promise<ActualSpendReader>;
  now(): Date;
  env: Readonly<Record<string, string | undefined>>;
}

export interface SpendView {
  environmentId: string;
  /** modeled; never actual spend */
  estimate: Estimate | null;
  /** provider-reported, newest period first */
  actualSpend: ActualSpend[];
  /** derived from the newest still-open actual-spend period only */
  forecast: Forecast | null;
  comparison: SpendComparison | null;
  disclosure: CostDisclosure;
  /** why actual spend is empty when it is: no read has been stored yet */
  notes: string[];
}

export async function readSpendView(deps: SpendDeps, workspaceId: string, environmentId: string): Promise<SpendView> {
  const env = await deps.environment(workspaceId, environmentId);
  if (!env) throw notFound();
  const [estimate, stored] = await Promise.all([deps.latestEstimate(workspaceId, environmentId), deps.listActualSpend(workspaceId, environmentId)]);
  const actual = stored.map((s) => s.snapshot);
  const asOf = deps.now().toISOString();
  const open = actual.find((a) => a.finalization === "provisional" && a.periodStart <= asOf.slice(0, 10) && a.periodEnd > asOf.slice(0, 10));
  let forecast: Forecast | null = null;
  const notes: string[] = [];
  if (open) {
    try {
      forecast = forecastFromActual(open, asOf);
    } catch (error) {
      if (!(error instanceof CostKindError)) throw error;
      notes.push(`No forecast yet: ${error.message}`);
    }
  }
  const latest = actual[0];
  const comparison = estimate && latest ? compareEstimateToActual(estimate, latest) : null;
  if (actual.length === 0) notes.push("No provider-reported spend has been stored for this environment. An estimate is not spend.");
  return { environmentId, estimate, actualSpend: actual, forecast, comparison, disclosure: costDisclosure(), notes };
}

/** The provider billing scope for an environment's connection, or a refusal that says why. */
export function billingScopeFor(config: ConnectionConfig, env: SpendDeps["env"]): { provider: BillingProvider; scope: string } {
  switch (config.provider) {
    case "aws":
      return { provider: "aws", scope: config.accountId };
    case "azure":
      return { provider: "azure", scope: `/subscriptions/${config.subscriptionId}` };
    case "oci":
      return { provider: "oci", scope: config.tenancyOcid };
    case "gcp": {
      let tables: Record<string, unknown> = {};
      try {
        tables = JSON.parse(env.ZENITH_GCP_BILLING_EXPORT_TABLES ?? "{}") as Record<string, unknown>;
      } catch {
        tables = {};
      }
      const table = tables[config.projectId];
      if (typeof table !== "string") {
        throw new BrokerError("invalid_state", "No Cloud Billing export table is configured for this GCP project.", "The operator sets ZENITH_GCP_BILLING_EXPORT_TABLES to a JSON map of project id to <project>.<dataset>.<table>.");
      }
      return { provider: "gcp", scope: table };
    }
    default:
      throw new BrokerError("invalid_state", "This environment's provider has no billing reader.", "Actual spend is available for AWS, GCP, Azure and OCI connections.");
  }
}

export interface RefreshInput {
  workspaceId: string;
  environmentId: string;
  periodStart: string;
  periodEnd: string;
  recordedBy: string;
}

export async function refreshActualSpend(deps: SpendDeps, input: RefreshInput): Promise<{ stored: StoredSpend; cached: boolean }> {
  const env = await deps.environment(input.workspaceId, input.environmentId);
  if (!env) throw notFound();
  if (!env.connectionId) throw new BrokerError("invalid_state", "This environment has no cloud connection, so there is no billing account to read.");
  const config = await deps.connectionConfig(input.workspaceId, env.connectionId);
  if (!config) throw new BrokerError("invalid_state", "This environment's connection could not be found.");
  const { provider, scope } = billingScopeFor(config, deps.env);
  const query = { provider, scope, periodStart: input.periodStart, periodEnd: input.periodEnd };
  try {
    validateQueryShape(query);
  } catch (error) {
    if (error instanceof BillingError) throw new BrokerError("invalid_request", error.message);
    throw error;
  }

  const stored = await deps.listActualSpend(input.workspaceId, input.environmentId);
  const nowMs = deps.now().getTime();
  const fresh = stored.find(
    (s) =>
      s.snapshot.provider === provider &&
      s.snapshot.scope === scope &&
      s.snapshot.periodStart === input.periodStart &&
      s.snapshot.periodEnd === input.periodEnd &&
      nowMs - Date.parse(s.snapshot.source.retrievedAt) < REFRESH_MIN_INTERVAL_MS,
  );
  if (fresh) return { stored: fresh, cached: true };

  let reader: ActualSpendReader;
  try {
    reader = await deps.liveReader(provider);
  } catch (error) {
    if (error instanceof BillingError && error.code === "gate_closed") {
      throw new BrokerError("invalid_state", "Live billing reads are disabled on this deployment.", "The operator enables a provider with ZENITH_LIVE_<PROVIDER>=1 and a billing credentials file reference.");
    }
    if (error instanceof BillingError) throw new BrokerError("invalid_state", error.message);
    throw error;
  }
  let snapshot: ActualSpend;
  try {
    snapshot = await reader.read(query);
  } catch (error) {
    if (error instanceof BillingError) throw new BrokerError("invalid_state", `The ${provider.toUpperCase()} billing read failed (${error.code}): ${error.message}`);
    throw error;
  }
  const saved = await deps.saveActualSpend({ workspaceId: input.workspaceId, projectId: env.projectId, environmentId: env.id, snapshot, recordedBy: input.recordedBy });
  return { stored: saved, cached: false };
}

export function isBillingProvider(x: unknown): x is BillingProvider {
  return typeof x === "string" && (BILLING_PROVIDERS as readonly string[]).includes(x);
}

/** Production wiring: legacy product store for environments, platform database for estimates and spend. */
export async function productionSpendDeps(): Promise<SpendDeps> {
  const [{ db }, { platformDb, repos }] = await Promise.all([import("@/lib/db/store"), import("@/lib/controlplane/db")]);
  const sql = await platformDb();
  return {
    async environment(workspaceId, environmentId) {
      const data = db();
      const env = data.environments.find((e) => e.id === environmentId && data.projects.some((p) => p.id === e.projectId && p.workspaceId === workspaceId));
      return env ? { id: env.id, projectId: env.projectId, connectionId: env.connectionId } : null;
    },
    async connectionConfig(workspaceId, legacyConnectionId) {
      const rows = await repos.connections.list(sql, workspaceId);
      const row = rows.find((c) => c.legacyConnectionId === legacyConnectionId && c.status === "verified" && !c.revokedAt);
      return row?.config ?? null;
    },
    async latestEstimate(workspaceId, environmentId) {
      const rows = await repos.cost.list(sql, workspaceId, { environmentId, limit: 1 });
      return rows[0]?.estimate ?? null;
    },
    async listActualSpend(workspaceId, environmentId) {
      const rows = await repos.actualSpend.listActualSpend(sql, workspaceId, { environmentId, limit: 12 });
      return rows.map((r) => ({ id: r.id, snapshot: r.snapshot, recordedAt: r.recordedAt }));
    },
    async saveActualSpend(input) {
      const row = await repos.actualSpend.insertActualSpend(sql, input);
      return { id: row.id, snapshot: row.snapshot, recordedAt: row.recordedAt };
    },
    liveReader: (provider) => createLiveBillingReader(provider, { env: process.env }),
    now: () => new Date(),
    env: process.env,
  };
}
