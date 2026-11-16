/** Real PGlite custody; trusted collector identity is supplied by the separately tested HTTP gate. */
import { describe, expect, it } from "vitest";
import { createUsageExporter } from "@/lib/cost/usage-exporter";
import { closeSharedPgliteAfterAll, sharedDatabase } from "../capabilities/support";
import { randomUUID } from "node:crypto";

closeSharedPgliteAfterAll();
describe("tenant-scoped actual usage exporter", () => {
  it("exports compute, database and object occupancy only for current matching resources; no default zeros", async () => {
    const db = await sharedDatabase("pglite"), workspaceId = `ws-${randomUUID()}`, environmentId = `env-${randomUUID()}`;
    let at = Date.parse("2026-10-08T00:00:00Z");
    const exporter = createUsageExporter(() => new Date(at));
    expect(exporter.renderPrometheus()).toBe("");
    for (const kind of ["container_service", "postgres", "mysql", "object_store"] as const) {
      const resourceId = `res-${randomUUID()}`, address = `${kind}/main`;
      await db.query(`insert into platform.resources (id,workspace_id,environment_id,address,kind,provider,native_type,ownership,spec_digest,spec)
        values($1,$2,$3,$4,$5,'aws',$6,'managed',$7,'{}'::jsonb)`, [resourceId, workspaceId, environmentId, address, kind, `aws:${kind}`, "a".repeat(64)]);
      const report = { workspaceId, environmentId, resourceId, address, observedAt: new Date(at).toISOString(), kind,
        ...(kind === "container_service" ? { cpuPercent: 12, memoryPercent: 25, requestsTotal: 200, internetEgressBytesTotal: 0, interComponentBytesTotal: 0, logIngestBytesTotal: 1000 } : { occupiedBytes: 2048 }) };
      await expect(exporter.record(db, { ...report, workspaceId: "foreign-workspace" })).rejects.toMatchObject({ status: 404 });
      await expect(exporter.record(db, { ...report, environmentId: "foreign-env" })).rejects.toMatchObject({ status: 404 });
      await expect(exporter.record(db, { ...report, address: "wrong/address" })).rejects.toMatchObject({ status: 404 });
      await exporter.record(db, report);
      await expect(exporter.record(db, report)).rejects.toMatchObject({ status: 409 });
      await expect(exporter.record(db, { ...report, simulated: true })).rejects.toMatchObject({ status: 400 });
      await expect(exporter.record(db, { ...report, observedAt: new Date(at + 1).toISOString() })).rejects.toMatchObject({ status: 409 });
    }
    const text = exporter.renderPrometheus();
    expect(text).toContain("# TYPE zenith_cost_internet_egress_bytes_total counter");
    expect(text).toContain(`zenith_workspace_id="${workspaceId}",zenith_environment_id="${environmentId}",zenith_resource_address="container_service/main"} 0`);
    expect(text).toContain('zenith_resource_address="postgres/main"} 2048');
    expect(text).toContain('zenith_resource_address="mysql/main"} 2048');
    expect(text).toContain('zenith_cost_object_storage_bytes{');
    at += 90_001;
    expect(exporter.renderPrometheus()).toBe("");
  });
});
