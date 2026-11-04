/**
 * observe / verify / discover against a fake Google API server, for every
 * driver: present, 404 missing, 403 inaccessible, 429/5xx/garbage unknown,
 * externalId outside the session project, label search (one match, none,
 * ambiguous), drift, and no credential or env value in any result.
 */
import { afterEach, describe, expect, it } from "vitest";
import { gcpDrivers } from "@/lib/providers/gcp/drivers";
import type { Observation } from "@/lib/resources/types";
import { ACCESS_TOKEN, FakeGoogle, fakeGoogle } from "./_fake-google";
import { PLAIN_ENV_CANARY, SQL_IP_CANARY, ctxFor, node, readCases, serve, type Json, type ReadCase } from "./_reads";

const servers: FakeGoogle[] = [];
async function fake(): Promise<FakeGoogle> {
  const f = await fakeGoogle();
  servers.push(f);
  return f;
}
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

const driverOf = (c: ReadCase) => gcpDrivers.find((d) => d.nativeType === node(c.address).nativeType)!;
const cases = readCases();
const strip = (b: Json): Json => {
  const out = JSON.parse(JSON.stringify(b)) as Json;
  delete out.labels;
  delete out.description;
  const settings = out.settings as Json | undefined;
  if (settings) delete settings.userLabels;
  return out;
};

describe.each(cases)("$name: observe", (c) => {
  it("reads the object by externalId and reports exactly the desired attributes as known", async () => {
    const f = await fake();
    serve(f, c);
    const d = driverOf(c);
    const ctx = ctxFor(await f.session());
    const obs = await d.observe!(ctx, node(c.address), c.externalId);
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(c.externalId);
    expect(obs.source).toBe(d.id);
    expect(obs.simulated).toBe(false);
    expect(obs.address).toBe(c.address);
    expect(obs.observedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(obs.error).toBeUndefined();
    const expected = d.expectedAttributes!(node(c.address));
    for (const [k, v] of Object.entries(expected)) {
      const got = obs.attributes[k];
      expect(got, `${c.name}.${k}`).toBeDefined();
      expect(got.state, `${c.name}.${k}`).toBe("known");
      if (got.state === "known") expect(got.value, `${c.name}.${k}`).toEqual(v);
    }
    // every attribute is either a known value or an unknown with a reason; nothing is invented
    for (const v of Object.values(obs.attributes)) expect(["known", "unknown"]).toContain(v.state);
    expect(Buffer.byteLength(JSON.stringify(obs.native ?? {}))).toBeLessThanOrEqual(4096);
    // read-only: only GET requests, to allowlisted hosts
    const writes = f.requests.filter((r) => !["GET"].includes(r.method) && !r.host.startsWith("sts.") && !r.host.startsWith("iamcredentials."));
    expect(writes).toEqual([]);
  });

  it("returns no credential, env value, or private address", async () => {
    const f = await fake();
    serve(f, c);
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address), c.externalId);
    const text = JSON.stringify(obs);
    for (const leak of [ACCESS_TOKEN, PLAIN_ENV_CANARY, SQL_IP_CANARY, "Bearer "]) expect(text).not.toContain(leak);
  });

  it("finds the object by its Zenith labels when no externalId is known, ignoring another environment's", async () => {
    if (!c.list) return;
    const f = await fake();
    serve(f, c);
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address));
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(c.externalId);
  });

  it("reports missing when the tag search finds nothing", async () => {
    if (!c.list) return;
    const f = await fake();
    f.get(c.list.path, { json: { [c.list.key]: c.decoy ? [c.decoy] : [] } });
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address));
    expect(obs.presence).toBe("missing");
    expect(obs.externalId).toBeUndefined();
  });

  it("refuses to guess between two objects carrying the same labels", async () => {
    if (!c.list) return;
    const f = await fake();
    f.get(c.list.path, { json: { [c.list.key]: [c.body, c.body] } });
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address));
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/refusing to guess|same Zenith labels/);
  });

  it("reports missing on HTTP 404 with attributes unknown/not_applicable", async () => {
    const f = await fake();
    f.get(c.get, { status: 404, json: { error: { code: 404, status: "NOT_FOUND", message: "gone" } } });
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address), c.externalId);
    expect(obs.presence).toBe("missing");
    expect(obs.error).toBeUndefined();
    for (const v of Object.values(obs.attributes)) expect(v).toMatchObject({ state: "unknown", reason: "not_applicable" });
  });

  it("reports inaccessible on HTTP 403, including a disabled API, with access_denied attributes", async () => {
    const f = await fake();
    f.get(c.get, { status: 403, json: { error: { code: 403, status: "PERMISSION_DENIED", message: "API has not been used", details: [{ reason: "SERVICE_DISABLED" }] } } });
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address), c.externalId);
    expect(obs.presence).toBe("inaccessible");
    expect(obs.error).toContain("PERMISSION_DENIED");
    for (const v of Object.values(obs.attributes)) expect(v).toMatchObject({ state: "unknown", reason: "access_denied" });
  });

  it.each([
    [429, "throttled"],
    [500, "server error"],
    [503, "unavailable"],
  ])("reports unknown (not missing, not fine) on HTTP %i", async (status) => {
    const f = await fake();
    f.get(c.get, { status, json: { error: { code: status, status: "UNAVAILABLE", message: "try later" } } });
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address), c.externalId);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toBeTruthy();
    for (const v of Object.values(obs.attributes)) expect(v).toMatchObject({ state: "unknown", reason: "error" });
  });

  it("reports unknown for a response that is not JSON", async () => {
    const f = await fake();
    f.get(c.get, { text: "<html>oops</html>" });
    const ctx = ctxFor(await f.session());
    const obs = await driverOf(c).observe!(ctx, node(c.address), c.externalId);
    expect(obs.presence).toBe("unknown");
  });

  it("refuses an externalId that points outside the session project, sending nothing", async () => {
    const f = await fake();
    serve(f, c);
    const ctx = ctxFor(await f.session());
    const before = f.requests.length;
    const obs = await driverOf(c).observe!(ctx, node(c.address), c.otherProjectId);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/externalId is not|not a/);
    expect(f.requests.length).toBe(before);
  });

  it("does not build URLs from hostile externalIds", async () => {
    const f = await fake();
    serve(f, c);
    const ctx = ctxFor(await f.session());
    const before = f.requests.length;
    for (const evil of ["../../etc/passwd", "projects/x/../../y", "a b", "https://evil.example.com/x", `${c.externalId}?alt=media`, `${c.externalId}#frag`, `${c.externalId}/../other`]) {
      const obs = await driverOf(c).observe!(ctx, node(c.address), evil);
      expect(obs.presence, evil).toBe("unknown");
    }
    expect(f.requests.length).toBe(before);
  });

  it("stops when the abort signal has fired", async () => {
    const f = await fake();
    serve(f, c);
    const ac = new AbortController();
    const ctx = ctxFor(await f.session(), { signal: ac.signal });
    ac.abort();
    await expect(driverOf(c).observe!(ctx, node(c.address), c.externalId)).rejects.toBeDefined();
  });
});

describe.each(cases)("$name: verify", (c) => {
  it("passes when the object matches the desired spec (and, where serving matters, is healthy)", async () => {
    const f = await fake();
    serve(f, c);
    const d = driverOf(c);
    const ctx = ctxFor(await f.session());
    const obs = await d.observe!(ctx, node(c.address), c.externalId);
    const rt = d.runtime ? await d.runtime(ctx, node(c.address), c.externalId) : undefined;
    const v = await d.verify!(ctx, node(c.address), obs, rt);
    expect(v.simulated).toBe(false);
    expect(v.address).toBe(c.address);
    expect(v.checks.find((x) => x.id === "exists")!.passed).toBe(true);
    expect(v.checks.filter((x) => x.passed !== true), JSON.stringify(v.checks.filter((x) => x.passed !== true))).toEqual([]);
    expect(v.status).toBe("passed");
  });

  it("fails the specific check when the object drifted", async () => {
    const f = await fake();
    serve(f, c, { ...c.body, ...c.mutate.body });
    const d = driverOf(c);
    const ctx = ctxFor(await f.session());
    const obs = await d.observe!(ctx, node(c.address), c.externalId);
    const v = await d.verify!(ctx, node(c.address), obs);
    expect(v.status).toBe("failed");
    const failed = v.checks.filter((x) => x.passed === false).map((x) => x.id);
    expect(failed.some((id) => id.endsWith(c.mutate.failsAttr) || id === c.mutate.failsAttr)).toBe(true);
    const detail = v.checks.find((x) => x.passed === false)!.detail ?? "";
    expect(detail).not.toContain(ACCESS_TOKEN);
  });

  it("fails when the object is missing and is unknown (not passed) when it cannot be read", async () => {
    const d = driverOf(c);
    const f = await fake();
    f.get(c.get, { status: 404, json: { error: { status: "NOT_FOUND" } } });
    const ctx = ctxFor(await f.session());
    const missing = await d.verify!(ctx, node(c.address), await d.observe!(ctx, node(c.address), c.externalId));
    expect(missing.status).toBe("failed");
    expect(missing.checks[0]).toMatchObject({ id: "exists", passed: false });

    const g = await fake();
    g.get(c.get, { status: 403, json: { error: { status: "PERMISSION_DENIED" } } });
    const ctx2 = ctxFor(await g.session());
    const denied = await d.verify!(ctx2, node(c.address), await d.observe!(ctx2, node(c.address), c.externalId));
    expect(denied.status).toBe("unknown");
    expect(denied.checks[0].passed).toBe("unknown");
  });
});

describe.each(cases.filter((c) => c.list && driverOf(c).discover))("$name: discover", (c) => {
  it("lists candidates, marks Zenith-tagged ones, and never reports anything as managed", async () => {
    const f = await fake();
    f.get(c.list!.path, { json: { [c.list!.key]: [c.body, c.decoy, strip(c.body)].filter(Boolean) } });
    const d = driverOf(c);
    const ctx = ctxFor(await f.session());
    const found = await d.discover!(ctx);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const r of found) {
      expect(r).toMatchObject({ provider: "gcp", nativeType: d.nativeType, region: "asia-south1" });
      expect(Object.keys(r).sort()).toEqual(["attributes", "externalId", "kind", "name", "nativeType", "provider", "region", "zenithTagged"]);
    }
    expect(found.filter((r) => r.zenithTagged).length).toBe(found.length - 1);
    expect(f.requests.every((r) => r.method === "GET" || r.host.startsWith("sts.") || r.host.startsWith("iamcredentials."))).toBe(true);
    expect(JSON.stringify(found)).not.toContain(PLAIN_ENV_CANARY);
  });

  it("returns nothing (not a guess) when the list cannot be read", async () => {
    const f = await fake();
    f.get(c.list!.path, { status: 403, json: { error: { status: "PERMISSION_DENIED" } } });
    const ctx = ctxFor(await f.session());
    expect(await driverOf(c).discover!(ctx)).toEqual([]);
  });
});

describe("pagination is bounded", () => {
  it("stops after five pages and says so instead of looping forever", async () => {
    const f = await fake();
    let pages = 0;
    f.get(/^run\.googleapis\.com\/v2\/projects\/[^/]+\/locations\/[^/]+\/services$/, () => {
      pages++;
      return { json: { services: [{ name: `projects/acme-prod-123456/locations/asia-south1/services/s${pages}`, labels: { zenith_environment: "env_other" } }], nextPageToken: `t${pages}` } };
    });
    const ctx = ctxFor(await f.session());
    const d = gcpDrivers.find((x) => x.nativeType === "gcp:cloud_run_service")!;
    const obs: Observation = await d.observe!(ctx, node("service/web"));
    expect(pages).toBe(5);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/page bound/);
  });
});

describe("edge cases", () => {
  it("an observation without a zenith:environment tag cannot search by label", async () => {
    const f = await fake();
    const ctx = ctxFor(await f.session(), { tags: {} });
    const d = gcpDrivers.find((x) => x.nativeType === "gcp:cloud_run_service")!;
    const obs = await d.observe!(ctx, node("service/web"));
    expect(obs.presence).toBe("unknown");
    expect(f.requests.filter((r) => r.host === "run.googleapis.com")).toHaveLength(0);
  });

  it("drivers with no list (log bucket) need no externalId, and dns records read the covering zone", async () => {
    const f = await fake();
    const logCase = cases.find((x) => x.name === "log_bucket")!;
    serve(f, logCase);
    const ctx = ctxFor(await f.session());
    const log = gcpDrivers.find((x) => x.nativeType === "gcp:log_bucket")!;
    const obs = await log.observe!(ctx, node("log_group/web"));
    expect(obs.presence).toBe("present");
    expect(obs.attributes.retentionDays).toMatchObject({ state: "known", value: 30 });
  });

  it("dns record: present in the most specific covering zone, missing when the record or zone is absent, never across zones", async () => {
    const d = gcpDrivers.find((x) => x.nativeType === "gcp:dns_record_set")!;
    const n = node("dns_record/app.example.com");
    const zones = { managedZones: [{ name: "parent", dnsName: "com." }, { name: "zn-env1-example-com", dnsName: "example.com." }, { name: "unrelated", dnsName: "other.org." }] };
    const f = await fake();
    f.get("dns.googleapis.com/dns/v1/projects/acme-prod-123456/managedZones", { json: zones });
    f.get("dns.googleapis.com/dns/v1/projects/acme-prod-123456/managedZones/zn-env1-example-com/rrsets/app.example.com./A", { json: { name: "app.example.com.", type: "A", ttl: 300, rrdatas: ["34.1.1.1"] } });
    const ctx = ctxFor(await f.session());
    const obs = await d.observe!(ctx, n);
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe("projects/acme-prod-123456/managedZones/zn-env1-example-com/rrsets/app.example.com./A");
    expect(obs.attributes).toMatchObject({ type: { state: "known", value: "A" }, ttl: { state: "known", value: 300 } });
    expect(f.requests.some((r) => r.path.includes("managedZones/parent/"))).toBe(false);
    expect(JSON.stringify(obs)).not.toContain("34.1.1.1");
    const v = await d.verify!(ctx, n, obs);
    expect(v.status).toBe("passed");

    const g = await fake();
    g.get("dns.googleapis.com/dns/v1/projects/acme-prod-123456/managedZones", { json: zones });
    const ctx2 = ctxFor(await g.session());
    expect((await d.observe!(ctx2, n)).presence).toBe("missing"); // rrset 404 in the covering zone

    const h = await fake();
    h.get("dns.googleapis.com/dns/v1/projects/acme-prod-123456/managedZones", { json: { managedZones: [{ name: "unrelated", dnsName: "other.org." }] } });
    const ctx3 = ctxFor(await h.session());
    expect((await d.observe!(ctx3, n)).presence).toBe("missing");

    const i = await fake();
    i.get("dns.googleapis.com/dns/v1/projects/acme-prod-123456/managedZones", { status: 403, json: { error: { status: "PERMISSION_DENIED" } } });
    const ctx4 = ctxFor(await i.session());
    expect((await d.observe!(ctx4, n)).presence).toBe("inaccessible");
    expect((await d.observe!(ctx4, n, "projects/acme-prod-123456/managedZones/z/rrsets/evil.example.com./A")).presence).toBe("unknown");
  });

  it("public_http firewall rules are reported as not enforced by the VPC, not as a missing rule", async () => {
    const d = gcpDrivers.find((x) => x.nativeType === "gcp:firewall_rule")!;
    const f = await fake();
    const ctx = ctxFor(await f.session());
    const obs = await d.observe!(ctx, node("firewall/public"));
    expect(obs.presence).toBe("present");
    expect(obs.attributes.enforcedBy).toMatchObject({ state: "known", value: "none" });
    expect(f.requests.filter((r) => r.host.startsWith("compute."))).toHaveLength(0);
    expect((await d.verify!(ctx, node("firewall/public"), obs)).status).toBe("passed");
  });

  it("log groups: verify FAILS when the project retains less than requested instead of silently accepting it", async () => {
    const d = gcpDrivers.find((x) => x.nativeType === "gcp:log_bucket")!;
    const logCase = cases.find((x) => x.name === "log_bucket")!;
    const f = await fake();
    serve(f, logCase, { ...logCase.body, retentionDays: 7 });
    const ctx = ctxFor(await f.session());
    const obs = await d.observe!(ctx, node("log_group/web"));
    const v = await d.verify!(ctx, node("log_group/web"), obs);
    expect(v.status).toBe("failed");
    expect(v.checks.find((x) => x.id === "retention")).toMatchObject({ passed: false });
    expect(d.expectedAttributes!(node("log_group/web"))).toEqual({});
  });
});
