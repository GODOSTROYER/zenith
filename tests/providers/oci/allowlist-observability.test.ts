/** Fixed signal POSTs are restricted to their read capabilities. No live OCI calls. */
import { describe, expect, it } from "vitest";
import { isAllowed, OCI_ALLOWLIST, OBSERVE_RULES } from "@/lib/providers/oci/allowlist";
import { createRunnerOciTransport, type OciHttpJobPayload } from "@/lib/providers/oci/runner-transport";
import { OCI_SERVICE_HOSTS, ociPath } from "@/lib/providers/oci/services";
import type { OciApiRequest } from "@/lib/providers/oci/transport";
import { CAPABILITIES } from "@/lib/capabilities/catalog";

const reads = [
  { service: "loggingsearch", method: "POST", path: "/20190909/search" },
  { service: "monitoring", method: "POST", path: "/20180401/metrics/actions/summarizeMetricsData" },
] as const;

describe("OCI observability read allowlist", () => {
  it.each(reads)("splits the exact $service POST by read capability", (request) => {
    const permitted = ["infrastructure.observe", "incident.investigate", request.service === "loggingsearch" ? "logs.read" : "metrics.read"];
    for (const capability of [...Object.keys(CAPABILITIES), "unknown"]) {
      expect(isAllowed(capability, request), capability).toBe(permitted.includes(capability));
    }
    for (const capability of permitted) {
      for (const method of ["GET", "HEAD", "PUT"] as const) {
        expect(isAllowed(capability, { ...request, method })).toBe(false);
      }
      for (const path of [request.path + "/extra", request.path + "/", request.path.replace(/\/\d{8}\//, "/20000101/"), request.path.replace(/\/\d{8}/, "")]) {
        expect(isAllowed(capability, { ...request, path }), path).toBe(false);
      }
    }
  });
  it("keeps narrow signal capabilities separate from metadata and mutations", () => {
    expect(OCI_ALLOWLIST["logs.read"]).toEqual([{ service: "loggingsearch", method: "POST", pattern: "search" }]);
    expect(OCI_ALLOWLIST["metrics.read"]).toEqual([{ service: "monitoring", method: "POST", pattern: "metrics/actions/summarizeMetricsData" }]);
    expect(OCI_ALLOWLIST["incident.investigate"]).toEqual(OCI_ALLOWLIST["infrastructure.observe"]);
    expect(OCI_ALLOWLIST["topology.read"]).toEqual(OBSERVE_RULES);
    for (const rule of OBSERVE_RULES) {
      const version = OCI_SERVICE_HOSTS[rule.service].version;
      const request = { ...rule, path: `/${[version, rule.pattern.replaceAll("{}", "fixture")].filter(Boolean).join("/")}` };
      expect(isAllowed("incident.investigate", request)).toBe(true);
      expect(isAllowed("logs.read", request)).toBe(false);
      expect(isAllowed("metrics.read", request)).toBe(false);
    }
  });

  it("uses the search and telemetry endpoints with their distinct API versions", () => {
    expect(OCI_SERVICE_HOSTS.loggingsearch).toEqual({ host: "logging.{region}.oci.oraclecloud.com", version: "20190909" });
    expect(OCI_SERVICE_HOSTS.monitoring).toEqual({ host: "telemetry.{region}.oraclecloud.com", version: "20180401" });
    expect(ociPath("loggingsearch", "search")).toBe(reads[0].path);
    expect(ociPath("monitoring", "metrics", "actions", "summarizeMetricsData")).toBe(reads[1].path);
  });

  it.each([
    { service: "monitoring", method: "POST", path: "/20180401/metrics" },
    { service: "monitoring", method: "POST", path: "/20180401/alarms" },
    { service: "monitoring", method: "POST", path: "/20180401/metrics/actions/listMetrics" },
    { service: "logging", method: "POST", path: "/20200531/logGroups" },
    { service: "loggingsearch", method: "POST", path: "/20190909/search/actions/delete" },
    { service: "logging", method: "POST", path: "/20190909/search" },
  ] as const)("refuses adjacent operation $service $path for every capability", (request) => {
    for (const capability of Object.keys(OCI_ALLOWLIST)) expect(isAllowed(capability, request)).toBe(false);
  });

  it.each(reads)("serializes $service reads through the observe transport without credentials", async (request) => {
    const compartmentId = "ocid1.compartment.oc1..fixture";
    const body = request.service === "loggingsearch"
      ? { searchQuery: `search "${compartmentId}"`, timeStart: "2026-10-01T00:00:00Z", timeEnd: "2026-10-01T00:01:00Z" }
      : { namespace: "oci_computeagent", query: 'CpuUtilization[1m]{resourceId = "ocid1.instance.oc1.iad.fixture"}.mean()', resolution: "1m", startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-01T00:01:00Z" };
    const jobs: OciHttpJobPayload[] = [];
    const transport = createRunnerOciTransport(async (payload) => {
      jobs.push(payload);
      return { status: 200, headers: {}, bodyB64: Buffer.from(JSON.stringify({ synthetic: true })).toString("base64") };
    }, { capability: "infrastructure.observe" });
    const req: OciApiRequest = { ...request, region: "us-ashburn-1", body, ...(request.service === "monitoring" ? { query: { compartmentId } } : {}) };
    expect(await transport.request(req)).toMatchObject({ status: 200, body: { synthetic: true } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...request, headers: {}, query: request.service === "monitoring" ? [["compartmentId", compartmentId]] : [] });
    expect(JSON.parse(Buffer.from(jobs[0].bodyB64!, "base64").toString("utf8"))).toEqual(body);
    expect(jobs[0]).not.toHaveProperty("endpointHost");
    const forbidden = createRunnerOciTransport(async () => { throw new Error("must not dispatch"); }, { capability: "topology.read" });
    await expect(forbidden.request(req)).rejects.toThrow(/allowlist/);
  });
});
