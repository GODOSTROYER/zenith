/**
 * PROD-COST-01: the environment spend view and the gated refresh. In-memory
 * dependencies stand in for the stores and the billing reader (contract-level);
 * the SQL store is covered by `actual-spend-store.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { BrokerError } from "@/lib/capabilities/errors";
import { BillingError, type ActualSpendReader } from "@/lib/cost/billing";
import { newActualSpend, type ActualSpend } from "@/lib/cost/kinds";
import { billingScopeFor, readSpendView, refreshActualSpend, REFRESH_MIN_INTERVAL_MS, type SpendDeps, type StoredSpend } from "@/lib/cost/spend-service";
import type { ConnectionConfig } from "@/lib/credentials/types";
import { estimateGraphCost, loadDefaultCatalog } from "@/lib/placement";
import { node } from "../placement/fixtures";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const aws: ConnectionConfig = { provider: "aws", mode: "runner", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/o", deployRoleArn: "arn:aws:iam::123456789012:role/d", region: "us-east-1" };
const estimate = estimateGraphCost({ nodes: [node("service/web", "container_service", "aws", "us-east-1", { size: "small" })] }, { catalog: loadDefaultCatalog() });

function spend(over: Partial<Parameters<typeof newActualSpend>[0]> = {}): ActualSpend {
  return newActualSpend({
    provider: "aws",
    scope: "123456789012",
    periodStart: "2026-10-01",
    periodEnd: "2026-11-01",
    totalUsd: 50,
    lines: [{ service: "Amazon Elastic Compute Cloud - Compute", usd: 50 }],
    costBasis: "test",
    finalization: "provisional",
    source: { adapter: "test", endpoint: "https://example.invalid/", retrievedAt: "2026-10-11T00:00:00.000Z", responseSha256: "b".repeat(64) },
    ...over,
  });
}

function makeDeps(over: Partial<SpendDeps> & { stored?: StoredSpend[]; config?: ConnectionConfig | null; reader?: ActualSpendReader } = {}) {
  const stored: StoredSpend[] = over.stored ?? [];
  const calls = { read: vi.fn(), liveReader: vi.fn() };
  const deps: SpendDeps = {
    environment: async (ws, id) => (ws === "ws-a" && id === "env-a" ? { id, projectId: "proj-a", connectionId: "conn-a" } : null),
    connectionConfig: async () => (over.config === undefined ? aws : over.config),
    latestEstimate: async () => estimate,
    listActualSpend: async () => stored,
    saveActualSpend: async (i) => {
      const row = { id: `spend_${stored.length + 1}`, snapshot: i.snapshot, recordedAt: NOW.toISOString() };
      stored.unshift(row);
      return row;
    },
    liveReader: async (provider) => {
      calls.liveReader(provider);
      if (over.reader) return over.reader;
      throw new BillingError("gate_closed", "ZENITH_LIVE_AWS=1 is not set; live AWS billing reads are disabled.");
    },
    now: () => NOW,
    env: {},
    ...over,
  };
  return { deps, stored, calls };
}

const input = { workspaceId: "ws-a", environmentId: "env-a", periodStart: "2026-10-01", periodEnd: "2026-11-01", recordedBy: "user-1" };

describe("spend view keeps the three kinds apart", () => {
  it("with nothing stored: an estimate, no actual spend, no forecast, and a note that an estimate is not spend", async () => {
    const view = await readSpendView(makeDeps().deps, "ws-a", "env-a");
    expect(view.estimate?.kind).toBe("estimate");
    expect(view.actualSpend).toEqual([]);
    expect(view.forecast).toBeNull();
    expect(view.comparison).toBeNull();
    expect(view.notes.join(" ")).toMatch(/An estimate is not spend/);
    expect(view.disclosure).toMatchObject({ kind: "estimate", isBillingCap: false });
  });

  it("with an open provisional period: a forecast derived from the actual spend, and a comparison with the estimate", async () => {
    const row: StoredSpend = { id: "s1", snapshot: spend({ totalUsd: 100 }), recordedAt: NOW.toISOString() };
    const view = await readSpendView(makeDeps({ stored: [row] }).deps, "ws-a", "env-a");
    expect(view.actualSpend.map((a) => a.kind)).toEqual(["actual_spend"]);
    expect(view.forecast?.kind).toBe("forecast");
    expect(view.forecast?.floorUsd).toBe(100);
    expect(view.forecast?.basedOn.responseSha256).toBe("b".repeat(64));
    expect(view.comparison?.kind).toBe("estimate_vs_actual");
    expect(view.estimate?.kind).toBe("estimate");
  });

  it("a closed period is shown as actual spend and never forecast", async () => {
    const closed: StoredSpend = { id: "s1", snapshot: spend({ periodStart: "2026-09-01", periodEnd: "2026-10-01", finalization: "final" }), recordedAt: NOW.toISOString() };
    const view = await readSpendView(makeDeps({ stored: [closed] }).deps, "ws-a", "env-a");
    expect(view.forecast).toBeNull();
    expect(view.actualSpend).toHaveLength(1);
  });

  it("a foreign or unknown environment is the same not-found", async () => {
    await expect(readSpendView(makeDeps().deps, "ws-b", "env-a")).rejects.toMatchObject({ code: "not_found" });
    await expect(readSpendView(makeDeps().deps, "ws-a", "env-zzz")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("billing scope comes from the environment's connection", () => {
  it("derives the account, subscription, tenancy or export table per provider", () => {
    expect(billingScopeFor(aws, {})).toEqual({ provider: "aws", scope: "123456789012" });
    expect(billingScopeFor({ provider: "azure", mode: "runner", tenantId: "t", clientId: "c", subscriptionId: "00000000-0000-4000-8000-000000000000", region: "eastus" }, {})).toEqual({ provider: "azure", scope: "/subscriptions/00000000-0000-4000-8000-000000000000" });
    expect(billingScopeFor({ provider: "oci", mode: "runner", tenancyOcid: "ocid1.tenancy.oc1..x", compartmentOcid: "c", region: "us-ashburn-1", runnerId: "r" }, {})).toEqual({ provider: "oci", scope: "ocid1.tenancy.oc1..x" });
    const gcp: ConnectionConfig = { provider: "gcp", mode: "runner", projectId: "my-project-123", workloadIdentityProvider: "w", observeServiceAccount: "o", deployServiceAccount: "d", region: "us-central1" };
    expect(billingScopeFor(gcp, { ZENITH_GCP_BILLING_EXPORT_TABLES: JSON.stringify({ "my-project-123": "my-project-123.ds.gcp_billing_export_v1_X" }) })).toEqual({ provider: "gcp", scope: "my-project-123.ds.gcp_billing_export_v1_X" });
  });

  it("refuses GCP without a configured export table and providers with no billing reader", () => {
    const gcp: ConnectionConfig = { provider: "gcp", mode: "runner", projectId: "my-project-123", workloadIdentityProvider: "w", observeServiceAccount: "o", deployServiceAccount: "d", region: "us-central1" };
    expect(() => billingScopeFor(gcp, {})).toThrow(BrokerError);
    expect(() => billingScopeFor(gcp, { ZENITH_GCP_BILLING_EXPORT_TABLES: "not json" })).toThrow(/No Cloud Billing export table/);
    expect(() => billingScopeFor({ provider: "kubernetes", mode: "runner", server: "https://k", namespaces: [] }, {})).toThrow(/no billing reader/);
  });
});

describe("refresh is gated, scoped and throttled", () => {
  it("is refused with a clear message when the live gate is closed, and stores nothing", async () => {
    const { deps, stored } = makeDeps();
    await expect(refreshActualSpend(deps, input)).rejects.toMatchObject({ code: "invalid_state", message: "Live billing reads are disabled on this deployment." });
    expect(stored).toEqual([]);
  });

  it("reads the account of the environment's own connection and stores the result", async () => {
    const read = vi.fn(async (q: Parameters<ActualSpendReader["read"]>[0]) => spend({ scope: q.scope, periodStart: q.periodStart, periodEnd: q.periodEnd }));
    const reader: ActualSpendReader = { provider: "aws", adapter: "test", read };
    const { deps, stored } = makeDeps({ reader });
    const out = await refreshActualSpend(deps, input);
    expect(out.cached).toBe(false);
    expect(read).toHaveBeenCalledWith({ provider: "aws", scope: "123456789012", periodStart: "2026-10-01", periodEnd: "2026-11-01" });
    expect(stored).toHaveLength(1);
    expect(out.stored.snapshot.kind).toBe("actual_spend");
  });

  it("does not call the provider again inside the minimum interval, and does after it", async () => {
    const read = vi.fn(async (q: Parameters<ActualSpendReader["read"]>[0]) => spend({ scope: q.scope, source: { adapter: "t", endpoint: "https://example.invalid/", retrievedAt: NOW.toISOString(), responseSha256: "c".repeat(64) } }));
    const reader: ActualSpendReader = { provider: "aws", adapter: "test", read };
    const { deps } = makeDeps({ reader });
    await refreshActualSpend(deps, input);
    const second = await refreshActualSpend(deps, input);
    expect(second.cached).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const later = { ...deps, now: () => new Date(NOW.getTime() + REFRESH_MIN_INTERVAL_MS + 1000) };
    expect((await refreshActualSpend(later, input)).cached).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("turns reader failures into a refusal without leaking provider detail", async () => {
    const reader: ActualSpendReader = { provider: "aws", adapter: "test", read: async () => { throw new BillingError("provider_error", "AWS billing API answered HTTP 403."); } };
    const { deps } = makeDeps({ reader });
    await expect(refreshActualSpend(deps, input)).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("HTTP 403") });
  });

  it("refuses an environment without a connection, a missing connection and a bad period", async () => {
    const noConn = makeDeps({ environment: async (_ws, id) => ({ id, projectId: "p" }) });
    await expect(refreshActualSpend(noConn.deps, input)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(refreshActualSpend(makeDeps({ config: null }).deps, input)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(refreshActualSpend(makeDeps().deps, { ...input, periodStart: "2026-11-01", periodEnd: "2026-10-01" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(refreshActualSpend(makeDeps().deps, { ...input, workspaceId: "ws-b" })).rejects.toMatchObject({ code: "not_found" });
  });
});
