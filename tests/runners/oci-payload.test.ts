/** Unsigned wire payload bounds and refusals; all tests are offline. */
import { describe, expect, it } from "vitest";
import { OciHttpPayloadSchema, validateRunnerPayload } from "@/lib/runners/payloads";
import { toJobPayload } from "@/lib/providers/oci/runner-transport";

const payload = { service: "core", region: "us-ashburn-1", method: "GET", path: "/20160918/subnets", query: [["compartmentId", "ocid1.compartment.oc1..fixture"]], headers: {} };
describe("oci.http payload schema", () => {
  it("accepts the real transport's unsigned serialization", () => {
    const serialized = toJobPayload({ service: "core", region: "us-ashburn-1", method: "GET", path: payload.path, query: { compartmentId: "ocid1.compartment.oc1..fixture" } });
    expect(validateRunnerPayload("oci.http", serialized)).toEqual(serialized);
  });
  it("defaults omitted query and headers without introducing credentials", () => {
    expect(OciHttpPayloadSchema.parse({ service: "core", region: payload.region, method: "GET", path: payload.path })).toEqual({ ...payload, query: [] });
  });
  it.each([
    { service: "https://evil.example" }, { service: "toString" }, { region: "../../metadata" }, { method: "DELETE" }, { method: "PATCH" },
    { path: "/20160918//subnets" }, { path: "/20160918/../subnets" }, { path: "/20160918/%2e%2e/subnets" },
    { path: "/20160918/subnets%2Fother" }, { path: "/20160918/subnets%5cother" }, { path: "/20160918/subnets%00" },
    { path: "/20160918/subnets?x=1" }, { path: "/20160918/subnets#x" }, { path: "/20160918/subnets x" },
    { path: "/20160918/café" }, { path: "/20160918/%ff" }, { path: "/"+"x".repeat(2048) },
    { headers: { Authorization: "synthetic" } }, { headers: { Host: "metadata" } }, { headers: { Date: "synthetic" } },
    { headers: { "x-content-sha256": "synthetic" } }, { headers: { "Content-Length": "1" } }, { headers: { "Proxy-Foo": "synthetic" } },
    { headers: { Cookie: "synthetic" } }, { headers: { "opc-request-id": "bad\nvalue" } }, { headers: { "opc-request-id": "x".repeat(257) } },
    { headers: { "opc-request-id": "a", "Opc-Request-Id": "b" } },
    { query: [["z", "1"], ["a", "2"]] }, { query: [["a", "b", "c"]] }, { query: [["a", "bad\u0000"]] },
    { query: Array.from({ length: 129 }, () => ["a", "b"]) }, { query: [["a", "x".repeat(2049)]] },
    { bodyB64: Buffer.from("{}").toString("base64") }, { endpointHost: "a.oraclecloud.com" }, { url: "https://evil.example" },
    { sealedBodyB64: "synthetic" }, { query: null }, { headers: null },
  ])("refuses malformed or credential-shaped input %#", (patch) => expect(OciHttpPayloadSchema.safeParse({ ...payload, ...patch }).success).toBe(false));
  it("preserves encoded OCIDs and ordered repeated query pairs", () => {
    const p = { ...payload, path: "/20160918/subnets/ocid1.subnet.oc1..fixture", query: [["a", "a b"], ["a", "+"], ...payload.query] };
    expect(OciHttpPayloadSchema.parse(p)).toEqual(p);
  });
  it("permits queue-data only with a strict Oracle endpoint host", () => {
    const p = { ...payload, service: "queue-data", endpointHost: "cell.queue.messaging.us-ashburn-1.oci.oraclecloud.com" };
    expect(OciHttpPayloadSchema.safeParse(p).success).toBe(true);
    for (const endpointHost of [undefined, "oraclecloud.com", "evil.oraclecloud.com.attacker.com", "a..oraclecloud.com", "a.oraclecloud.com:443", "https://a.oraclecloud.com"]) {
      expect(OciHttpPayloadSchema.safeParse({ ...p, endpointHost }).success).toBe(false);
    }
  });
  it("bounds decoded JSON bodies including noncanonical base64", () => {
    const p = { ...payload, service: "postgresql", method: "POST", path: "/20220915/backups", headers: { "opc-retry-token": "test" } };
    expect(OciHttpPayloadSchema.safeParse({ ...p, bodyB64: Buffer.from('"' + "x".repeat((1 << 20) - 2) + '"').toString("base64") }).success).toBe(true);
    for (const body of ['"' + "x".repeat((1 << 20) - 1) + '"', "plain text"]) {
      expect(OciHttpPayloadSchema.safeParse({ ...p, bodyB64: Buffer.from(body).toString("base64") }).success).toBe(false);
    }
    for (const bodyB64 of ["e31=", "e30", "/w=="]) expect(OciHttpPayloadSchema.safeParse({ ...p, bodyB64 }).success).toBe(false);
    expect(OciHttpPayloadSchema.safeParse({ ...p, headers: {}, bodyB64: "e30=" }).success).toBe(false);
  });
  it("refuses unsealed Vault writes before a job can be queued", () => {
    const parsed = OciHttpPayloadSchema.safeParse({ ...payload, service: "vault", method: "PUT", path: "/20180608/secrets/ocid1.vaultsecret.oc1..fixture", bodyB64: "e30=" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].message).toContain("sealed-body");
  });
});
