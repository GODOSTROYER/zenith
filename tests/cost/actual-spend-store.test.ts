/**
 * PROD-COST-01 on the real SQL store: provider-reported actual spend is stored
 * apart from estimates, is idempotent per provider response, and is tenant
 * scoped. PGlite always; real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is
 * set (see `tests/controlplane/_support/harness.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { newActualSpend, type ActualSpend } from "@/lib/cost/kinds";
import { estimateGraphCost, loadDefaultCatalog } from "@/lib/placement";
import { LANES, newWorkspace, openLane, uid } from "../controlplane/_support/harness";
import { node } from "../placement/fixtures";

function snapshot(over: Partial<Parameters<typeof newActualSpend>[0]> = {}): ActualSpend {
  return newActualSpend({
    provider: "aws",
    scope: "123456789012",
    periodStart: "2026-10-01",
    periodEnd: "2026-11-01",
    totalUsd: 42.5,
    lines: [{ service: "Amazon Elastic Compute Cloud - Compute", usd: 42.5 }],
    costBasis: "test",
    finalization: "provisional",
    source: { adapter: "test", endpoint: "https://example.invalid/", retrievedAt: "2026-10-11T00:00:00.000Z", responseSha256: uid("x").replace(/[^0-9a-f]/g, "a").padEnd(64, "a").slice(0, 64) },
    ...over,
  });
}

describe("migration inventory", () => {
  it("0037 creates the actual spend table with row level security", () => {
    const m = PLATFORM_MIGRATIONS.find((x) => x.name === "actual_spend");
    expect(m?.version).toBe(37);
    expect(m!.sql).toContain("platform.actual_spend_snapshots");
    expect(m!.sql).toContain("alter table platform.actual_spend_snapshots enable row level security");
    expect(m!.sql).toContain("grant select,insert on table platform.actual_spend_snapshots to service_role");
    expect(m!.sql).not.toMatch(/grant[^;]*update/i);
  });
});

describe.each(LANES)("actual spend store [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  it("stores a snapshot and returns it with its checksum, scoped to the workspace", async () => {
    const ws = newWorkspace();
    const s = snapshot();
    const row = await repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, environmentId: "env-1", projectId: "proj-1", snapshot: s, recordedBy: "user-1" });
    expect(row.snapshot).toEqual(s);
    expect(row.snapshot.source.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    const listed = await repos.actualSpend.listActualSpend(ctx.db, ws, { environmentId: "env-1" });
    expect(listed.map((r) => r.id)).toEqual([row.id]);
    expect(await repos.actualSpend.listActualSpend(ctx.db, newWorkspace(), { environmentId: "env-1" })).toEqual([]);
  });

  it("is idempotent for the same provider response and keeps a revision when the response differs", async () => {
    const ws = newWorkspace();
    const s = snapshot();
    const a = await repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, environmentId: "env-1", snapshot: s, recordedBy: "u" });
    const again = await repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, environmentId: "env-1", snapshot: s, recordedBy: "u" });
    expect(again.id).toBe(a.id);
    const revised = snapshot({ totalUsd: 60, source: { ...s.source, responseSha256: "d".repeat(64) } });
    const b = await repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, environmentId: "env-1", snapshot: revised, recordedBy: "u" });
    expect(b.id).not.toBe(a.id);
    expect((await repos.actualSpend.listActualSpend(ctx.db, ws, { environmentId: "env-1" })).length).toBe(2);
  });

  it("refuses an estimate or a record without a response checksum", async () => {
    const ws = newWorkspace();
    const estimate = estimateGraphCost({ nodes: [node("service/web", "container_service", "aws", "us-east-1", { size: "small" })] }, { catalog: loadDefaultCatalog() });
    await expect(repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, snapshot: estimate as unknown as ActualSpend, recordedBy: "u" })).rejects.toMatchObject({ code: "invalid_input" });
    const noSha = { ...snapshot(), source: { ...snapshot().source, responseSha256: "nope" } };
    await expect(repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, snapshot: noSha, recordedBy: "u" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("the database itself refuses a non-actual-spend document and an inverted period", async () => {
    const ws = newWorkspace();
    await expect(
      ctx.db.query(
        `insert into platform.actual_spend_snapshots (id, workspace_id, provider, scope, period_start, period_end, total_usd, finalization, response_sha256, snapshot, retrieved_at, recorded_by)
         values ($1, $2, 'aws', 's', '2026-10-01', '2026-11-01', 1, 'final', $3, '{"kind":"estimate"}'::jsonb, now(), 'u')`,
        [uid("spend"), ws, "e".repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      ctx.db.query(
        `insert into platform.actual_spend_snapshots (id, workspace_id, provider, scope, period_start, period_end, total_usd, finalization, response_sha256, snapshot, retrieved_at, recorded_by)
         values ($1, $2, 'aws', 's', '2026-11-01', '2026-10-01', 1, 'final', $3, '{"kind":"actual_spend"}'::jsonb, now(), 'u')`,
        [uid("spend"), ws, "f".repeat(64)],
      ),
    ).rejects.toThrow();
  });

  it("orders newest period first and filters by provider", async () => {
    const ws = newWorkspace();
    const sha = (c: string) => c.repeat(64);
    await repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, environmentId: "env-1", snapshot: snapshot({ periodStart: "2026-08-01", periodEnd: "2026-09-01", finalization: "final", source: { adapter: "t", endpoint: "https://example.invalid/", retrievedAt: "2026-09-10T00:00:00.000Z", responseSha256: sha("1") } }), recordedBy: "u" });
    await repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, environmentId: "env-1", snapshot: snapshot({ source: { adapter: "t", endpoint: "https://example.invalid/", retrievedAt: "2026-10-11T00:00:00.000Z", responseSha256: sha("2") } }), recordedBy: "u" });
    await repos.actualSpend.insertActualSpend(ctx.db, { workspaceId: ws, environmentId: "env-1", snapshot: snapshot({ provider: "gcp", scope: "my-project-123.ds.gcp_billing_export_v1_X", source: { adapter: "t", endpoint: "https://example.invalid/", retrievedAt: "2026-10-11T00:00:00.000Z", responseSha256: sha("3") } }), recordedBy: "u" });
    const all = await repos.actualSpend.listActualSpend(ctx.db, ws, { environmentId: "env-1" });
    expect(all.map((r) => r.snapshot.periodStart)).toEqual(["2026-10-01", "2026-10-01", "2026-08-01"]);
    const gcpOnly = await repos.actualSpend.listActualSpend(ctx.db, ws, { provider: "gcp" });
    expect(gcpOnly).toHaveLength(1);
    expect(gcpOnly[0]!.snapshot.provider).toBe("gcp");
  });
});
