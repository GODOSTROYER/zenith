/** Logging/metric queries are read-only POSTs, scoped solely to observe. No live OCI calls. */
import { describe, expect, it } from "vitest";
import { isAllowed, OCI_ALLOWLIST } from "@/lib/providers/oci/allowlist";
import { createRunnerOciTransport, type OciHttpJobPayload } from "@/lib/providers/oci/runner-transport";
import { OCI_SERVICE_HOSTS, ociPath } from "@/lib/providers/oci/services";
import type { OciApiRequest } from "@/lib/providers/oci/transport";

const reads = [
  { service: "loggingsearch", method: "POST", path: "/20190909/search" },
  { service: "monitoring", method: "POST", path: "/20180401/metrics/actions/summarizeMetricsData" },
] as const;

describe("OCI observability read allowlist", () => {
  it.each(reads)("allows only the exact $service POST for observe", (request) => {
    expect(isAllowed("infrastructure.observe", request)).toBe(true);
    for (const capability of [...Object.keys(OCI_ALLOWLIST).filter((cap) => cap !== "infrastructure.observe"), "logs.read", "unknown"]) {
      expect(isAllowed(capability, request), capability).toBe(false);
    }
    for (const method of ["GET", "HEAD", "PUT"] as const) {
      expect(isAllowed("infrastructure.observe", { ...request, method })).toBe(false);
    }
    for (const path of [request.path + "/extra", request.path + "/", request.path.replace(/\/\d{8}\//, "/20000101/"), request.path.replace(/\/\d{8}/, "")]) {
      expect(isAllowed("infrastructure.observe", { ...request, path }), path).toBe(false);
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
      : { namespace: "oci_computeagent", query: "CpuUtilization[1m].mean()", startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-01T00:01:00Z" };
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
