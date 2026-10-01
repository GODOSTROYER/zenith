/**
 * The OCI transport port: status handling, error hygiene, path building, and
 * the control-plane half of the proposed `oci.http` runner job (validation the
 * runner must repeat, serialization, response decoding).
 */
import { describe, expect, it } from "vitest";
import { createRunnerOciTransport, fromJobResult, OciTransportRefused, toJobPayload, type OciHttpJobPayload, type OciHttpJobResult } from "@/lib/providers/oci/runner-transport";
import { OCI_SERVICE_HOSTS, isOcid, isRegionId, ociPath, requireOcid } from "@/lib/providers/oci/services";
import { classifyStatus, cleanText, ociCall, ociErrorFields, type OciApiRequest, type OciSession } from "@/lib/providers/oci/transport";
import { COMPARTMENT, err, FakeOci, json, REGION } from "./_support";

const session = (oci: FakeOci): OciSession => ({ provider: "oci", region: REGION, compartmentOcid: COMPARTMENT, transport: oci });
const call = (oci: FakeOci, req: Partial<OciApiRequest> = {}, redact = false, signal = new AbortController().signal) =>
  ociCall({ session: session(oci), signal }, { service: "core", region: REGION, method: "GET", path: "/20160918/vcns", ...req }, { redactMessage: redact });

describe("status handling", () => {
  it.each([
    [200, "ok"],
    [204, "ok"],
    [401, "denied"],
    [403, "denied"],
    [404, "not_found"],
    [429, "throttled"],
    [400, "error"],
    [409, "error"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("HTTP %i is %s", (status, kind) => {
    expect(classifyStatus(status)).toBe(kind);
  });

  it("a 200 carries the parsed body, lower-cased headers and the request id", async () => {
    const oci = new FakeOci().route("GET", "/20160918/vcns", { status: 200, headers: { "OPC-Request-Id": "abc", "Opc-Next-Page": "p2" }, body: [{ id: 1 }] });
    const r = await call(oci);
    expect(r).toMatchObject({ ok: true, status: 200, requestId: "abc", body: [{ id: 1 }], headers: { "opc-next-page": "p2" } });
  });

  it("failures become values: code, bounded message, request id, retry-after", async () => {
    const r = await call(new FakeOci().route("GET", "/20160918/vcns", err(429, "TooManyRequests", "slow down", { "retry-after": "12" })));
    expect(r).toMatchObject({ ok: false, outcome: "throttled", status: 429, code: "TooManyRequests", requestId: "req-err", retryAfterSec: 12 });
    expect((r as { message: string }).message).toContain("slow down");
  });

  it("retry-after is bounded and ignored when nonsense", async () => {
    expect(await call(new FakeOci().route("GET", "/20160918/vcns", err(429, "x", "m", { "retry-after": "999999" })))).toMatchObject({ retryAfterSec: 3600 });
    expect(await call(new FakeOci().route("GET", "/20160918/vcns", err(429, "x", "m", { "retry-after": "soon" })))).not.toHaveProperty("retryAfterSec");
  });

  it("OCI's error text is cleaned and bounded; redactMessage drops it entirely", async () => {
    const hostile = { status: 400, headers: {}, body: { code: "Bad\nCode", message: `line1\nline2\u0000 ${"x".repeat(5000)}` } };
    const r = await call(new FakeOci().route("GET", "/20160918/vcns", hostile));
    const msg = (r as { message: string }).message;
    expect(msg).not.toMatch(/[\u0000-\u001f]/);
    expect(msg.length).toBeLessThan(400);
    const redacted = await call(new FakeOci().route("GET", "/20160918/vcns", { status: 400, headers: {}, body: { code: "InvalidParameter", message: "the value hunter2 is wrong" } }), {}, true);
    expect((redacted as { message: string }).message).toContain("InvalidParameter");
    expect((redacted as { message: string }).message).not.toContain("hunter2");
  });

  it("a thrown transport error becomes a `transport` outcome with only its first line", async () => {
    const oci = new FakeOci();
    oci.failWith = new Error("socket hang up\n    at Object.<anonymous> (/srv/app.js:1:1)");
    const r = await call(oci);
    expect(r).toMatchObject({ ok: false, outcome: "transport" });
    expect((r as { message: string }).message).toBe("The OCI runner transport failed: socket hang up.");
  });

  it("an aborted signal sends nothing", async () => {
    const oci = new FakeOci();
    const ac = new AbortController();
    ac.abort();
    const r = await call(oci, {}, false, ac.signal);
    expect(r).toMatchObject({ ok: false, outcome: "transport" });
    expect(oci.calls).toEqual([]);
  });

  it("an abort during the call is reported as cancellation", async () => {
    const ac = new AbortController();
    const slow = { request: async () => { ac.abort(); throw new Error("aborted"); } };
    const r = await ociCall({ session: { ...session(new FakeOci()), transport: slow }, signal: ac.signal }, { service: "core", region: REGION, method: "GET", path: "/20160918/vcns" });
    expect((r as { message: string }).message).toMatch(/cancelled/);
  });

  it("error bodies that are not objects yield no code and no message", () => {
    expect(ociErrorFields("<html>")).toEqual({});
    expect(ociErrorFields(null)).toEqual({});
    expect(ociErrorFields({ code: 5, message: {} })).toEqual({ code: undefined, message: undefined });
    expect(cleanText(42)).toBe("");
  });
});

describe("paths and identifiers", () => {
  it("builds versioned, percent-encoded paths", () => {
    expect(ociPath("core", "vcns")).toBe("/20160918/vcns");
    expect(ociPath("loadbalancer", "loadBalancers", "ocid1.x", "backendSets", "bs 1/2")).toBe("/20170115/loadBalancers/ocid1.x/backendSets/bs%201%2F2");
    expect(ociPath("objectstorage", "n", "ns", "b", "my.bucket")).toBe("/n/ns/b/my.bucket");
    expect(ociPath("queue-data", "queues", "q", "stats")).toBe("/20210201/queues/q/stats");
  });

  it("refuses empty and dot-only segments (path traversal)", () => {
    for (const bad of ["", ".", "..", "..."]) expect(() => ociPath("core", "vcns", bad)).toThrow(/dots|empty/);
    // `..` INSIDE a segment is fine: tenancy-scoped OCIDs have an empty region
    expect(ociPath("identity", "policies", "ocid1.policy.oc1..aaaaaaaaexample")).toBe("/20160918/policies/ocid1.policy.oc1..aaaaaaaaexample");
    expect(() => toJobPayload({ service: "identity", region: REGION, method: "GET", path: ociPath("identity", "policies", "ocid1.policy.oc1..aaaaaaaaexample") })).not.toThrow();
  });

  it("recognises OCIDs and regions by shape, nothing more", () => {
    expect(isOcid("ocid1.compartment.oc1..aaaaaaaaexample1")).toBe(true);
    expect(isOcid("ocid1.instance.oc1.iad.anuwcljrexample")).toBe(true);
    for (const bad of ["", "ocid1", "ocid2.x.oc1..aaaaaaaa", "ocid1.x.oc1..aa", "ocid1.x.oc1..a/b/c/d/e/f", `ocid1.x.oc1..${"a".repeat(400)}`, undefined, 5, "ocid1.x.oc1..aaaaaaaa\n"]) expect(isOcid(bad)).toBe(false);
    expect(() => requireOcid("nope", "the id")).toThrow(/the id is not a valid OCID/);
    expect(isRegionId("us-ashburn-1")).toBe(true);
    expect(isRegionId("eu-frankfurt-1")).toBe(true);
    for (const bad of ["us", "US-ASHBURN-1", "us-ashburn-1.evil.com", "us ashburn 1", "", undefined]) expect(isRegionId(bad)).toBe(false);
  });

  it("every service has a host under oraclecloud.com (or the queue data plane's own)", () => {
    for (const [id, h] of Object.entries(OCI_SERVICE_HOSTS)) {
      if (id === "queue-data") expect(h.host).toBe("{messagesEndpoint}");
      else expect(h.host).toMatch(/^[a-z-]+\.\{region\}\.(oci\.|ocp\.)?oraclecloud\.com$/);
    }
  });
});

describe("oci.http job payload (control-plane half)", () => {
  const base: OciApiRequest = { service: "core", region: REGION, method: "GET", path: "/20160918/subnets" };

  it("serializes sorted query pairs, drops undefined, base64s the JSON body", () => {
    const p = toJobPayload({ ...base, method: "POST", service: "postgresql", path: "/20220915/backups", query: { z: 1, a: "x", skip: undefined, flag: true }, headers: { "Opc-Retry-Token": "tok" }, body: { displayName: "b" } });
    expect(p.query).toEqual([["a", "x"], ["flag", "true"], ["z", "1"]]);
    expect(p.headers).toEqual({ "opc-retry-token": "tok" });
    expect(JSON.parse(Buffer.from(p.bodyB64!, "base64").toString("utf8"))).toEqual({ displayName: "b" });
    expect(p).not.toHaveProperty("endpointHost");
    expect(JSON.stringify(p)).not.toMatch(/https?:\/\/|oraclecloud\.com/); // no host ever
  });

  it.each([
    [{ service: "iaas" }, /Unknown OCI service/],
    [{ service: "evil.example.com" }, /Unknown OCI service/],
    [{ region: "us-ashburn-1.evil.com" }, /not an OCI region/],
    [{ region: "" }, /not an OCI region/],
    [{ method: "DELETE" }, /not allowed/],
    [{ method: "PATCH" }, /not allowed/],
    [{ path: "20160918/vcns" }, /plain absolute path/],
    [{ path: "/20160918/../identity" }, /plain absolute path/],
    [{ path: "/20160918//vcns" }, /plain absolute path/],
    [{ path: "/20160918/vcns?compartmentId=x" }, /plain absolute path/],
    [{ path: "/20160918/vcns#frag" }, /plain absolute path/],
    [{ path: "/20160918\\vcns" }, /plain absolute path/],
    [{ path: "/20160918/vcns\n" }, /plain absolute path/],
    [{ path: "/20160918/%2e%2e/identity" }, /plain absolute path/],
    [{ path: "/20160918/%2E/vcns" }, /plain absolute path/],
    [{ path: "/20160918/vcns/a%2Fb" }, /plain absolute path/],
    [{ path: "/20160918/vcns/a%5Cb" }, /plain absolute path/],
    [{ path: "/20160918/vcns/%00" }, /plain absolute path/],
    [{ path: "/20160918/vcns/%zz" }, /plain absolute path/],
    [{ path: "/20160918/vcns/" }, /plain absolute path/],
    [{ path: `/${"a".repeat(2100)}` }, /plain absolute path/],
    [{ headers: { Authorization: "Bearer x" } }, /set by the runner/],
    [{ headers: { host: "evil" } }, /set by the runner/],
    [{ headers: { "X-Date": "1" } }, /set by the runner/],
    [{ headers: { "content-type": "text/plain" } }, /set by the runner/],
    [{ headers: { "X-Custom": "1" } }, /not in the allowlist/],
    [{ headers: { "opc-retry-token": "a\r\nInjected: 1" } }, /invalid value/],
    [{ body: { a: 1 } }, /carry no body/],
    [{ endpointHost: "x.oraclecloud.com" }, /only valid for queue-data/],
  ] as [Partial<OciApiRequest>, RegExp][])("refuses %j", (over, message) => {
    expect(() => toJobPayload({ ...base, ...over } as OciApiRequest)).toThrow(message);
  });

  it("refuses an oversize body", () => {
    expect(() => toJobPayload({ ...base, method: "PUT", body: { x: "y".repeat(2_000_000) } })).toThrow(/too large/);
    expect(() => toJobPayload({ ...base, method: "PUT", body: { x: "y".repeat(200) } }, { maxRequestBytes: 100 })).toThrow(/too large/);
  });

  it("queue-data needs an *.oraclecloud.com endpoint host", () => {
    const q: OciApiRequest = { service: "queue-data", region: REGION, method: "GET", path: "/20210201/queues/q/stats" };
    expect(toJobPayload({ ...q, endpointHost: "Cell-1.queue.messaging.us-ashburn-1.oci.oraclecloud.com" }).endpointHost).toBe("cell-1.queue.messaging.us-ashburn-1.oci.oraclecloud.com");
    for (const host of [undefined, "", "evil.com", "oraclecloud.com.evil.com", "169.254.169.254", "a.oraclecloud.com:8080", "x/y.oraclecloud.com"]) {
      expect(() => toJobPayload({ ...q, endpointHost: host }), String(host)).toThrow(OciTransportRefused);
    }
  });
});

describe("oci.http job result (control-plane half)", () => {
  const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64");

  it("decodes JSON, keeps only allowlisted headers, lower-cases them", () => {
    const r = fromJobResult({ status: 200, headers: { "Opc-Request-Id": "r", "Set-Cookie": "s=1", "X-Internal": "1", ETag: "e" }, bodyB64: b64({ a: 1 }) });
    expect(r).toEqual({ status: 200, headers: { "opc-request-id": "r", etag: "e" }, body: { a: 1 } });
  });

  it("a JSON string body (the Object Storage namespace) stays a string; non-JSON is bounded text; empty is undefined", () => {
    expect(fromJobResult({ status: 200, headers: {}, bodyB64: b64('"tenantns"') }).body).toBe("tenantns");
    expect(fromJobResult({ status: 502, headers: {}, bodyB64: b64("<html>" + "x".repeat(5000)) }).body).toHaveLength(2000);
    expect(fromJobResult({ status: 204, headers: {} }).body).toBeUndefined();
    expect(fromJobResult({ status: 204, headers: {}, bodyB64: "" }).body).toBeUndefined();
  });

  it("refuses nonsense statuses, truncated bodies and oversize bodies", () => {
    for (const status of [0, 99, 600, 200.5, Number.NaN]) expect(() => fromJobResult({ status, headers: {} })).toThrow(/invalid HTTP status/);
    expect(() => fromJobResult({ status: 200, headers: {}, bodyB64: b64({ a: 1 }), truncated: true })).toThrow(/truncated/);
    expect(() => fromJobResult({ status: 200, headers: {}, bodyB64: b64("x".repeat(2000)) }, { maxResponseBytes: 100 })).toThrow(/larger than allowed/);
  });

  it("caps header values", () => {
    expect(fromJobResult({ status: 200, headers: { "opc-next-page": "p".repeat(5000) } }).headers["opc-next-page"]).toHaveLength(2000);
  });
});

describe("the runner-backed transport", () => {
  const dispatchTo = (record: OciHttpJobPayload[], result: OciHttpJobResult = { status: 200, headers: {}, bodyB64: Buffer.from("[]").toString("base64") }) =>
    async (p: OciHttpJobPayload) => {
      record.push(p);
      return result;
    };

  it("sends the unsigned payload and the abort signal to dispatch, and decodes the answer", async () => {
    const seen: OciHttpJobPayload[] = [];
    let gotSignal: AbortSignal | undefined;
    const t = createRunnerOciTransport(async (p, o) => ((gotSignal = o.signal), dispatchTo(seen)(p)), { capability: "infrastructure.observe" });
    const ac = new AbortController();
    const res = await t.request({ service: "core", region: REGION, method: "GET", path: "/20160918/vcns", query: { compartmentId: COMPARTMENT } }, { signal: ac.signal });
    expect(res).toEqual({ status: 200, headers: {}, body: [] });
    expect(gotSignal).toBe(ac.signal);
    expect(seen).toEqual([{ service: "core", region: REGION, method: "GET", path: "/20160918/vcns", query: [["compartmentId", COMPARTMENT]], headers: {} }]);
  });

  it("refuses, BEFORE dispatching, anything outside the session capability's allowlist", async () => {
    const seen: OciHttpJobPayload[] = [];
    const observe = createRunnerOciTransport(dispatchTo(seen), { capability: "infrastructure.observe" });
    await expect(observe.request({ service: "containerinstances", region: REGION, method: "POST", path: "/20210415/containerInstances/ocid1.x.oc1..aaaaaaaaaa/actions/restart" })).rejects.toThrow(/not in the allowlist of capability infrastructure\.observe/);
    await expect(observe.request({ service: "vault", region: REGION, method: "PUT", path: "/20180608/secrets/ocid1.x.oc1..aaaaaaaaaa", body: {} })).rejects.toThrow(OciTransportRefused);
    await expect(observe.request({ service: "vault", region: REGION, method: "GET", path: "/20190301/secretbundles/ocid1.x.oc1..aaaaaaaaaa" })).rejects.toThrow(OciTransportRefused);
    await expect(createRunnerOciTransport(dispatchTo(seen), { capability: "no.such.capability" }).request({ service: "core", region: REGION, method: "GET", path: "/20160918/vcns" })).rejects.toThrow(OciTransportRefused);
    expect(seen).toEqual([]);
    const restart = createRunnerOciTransport(dispatchTo(seen), { capability: "service.restart" });
    await restart.request({ service: "containerinstances", region: REGION, method: "POST", path: "/20210415/containerInstances/ocid1.x.oc1..aaaaaaaaaa/actions/restart", headers: { "opc-retry-token": "t" } });
    expect(seen).toHaveLength(1);
  });

  it("through ociCall a refusal is a `transport` outcome, not an exception", async () => {
    const t = createRunnerOciTransport(dispatchTo([]), { capability: "infrastructure.observe" });
    const r = await ociCall({ session: { ...session(new FakeOci()), transport: t }, signal: new AbortController().signal }, { service: "core", region: REGION, method: "GET", path: "/20160918/../identity/policies" });
    expect(r).toMatchObject({ ok: false, outcome: "transport" });
  });
});

describe("a fake that behaves like OCI for the helper", () => {
  it("json() builds a 200 with a request id", () => {
    expect(json({ a: 1 })).toEqual({ status: 200, headers: { "opc-request-id": "req-1" }, body: { a: 1 } });
  });
});
