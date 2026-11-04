/** Bounded local file loading and mocked option shapes; no TLS handshake is claimed. */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectionOptionsFor, describeTemporalConfig, MAX_TEMPORAL_TLS_FILE_BYTES,
  temporalConfigFromEnv, TemporalConfigError,
} from "@/lib/workflows/config";
import { executionWorkerConfigFromEnv } from "../../workers/execution/config";

// Mutable export wrapper for spies; operations still use the real local filesystem.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));

const CA = "-----BEGIN CERTIFICATE-----\nsynthetic-ca-canary\n-----END CERTIFICATE-----\n";
const CERT = "-----BEGIN CERTIFICATE-----\nsynthetic-client-canary\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nsynthetic-key-canary\n-----END PRIVATE KEY-----\n";
const dirs: string[] = [];
function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-mtls-config-"));
  dirs.push(dir);
  const ca = path.join(dir, "ca.pem"), cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem");
  fs.writeFileSync(ca, CA); fs.writeFileSync(cert, CERT); fs.writeFileSync(key, KEY);
  return { dir, ca, cert, key, env: {
    ZENITH_TEMPORAL_TLS_CA_FILE: ca, ZENITH_TEMPORAL_TLS_CERT_FILE: cert, ZENITH_TEMPORAL_TLS_KEY_FILE: key,
    ZENITH_TEMPORAL_TLS_SERVER_NAME: "temporal.internal",
  } };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw new Error("Unexpected test directory");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Temporal custom TLS configuration", () => {
  it.each([
    ["CA only", ["ZENITH_TEMPORAL_TLS_CA_FILE"]],
    ["client pair only", ["ZENITH_TEMPORAL_TLS_CERT_FILE", "ZENITH_TEMPORAL_TLS_KEY_FILE"]],
    ["server name only", ["ZENITH_TEMPORAL_TLS_SERVER_NAME"]],
    ["all settings", ["ZENITH_TEMPORAL_TLS_CA_FILE", "ZENITH_TEMPORAL_TLS_CERT_FILE", "ZENITH_TEMPORAL_TLS_KEY_FILE", "ZENITH_TEMPORAL_TLS_SERVER_NAME"]],
  ])("%s forces TLS even when explicitly disabled", (_name, fields) => {
    const fixture = files();
    const env = Object.fromEntries(fields.map((field) => [field, fixture.env[field as keyof typeof fixture.env]]));
    const config = temporalConfigFromEnv({ ...env, ZENITH_TEMPORAL_TLS: "false" });
    expect(config.tls).toBe(true);
    const tls = connectionOptionsFor(config).tls;
    expect(typeof tls).toBe("object");
    if (!tls || typeof tls !== "object") return;
    expect(tls.serverRootCACertificate).toEqual(fields.includes("ZENITH_TEMPORAL_TLS_CA_FILE") ? Buffer.from(CA) : undefined);
    expect(tls.clientCertPair).toEqual(fields.includes("ZENITH_TEMPORAL_TLS_CERT_FILE") ? { crt: Buffer.from(CERT), key: Buffer.from(KEY) } : undefined);
    expect(tls.serverNameOverride).toBe(fields.includes("ZENITH_TEMPORAL_TLS_SERVER_NAME") ? "temporal.internal" : undefined);
  });

  it("passes custom TLS with API-key regional metadata and through worker configuration", () => {
    const fixture = files();
    const env = { ...fixture.env, ZENITH_TEMPORAL_API_KEY: "synthetic-api-key", ZENITH_TEMPORAL_ADDRESS: "us-east-1.aws.api.temporal.io:7233", ZENITH_TEMPORAL_NAMESPACE: "ns.acct" };
    const config = temporalConfigFromEnv(env);
    expect(connectionOptionsFor(config)).toEqual({ address: env.ZENITH_TEMPORAL_ADDRESS,
      apiKey: env.ZENITH_TEMPORAL_API_KEY, metadata: { "temporal-namespace": "ns.acct" },
      tls: { serverRootCACertificate: Buffer.from(CA), clientCertPair: { crt: Buffer.from(CERT), key: Buffer.from(KEY) }, serverNameOverride: "temporal.internal" },
    });
    expect(connectionOptionsFor(executionWorkerConfigFromEnv(env).temporal)).toEqual(connectionOptionsFor(config));
  });

  it.each(["ZENITH_TEMPORAL_TLS_CERT_FILE", "ZENITH_TEMPORAL_TLS_KEY_FILE"])("rejects an unpaired %s before reading files", (field) => {
    const open = vi.spyOn(fs, "openSync");
    expect(() => temporalConfigFromEnv({ [field]: "synthetic-private-path", ZENITH_TEMPORAL_TLS_CA_FILE: "missing-ca" })).toThrow(/must be set together/);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["https://temporal.internal", "temporal.internal:7233", "temporal/internal", "temporal internal", "*.internal", "-bad.internal", "bad_.internal", "a".repeat(64) + ".internal", "a.".repeat(127) + "a"])("rejects invalid server name #%# without echoing values or reading files", (serverName) => {
    const open = vi.spyOn(fs, "openSync");
    expect(() => temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS_SERVER_NAME: serverName, ZENITH_TEMPORAL_TLS_CA_FILE: "private-path" })).toThrow(TemporalConfigError);
    try { temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS_SERVER_NAME: serverName }); }
    catch (err) { expect((err as Error).message).not.toContain(serverName); }
    expect(open).not.toHaveBeenCalled();
  });

  it("treats whitespace TLS values as unset", () => {
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS_CA_FILE: " ", ZENITH_TEMPORAL_TLS_CERT_FILE: "", ZENITH_TEMPORAL_TLS_KEY_FILE: "\t", ZENITH_TEMPORAL_TLS_SERVER_NAME: "\n" })).toEqual(temporalConfigFromEnv({}));
  });

  it("describes only presence without PEM, bytes, filenames or the override value", () => {
    const fixture = files();
    const description = describeTemporalConfig(temporalConfigFromEnv({ ...fixture.env, ZENITH_TEMPORAL_API_KEY: "synthetic-api-key" }));
    expect(description).toEqual({ address: "localhost:7233", namespace: "default", tls: true, apiKey: "set", tlsCa: "set", tlsCert: "set", tlsKey: "set", tlsServerName: "set" });
    const text = JSON.stringify(description);
    expect([CA, CERT, KEY, fixture.dir, "temporal.internal", "synthetic-api-key"].some((value) => text.includes(value))).toBe(false);
    expect(text).not.toMatch(/BEGIN|synthetic-|\.pem/);
    expect(describeTemporalConfig(temporalConfigFromEnv({}))).toMatchObject({ tlsCa: "unset", tlsCert: "unset", tlsKey: "unset", tlsServerName: "unset" });
  });

  it("reads each absolute path once and keeps its startup snapshot after replacement/deletion", () => {
    const fixture = files();
    const open = vi.spyOn(fs, "openSync");
    const first = temporalConfigFromEnv(fixture.env);
    fs.writeFileSync(fixture.ca, "replacement"); fs.rmSync(fixture.cert); fs.rmSync(fixture.key);
    open.mockClear();
    const second = temporalConfigFromEnv({ ...fixture.env, ZENITH_TEMPORAL_TLS_CA_FILE: path.join(fixture.dir, ".", "ca.pem") });
    expect(second.tlsOptions).toEqual(first.tlsOptions);
    connectionOptionsFor(second); describeTemporalConfig(second);
    expect(open).not.toHaveBeenCalled();
    const ca = first.tlsOptions!.serverRootCACertificate!;
    ca.fill(0);
    expect(temporalConfigFromEnv(fixture.env).tlsOptions!.serverRootCACertificate).toEqual(Buffer.from(CA));
  });

  it.each(["ZENITH_TEMPORAL_TLS_CA_FILE", "ZENITH_TEMPORAL_TLS_CERT_FILE", "ZENITH_TEMPORAL_TLS_KEY_FILE"])("sanitizes unreadable %s errors", (field) => {
    const fixture = files();
    const privatePath = path.join(fixture.dir, "synthetic-secret-path.pem");
    try {
      temporalConfigFromEnv({ ...fixture.env, [field]: privatePath });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TemporalConfigError);
      expect((err as Error).message).toContain(field);
      expect((err as Error).message).not.toContain(privatePath);
      expect(err).not.toHaveProperty("cause");
    }
  });

  it.each(["directory", "empty", "blank", "oversized"])("rejects a %s file and closes its descriptor", (kind) => {
    const fixture = files();
    const close = vi.spyOn(fs, "closeSync");
    const read = vi.spyOn(fs, "readSync");
    if (kind === "empty") fs.writeFileSync(fixture.ca, "");
    if (kind === "blank") fs.writeFileSync(fixture.ca, " \n\t");
    if (kind === "oversized") fs.writeFileSync(fixture.ca, Buffer.alloc(MAX_TEMPORAL_TLS_FILE_BYTES + 1, 120));
    const file = kind === "directory" ? fixture.dir : fixture.ca;
    close.mockClear();
    expect(() => temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS_CA_FILE: file })).toThrow(TemporalConfigError);
    // Windows can refuse opening a directory before there is a descriptor.
    if (kind !== "directory") expect(close).toHaveBeenCalledOnce();
    if (kind === "oversized") expect(read).not.toHaveBeenCalled();
  });

  it("accepts exactly the size bound", () => {
    const fixture = files();
    fs.writeFileSync(fixture.ca, Buffer.alloc(MAX_TEMPORAL_TLS_FILE_BYTES, 120));
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS_CA_FILE: fixture.ca }).tlsOptions!.serverRootCACertificate).toHaveLength(MAX_TEMPORAL_TLS_FILE_BYTES);
  });

  it("bounds reads if the file grows after fstat", () => {
    const fixture = files();
    fs.writeFileSync(fixture.ca, Buffer.alloc(MAX_TEMPORAL_TLS_FILE_BYTES + 10, 120));
    const stat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => Object.assign(stat(fd), { size: 1 })) as typeof fs.fstatSync);
    const read = vi.spyOn(fs, "readSync");
    expect(() => temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS_CA_FILE: fixture.ca })).toThrow(TemporalConfigError);
    expect(read.mock.results.reduce((total, result) => total + Number(result.value), 0)).toBe(MAX_TEMPORAL_TLS_FILE_BYTES + 1);
  });

  it("never echoes credential-shaped invalid address input", () => {
    expect(() => temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: KEY, ZENITH_TEMPORAL_API_KEY: KEY })).toThrow("ZENITH_TEMPORAL_ADDRESS must be host:port");
  });
});
