import { z } from "zod";
import type { Sql } from "@/lib/controlplane/types";
import { ApiError } from "@/lib/server/errors";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const amount = z.number().finite().nonnegative();
const bytesOrCount = amount.int().safe();
const common = { workspaceId: id, environmentId: id, resourceId: id, address: z.string().min(1).max(512), observedAt: z.string().datetime() };
/** Reports are actual cumulative boundary counters, or actual occupied storage, never configured capacity. */
export const UsageReport = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("container_service"), cpuPercent: amount.max(100), memoryPercent: amount.max(100), requestsTotal: bytesOrCount,
    internetEgressBytesTotal: bytesOrCount, interComponentBytesTotal: bytesOrCount, logIngestBytesTotal: bytesOrCount }).strict(),
  z.object({ ...common, kind: z.enum(["object_store", "postgres", "mysql"]), occupiedBytes: bytesOrCount }).strict(),
]);
export type UsageReport = z.infer<typeof UsageReport>;
const FRESH_MS = 90_000;
const MAX_RESOURCES = 2000;
const names = {
  cpuPercent: "zenith_cost_cpu_percent", memoryPercent: "zenith_cost_memory_percent", requestsTotal: "zenith_cost_requests_total",
  internetEgressBytesTotal: "zenith_cost_internet_egress_bytes_total", interComponentBytesTotal: "zenith_cost_inter_component_bytes_total", logIngestBytesTotal: "zenith_cost_log_ingest_bytes_total",
} as const;
const escape = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');

/** One fixed exporter per target. Prometheus owns history; missing/stale samples are absent, never zero-filled. */
export function createUsageExporter(now: () => Date = () => new Date()) {
  const latest = new Map<string, UsageReport>();
  const key = (r: UsageReport) => JSON.stringify([r.workspaceId, r.environmentId, r.address]);
  const prune = () => { for (const [k, r] of latest) if (now().getTime() - Date.parse(r.observedAt) > FRESH_MS) latest.delete(k); };
  return {
    async record(db: Sql, raw: unknown): Promise<void> {
      const parsed = UsageReport.safeParse(raw);
      if (!parsed.success) throw new ApiError("Usage report is invalid.", 400);
      const report = parsed.data, age = now().getTime() - Date.parse(report.observedAt);
      if (age < 0 || age > FRESH_MS) throw new ApiError("Usage report is not current.", 409);
      const rows = await db.query<{ id: string }>(
        `select id from platform.resources where workspace_id=$1 and environment_id=$2 and id=$3
          and address=$4 and kind=$5 and ownership='managed' and status <> 'deleted' limit 2`,
        [report.workspaceId, report.environmentId, report.resourceId, report.address, report.kind],
      );
      if (rows.length !== 1) throw new ApiError("Usage resource was not found.", 404);
      // Re-check after SQL/lock waits; delayed/replayed reports cannot refresh a stale counter.
      if (now().getTime() - Date.parse(report.observedAt) > FRESH_MS) throw new ApiError("Usage report is not current.", 409);
      prune();
      const k = key(report), previous = latest.get(k);
      if (previous && (previous.resourceId !== report.resourceId || Date.parse(report.observedAt) <= Date.parse(previous.observedAt))) throw new ApiError("Usage report is stale or ambiguous.", 409);
      if (!previous && latest.size >= MAX_RESOURCES) throw new ApiError("Usage exporter resource limit reached.", 503);
      latest.set(k, report);
    },
    renderPrometheus(): string {
      prune();
      const series = new Map<string, string[]>();
      const add = (name: string, labels: string, value: number) => { const entries = series.get(name) ?? []; entries.push(`${name}{${labels}} ${value}`); series.set(name, entries); };
      for (const r of [...latest.values()].sort((a, b) => key(a).localeCompare(key(b)))) {
        const labels = `zenith_workspace_id="${escape(r.workspaceId)}",zenith_environment_id="${escape(r.environmentId)}",zenith_resource_address="${escape(r.address)}"`;
        add("zenith_cost_usage_observed_at_seconds", labels, Date.parse(r.observedAt) / 1000);
        if (r.kind === "container_service") for (const [field, name] of Object.entries(names)) add(name, labels, r[field as keyof typeof names]);
        else add(r.kind === "object_store" ? "zenith_cost_object_storage_bytes" : "zenith_cost_db_storage_bytes", labels, r.occupiedBytes);
      }
      return [...series].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => `# TYPE ${name} ${name.endsWith("_total") ? "counter" : "gauge"}\n${rows.join("\n")}\n`).join("");
    },
  };
}
const EXPORTER = Symbol.for("zenith.cost.usage-exporter");
type Global = typeof globalThis & { [EXPORTER]?: ReturnType<typeof createUsageExporter> };
export function usageExporter() { return ((globalThis as Global)[EXPORTER] ??= createUsageExporter()); }
