/**
 * The metric catalog: the single list of every metric the fairness layer emits.
 *
 * `deploy/observability/*` (dashboard and alert definitions) may reference ONLY
 * names listed here; tests/ops/observability-artifacts.test.ts enforces it, so a
 * renamed metric cannot leave a dashboard panel or an alert silently empty.
 *
 * Correlation model (every series that can be tenant-scoped carries `tenant`):
 *   - `tenant`     the workspace id (bounded labeler, overflow = `other`);
 *   - `operation`  never a label (unbounded); it is a SPAN attribute
 *                  (`zenith.operation.id`) and a log field, joined to metrics by
 *                  tenant + time and to traces by trace id / operation id;
 *   - `layer`      where a decision was taken: edge | api | dispatch | runner_queue | worker | maintenance.
 */
import { BackpressureError } from "../errors";
import { metricsRegistry, tenantLabeler, type Counter, type Gauge, type Histogram } from "./metrics";

export interface CatalogEntry { name: string; type: "counter" | "gauge" | "histogram"; labels: readonly string[]; help: string }

export const METRIC_CATALOG: readonly CatalogEntry[] = [
  { name: "zenith_api_requests_total", type: "counter", labels: ["tenant", "route_class", "method", "status_class"], help: "API requests by outcome." },
  { name: "zenith_api_request_duration_seconds", type: "histogram", labels: ["route_class", "method"], help: "API request latency." },
  { name: "zenith_api_inflight_requests", type: "gauge", labels: ["scope"], help: "Requests currently executing in this process." },
  { name: "zenith_admission_decisions_total", type: "counter", labels: ["layer", "decision", "tenant"], help: "Admission decisions by layer: allowed or the refusal code." },
  { name: "zenith_dispatch_total", type: "counter", labels: ["tenant", "kind", "outcome"], help: "Workflow and runner-job dispatch attempts by outcome." },
  { name: "zenith_runner_queue_depth", type: "gauge", labels: ["tenant"], help: "Queued runner jobs per workspace (sampled)." },
  { name: "zenith_runner_queue_depth_total", type: "gauge", labels: [], help: "Queued runner jobs across all workspaces (sampled)." },
  { name: "zenith_active_operations", type: "gauge", labels: ["tenant"], help: "Queued plus running operations per workspace (sampled)." },
  { name: "zenith_maintenance_mode", type: "gauge", labels: ["mode"], help: "1 for the active maintenance mode, 0 for the others." },
  { name: "zenith_control_store_up", type: "gauge", labels: [], help: "1 when the control store answered the last probe, 0 when it did not." },
  { name: "zenith_worker_activity_total", type: "counter", labels: ["tenant", "activity", "outcome"], help: "Worker activity executions by outcome." },
  { name: "zenith_worker_activity_duration_seconds", type: "histogram", labels: ["activity"], help: "Worker activity execution time." },
  { name: "zenith_worker_activity_wait_seconds", type: "histogram", labels: ["activity"], help: "Time a heavy activity waited for its fair turn." },
  { name: "zenith_worker_fair_inflight", type: "gauge", labels: [], help: "Heavy activities holding a fair permit." },
  { name: "zenith_worker_fair_waiting", type: "gauge", labels: [], help: "Heavy activities waiting for a fair permit." },
  { name: "zenith_worker_fair_bypassed_total", type: "counter", labels: ["tenant"], help: "Activities that exhausted their fair wait budget and ran anyway." },
  { name: "zenith_telemetry_dropped_total", type: "counter", labels: ["signal"], help: "Telemetry samples dropped by a bound." },
  { name: "zenith_telemetry_export_failures_total", type: "counter", labels: ["signal"], help: "OTLP export attempts that failed." },
];

export interface OpsInstruments {
  apiRequests: Counter;
  apiDuration: Histogram;
  apiInflight: Gauge;
  admission: Counter;
  dispatch: Counter;
  runnerQueueDepth: Gauge;
  runnerQueueDepthTotal: Gauge;
  activeOperations: Gauge;
  maintenanceMode: Gauge;
  controlStoreUp: Gauge;
  workerActivities: Counter;
  workerDuration: Histogram;
  workerWait: Histogram;
  workerFairInflight: Gauge;
  workerFairWaiting: Gauge;
  workerFairBypassed: Counter;
  exportFailures: Counter;
}

/** Create (or fetch) every instrument. Cheap after the first call. */
export function opsMetrics(): OpsInstruments {
  const r = metricsRegistry();
  const by = (name: string): CatalogEntry => METRIC_CATALOG.find((m) => m.name === name) as CatalogEntry;
  const c = (name: string): Counter => r.counter(name, by(name).help, by(name).labels);
  const g = (name: string): Gauge => r.gauge(name, by(name).help, by(name).labels);
  const h = (name: string): Histogram => r.histogram(name, by(name).help, by(name).labels);
  return {
    apiRequests: c("zenith_api_requests_total"),
    apiDuration: h("zenith_api_request_duration_seconds"),
    apiInflight: g("zenith_api_inflight_requests"),
    admission: c("zenith_admission_decisions_total"),
    dispatch: c("zenith_dispatch_total"),
    runnerQueueDepth: g("zenith_runner_queue_depth"),
    runnerQueueDepthTotal: g("zenith_runner_queue_depth_total"),
    activeOperations: g("zenith_active_operations"),
    maintenanceMode: g("zenith_maintenance_mode"),
    controlStoreUp: g("zenith_control_store_up"),
    workerActivities: c("zenith_worker_activity_total"),
    workerDuration: h("zenith_worker_activity_duration_seconds"),
    workerWait: h("zenith_worker_activity_wait_seconds"),
    workerFairInflight: g("zenith_worker_fair_inflight"),
    workerFairWaiting: g("zenith_worker_fair_waiting"),
    workerFairBypassed: c("zenith_worker_fair_bypassed_total"),
    exportFailures: c("zenith_telemetry_export_failures_total"),
  };
}

/** Record an admission decision. `decision` is `allowed` or a BackpressureCode. */
export function noteAdmission(layer: string, decision: string, workspaceId?: string): void {
  opsMetrics().admission.inc({ layer, decision, tenant: tenantLabeler().label(workspaceId) });
}

export function noteRefusal(error: BackpressureError): void {
  noteAdmission(error.layer, error.code, error.tenant);
}

/**
 * Route classes keep the `route_class` label bounded: ids and tokens never become labels. A segment stays
 * literal only when it looks like a route name (letters and hyphens, or a version such as `v1`); anything
 * with digits or underscores (operation, workspace and runner ids) becomes `:id`. Distinct classes are
 * still capped by the registry's per-metric series limit, so a scanner inventing paths cannot grow memory.
 */
export function routeClassOf(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).slice(0, 6);
  return `/${parts.map((p) => (/^(?:v\d{1,2}|[A-Za-z][A-Za-z-]{0,23})$/.test(p) ? p : ":id")).join("/")}`.slice(0, 120);
}

export const statusClassOf = (status: number): string => `${Math.floor(status / 100)}xx`;
