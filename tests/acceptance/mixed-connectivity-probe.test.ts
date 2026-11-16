/**
 * PROD-MIX-05: the protected-endpoint prober, CONTRACT LEVEL. The probe I/O is a model of an endpoint (resolver and TLS
 * server); it proves the probe's own decisions (what counts as passed, failed, skipped, not applicable), not any real endpoint.
 * The real I/O is `nodeProbeIo`, exercised only by tests/live/mixed-connectivity.live.test.ts (gated, deferred).
 */
import { describe, expect, it } from "vitest";
import { runConnectivityProbes, type ClientMaterial, type ProbeEndpoint, type ProbeIo, type TlsAttempt, type TlsRequest } from "../../scripts/acceptance/mixed/connectivity-probe";

const HEX_A = "a".repeat(64);
const HOST = "db.mixed.example.com";
const ep: ProbeEndpoint = { id: "ep1", dataClass: "database", host: HOST, port: 5432, dnsTargets: ["20.20.20.10"], tlsMinVersion: "1.3", serverNames: [HOST], serverSpkiSha256: HEX_A, allowlist: ["34.1.1.1"] };
const client: ClientMaterial = { cert: Buffer.from("not a real certificate"), key: Buffer.from("not a real key") };

interface Model {
  resolves?: string[];
  resolveError?: boolean;
  /** what the modelled endpoint does for an allowlisted caller with a certificate */
  served?: Partial<Extract<TlsAttempt, { outcome: "established" }>>;
  requireClientCert?: boolean;
  acceptsOldTls?: boolean;
  /** the modelled endpoint admits only allowlisted callers; the probe says which kind of caller it is */
  callerAllowlisted?: boolean;
  bareTimesOut?: boolean;
  localCannotOfferOldTls?: boolean;
}

function model(over: Model = {}): { io: ProbeIo; requests: TlsRequest[] } {
  const m: Required<Pick<Model, "requireClientCert" | "acceptsOldTls" | "callerAllowlisted">> & Model = { requireClientCert: true, acceptsOldTls: false, callerAllowlisted: true, ...over };
  const requests: TlsRequest[] = [];
  const established = (): TlsAttempt => ({ outcome: "established", protocol: "TLSv1.3", spkiSha256: HEX_A, names: [HOST], authorized: true, answered: true, ...m.served });
  const io: ProbeIo = {
    async resolve() { if (m.resolveError) throw new Error("resolver down"); return m.resolves ?? ["20.20.20.10"]; },
    async tlsConnect(request) {
      requests.push(request);
      if (!m.callerAllowlisted) return { outcome: "refused", reason: "timeout" };
      if (request.maxVersion === "TLSv1.1") return m.localCannotOfferOldTls ? { outcome: "refused", reason: "local_unsupported" } : m.acceptsOldTls ? { ...established(), protocol: "TLSv1.1" } : { outcome: "refused", reason: "handshake_failed" };
      if (!request.client) return m.bareTimesOut ? { outcome: "refused", reason: "timeout" } : m.requireClientCert ? { outcome: "refused", reason: "closed_after_handshake" } : established();
      return established();
    },
  };
  return { io, requests };
}

const status = (v: Awaited<ReturnType<typeof runConnectivityProbes>>, probe: string) => v.results.find((r) => r.probe === probe)!;

describe("from an allowlisted machine", () => {
  it("passes every probe that applies and says what it could not check", async () => {
    const v = await runConnectivityProbes({ endpoints: [ep], io: model().io, client });
    expect(v.results.filter((r) => r.applicable).map((r) => [r.probe, r.status])).toEqual([["dns", "passed"], ["tls_pin", "passed"], ["mtls_required", "passed"], ["tls_floor", "passed"]]);
    expect(v.ok).toBe(true);
    expect(v.complete).toBe(true);
    expect(v.vantage).toBe("allowlisted_or_unknown");
    expect(v.notChecked).toEqual(["allowlist_denial"]);
    expect(status(v, "allowlist_denial")).toMatchObject({ status: "skipped", applicable: false });
    expect(v.limits.join(" ")).toContain("one run from each vantage point");
  });

  it("fails on a stray DNS answer, an unresolvable name is inconclusive and never a pass", async () => {
    const stray = await runConnectivityProbes({ endpoints: [ep], io: model({ resolves: ["20.20.20.10", "6.6.6.6"] }).io, client });
    expect(status(stray, "dns")).toMatchObject({ status: "failed" });
    expect(stray.ok).toBe(false);
    expect(status(await runConnectivityProbes({ endpoints: [ep], io: model({ resolves: [] }).io, client }), "dns").status).toBe("failed");
    const down = await runConnectivityProbes({ endpoints: [ep], io: model({ resolveError: true }).io, client });
    expect(status(down, "dns").status).toBe("inconclusive");
    expect(down.ok).toBe(false);
    expect(down.complete).toBe(false);
  });

  it("fails a wrong pin, an untrusted chain, a missing host name and a protocol below the approved minimum", async () => {
    for (const served of [{ spkiSha256: "f".repeat(64) }, { authorized: false }, { names: ["other.example.com"] }, { protocol: "TLSv1.2" }]) {
      const v = await runConnectivityProbes({ endpoints: [ep], io: model({ served }).io, client });
      expect(status(v, "tls_pin").status, JSON.stringify(served)).toBe("failed");
      expect(v.ok).toBe(false);
    }
  });

  it("fails when the endpoint serves a caller without a client certificate", async () => {
    const v = await runConnectivityProbes({ endpoints: [ep], io: model({ requireClientCert: false }).io, client });
    expect(status(v, "mtls_required")).toMatchObject({ status: "failed" });
    expect(v.ok).toBe(false);
  });

  it("does not count a timeout as proof that a client certificate is required", async () => {
    const v = await runConnectivityProbes({ endpoints: [ep], io: model({ bareTimesOut: true }).io, client });
    expect(status(v, "mtls_required").status).toBe("inconclusive");
    expect(v.complete).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("fails an endpoint that still speaks TLS 1.1 and calls a machine that cannot offer it inconclusive", async () => {
    expect(status(await runConnectivityProbes({ endpoints: [ep], io: model({ acceptsOldTls: true }).io, client }), "tls_floor").status).toBe("failed");
    const local = await runConnectivityProbes({ endpoints: [ep], io: model({ localCannotOfferOldTls: true }).io, client });
    expect(status(local, "tls_floor").status).toBe("inconclusive");
    expect(local.ok).toBe(false);
  });

  it("skips the certificate-dependent probes without a client certificate file and is then not ok", async () => {
    const v = await runConnectivityProbes({ endpoints: [ep], io: model().io });
    expect(status(v, "tls_pin").status).toBe("skipped");
    expect(v.complete).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("sends the approved minimum version with the client certificate and no certificate for the mutual-TLS probe", async () => {
    const m = model();
    await runConnectivityProbes({ endpoints: [ep], io: m.io, client });
    const withCert = m.requests.find((r) => r.client && !r.maxVersion)!;
    expect(withCert).toMatchObject({ host: HOST, servername: HOST, minVersion: "TLSv1.3" });
    expect(m.requests.some((r) => !r.client && !r.maxVersion)).toBe(true);
    expect(m.requests.some((r) => r.maxVersion === "TLSv1.1")).toBe(true);
  });
});

describe("from a machine outside the allowlist", () => {
  it("shows the allowlist refusing a valid certificate and reports the rest as not applicable, not passed", async () => {
    const v = await runConnectivityProbes({ endpoints: [ep], io: model({ callerAllowlisted: false }).io, client, sourceOutsideAllowlist: true });
    expect(status(v, "allowlist_denial")).toMatchObject({ status: "passed", applicable: true });
    for (const probe of ["tls_pin", "mtls_required", "tls_floor"]) expect(status(v, probe)).toMatchObject({ status: "skipped", applicable: false });
    expect(v.ok).toBe(true);
    expect(v.vantage).toBe("outside_allowlist");
    expect(v.notChecked.sort()).toEqual(["mtls_required", "tls_floor", "tls_pin"]);
  });

  it("fails when an outside caller with a valid certificate is served", async () => {
    const v = await runConnectivityProbes({ endpoints: [ep], io: model({ callerAllowlisted: true }).io, client, sourceOutsideAllowlist: true });
    expect(status(v, "allowlist_denial")).toMatchObject({ status: "failed" });
    expect(v.ok).toBe(false);
  });

  it("needs a valid certificate to show the denial", async () => {
    const v = await runConnectivityProbes({ endpoints: [ep], io: model({ callerAllowlisted: false }).io, sourceOutsideAllowlist: true });
    expect(status(v, "allowlist_denial").status).toBe("skipped");
    expect(v.ok).toBe(false);
  });
});

describe("never a pass by default", () => {
  it("an empty endpoint list is not ok", async () => {
    expect((await runConnectivityProbes({ endpoints: [], io: model().io, client })).ok).toBe(false);
  });

  it("one failing endpoint fails the whole verdict", async () => {
    const other: ProbeEndpoint = { ...ep, id: "ep2", host: "web.mixed.example.com", serverNames: ["web.mixed.example.com"] };
    const io = model().io;
    const v = await runConnectivityProbes({ endpoints: [ep, other], io: { ...io, resolve: async (host) => (host === other.host ? ["6.6.6.6"] : ["20.20.20.10"]) }, client });
    expect([...new Set(v.results.filter((r) => r.status === "failed").map((r) => r.endpointId))]).toEqual(["ep2"]);
    expect(v.ok).toBe(false);
  });
});
