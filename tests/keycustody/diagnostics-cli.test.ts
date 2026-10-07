/**
 * PROD-OPS-05: operator diagnostics and the key-custody CLI. No database: durable records are passed in, and the CLI
 * runs with `--no-db`. Keys are generated at runtime; the assertions are that output names ids, purposes, roles,
 * ages and counts and never material.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildKeyReport, CODEC_ENCODING, CODEC_KEY_ID_METADATA, inspectTemporalMtls, inspectTemporalPayloads, renderKeyReport, reportExitCode, summarizePayloadFindings } from "@/lib/keycustody/diagnostics";
import { KeyRing } from "@/lib/keycustody/registry";
import type { StoredKey } from "@/lib/keycustody/store";
import { TEMPORAL_PAYLOAD_ENCODING, TEMPORAL_PAYLOAD_KEY_ID, TemporalPayloadCodec } from "@/lib/workflows/codec";
import { keyCustodyMain } from "../../scripts/key-custody";

const hex = (): string => randomBytes(32).toString("hex");
const DAY = 86_400_000;

describe("codec constants stay in step with the codec", () => {
  it("the inspector reads the exact envelope names the codec writes", () => {
    expect(CODEC_ENCODING).toBe(TEMPORAL_PAYLOAD_ENCODING);
    expect(CODEC_KEY_ID_METADATA).toBe(TEMPORAL_PAYLOAD_KEY_ID);
  });
});

describe("key report: ages, retirement and findings", () => {
  const now = new Date("2026-10-07T00:00:00.000Z");
  const cur = hex(), old1 = hex(), old2 = hex();
  const env = { ZENITH_SECRET_KEY: cur, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([old1, old2]) };
  const ring = KeyRing.fromEnv(env, { purposes: ["enc:vault"] });
  const [now0, prev1, prev2] = ring.descriptors();
  const stored = (key: typeof now0, over: Partial<StoredKey>): StoredKey => ({
    purpose: key.purpose, keyId: key.keyId, role: key.role, source: key.source,
    firstSeenAt: new Date(now.getTime() - 40 * DAY).toISOString(), lastSeenAt: now.toISOString(), retireAfter: null, retiredAt: null, retiredBy: null, ...over,
  });

  it("classifies each key and reports age in days and the findings an operator must act on", () => {
    const report = buildKeyReport(ring, [
      stored(now0, {}),
      stored(prev1, { retireAfter: new Date(now.getTime() - DAY).toISOString() }),
      stored(prev2, { retireAfter: new Date(now.getTime() + 30 * DAY).toISOString() }),
    ], now);
    const by = new Map(report.entries.map((e) => [e.keyId, e]));
    expect(by.get(now0.keyId)).toMatchObject({ retirement: "current", ageDays: 40 });
    expect(by.get(prev1.keyId)).toMatchObject({ retirement: "overdue" });
    expect(by.get(prev2.keyId)).toMatchObject({ retirement: "scheduled" });
    expect(report.findings.some((f) => f.includes(prev1.keyId) && f.includes("past its retirement date"))).toBe(true);
    expect(report.durable).toBe(true);
    const vault = report.purposes.find((p) => p.purpose === "enc:vault")!;
    expect(vault).toMatchObject({ configured: true, currentKeyId: now0.keyId, decryptOnly: 2, verifyOnly: 0 });
    expect(report.purposes.find((p) => p.purpose === "enc:backup")).toMatchObject({ configured: false });
  });

  it("a retired key is shown as retired and an unscheduled one is called out; without durable records ages are unknown", () => {
    const withRetired = buildKeyReport(ring, [stored(now0, {}), stored(prev1, { retiredAt: now.toISOString(), retiredBy: "ops" }), stored(prev2, {})], now);
    expect(withRetired.entries.find((e) => e.keyId === prev1.keyId)?.retirement).toBe("retired");
    expect(withRetired.findings.some((f) => f.includes(prev2.keyId) && f.includes("no retirement date"))).toBe(true);
    const none = buildKeyReport(ring, undefined, now);
    expect(none.durable).toBe(false);
    expect(none.entries.every((e) => e.ageDays === undefined)).toBe(true);
    expect(none.findings).toEqual([]);
  });

  it("the rendered report and JSON carry ids and roles but none of the key material, and exit codes follow separation errors", () => {
    const text = [...renderKeyReport(buildKeyReport(ring, undefined, now)), JSON.stringify(buildKeyReport(ring, undefined, now))].join("\n");
    for (const secret of [cur, old1, old2]) expect(text).not.toContain(secret);
    expect(text).toContain("enc:vault");
    expect(text).toContain("decrypt_only");
    expect(reportExitCode(buildKeyReport(KeyRing.fromEnv({ ZENITH_SECRET_KEY: cur, ZENITH_BACKUP_KEY: cur }), undefined, now))).toBe(1);
    expect(reportExitCode(buildKeyReport(KeyRing.fromEnv({ ZENITH_SECRET_KEY: cur, ZENITH_BACKUP_KEY: hex(), ZENITH_PLAN_ARTIFACT_KEY: hex(), ZENITH_RUNNER_RESULT_KEY: randomBytes(32).toString("base64url") }), undefined, now))).toBe(0);
  });
});

describe("Temporal mTLS facts", () => {
  it("reports an unreadable certificate as such and never reads the key file", () => {
    const reads: string[] = [];
    const entry = inspectTemporalMtls({ ZENITH_TEMPORAL_TLS_CERT_FILE: "client.pem", ZENITH_TEMPORAL_TLS_KEY_FILE: "client.key" }, (file) => { reads.push(file); return Buffer.from("not a certificate"); });
    expect(entry).toMatchObject({ purpose: "tls:temporal-mtls", keyId: "unreadable" });
    expect(reads).toEqual(["client.pem"]);
    expect(inspectTemporalMtls({})).toBeUndefined();
  });
});

describe("Temporal payload inspection without decrypting", () => {
  const b64 = (value: string | Uint8Array): string => Buffer.from(value).toString("base64");
  const toJson = (p: { metadata?: Record<string, Uint8Array> | null; data?: Uint8Array | null }) => ({
    metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, b64(v)])),
    data: b64(p.data ?? new Uint8Array()),
  });
  it("classifies payloads by the key id in their metadata: current, decrypt-only, unavailable, legacy and invalid", async () => {
    const cur = hex(), old = hex(), gone = hex();
    const plain = { metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from("{}") };
    const [encCurrent] = await new TemporalPayloadCodec(cur).encode([plain]);
    const [encOld] = await new TemporalPayloadCodec(old).encode([plain]);
    const [encGone] = await new TemporalPayloadCodec(gone).encode([plain]);
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: cur, ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS: JSON.stringify([old]) }, { purposes: ["enc:temporal-payload"] });
    const history = { events: [
      { attributes: { input: { payloads: [toJson(encCurrent), toJson(encOld)] } } },
      { attributes: { result: { payloads: [toJson(encGone), toJson(plain)] } } },
      { attributes: { input: { payloads: [{ metadata: { encoding: b64(TEMPORAL_PAYLOAD_ENCODING) }, data: b64("x") }] } } },
    ] };
    const findings = inspectTemporalPayloads(ring, history);
    const summary = summarizePayloadFindings(findings);
    expect(summary.total).toBe(5);
    expect(summary.byStatus).toEqual({ legacy_plaintext: 1, current_key: 1, decrypt_only_key: 1, key_unavailable: 1, invalid_envelope: 1 });
    expect(Object.keys(summary.byKeyId).sort()).toEqual([new TemporalPayloadCodec(cur).keyId, new TemporalPayloadCodec(old).keyId, new TemporalPayloadCodec(gone).keyId].sort());
    expect(JSON.stringify(findings)).not.toContain(cur);
  });
});

describe("the key-custody CLI", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-key-custody-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const run = async (args: string[], env: Record<string, string | undefined>) => {
    const out: string[] = [], err: string[] = [];
    const exit = await keyCustodyMain(args, (l) => out.push(l), (l) => err.push(l), env);
    return { exit, out: out.join("\n"), err: err.join("\n") };
  };

  it("diagnose --no-db prints ids, purposes, roles and never key material", async () => {
    const cur = hex(), old = hex(), plan = hex();
    const env = { ZENITH_SECRET_KEY: cur, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([old]), ZENITH_PLAN_ARTIFACT_KEY: plan, ZENITH_RUNNER_RESULT_KEY: randomBytes(32).toString("base64url"), ZENITH_BACKUP_KEY: hex() };
    const r = await run(["diagnose", "--no-db"], env);
    expect(r.exit).toBe(0);
    for (const purpose of ["enc:vault", "enc:plan-artifacts", "enc:results", "enc:backup", "enc:temporal-payload"]) expect(r.out).toContain(purpose);
    for (const secret of [cur, old, plan, env.ZENITH_RUNNER_RESULT_KEY, env.ZENITH_BACKUP_KEY]) expect(`${r.out}\n${r.err}`).not.toContain(secret);
    const json = await run(["diagnose", "--no-db", "--json"], env);
    expect(JSON.parse(json.out)).toMatchObject({ durable: false, purposes: expect.any(Array) });
  });

  it("diagnose exits 1 when purposes share a key", async () => {
    const shared = hex();
    const r = await run(["diagnose", "--no-db"], { ZENITH_SECRET_KEY: shared, ZENITH_PLAN_ARTIFACT_KEY: shared });
    expect(r.exit).toBe(1);
    expect(r.out).toContain("key_reused_across_purposes");
    expect(r.out).not.toContain(shared);
  });

  it("usage errors exit 2 and unknown or repeated flags are refused", async () => {
    expect((await run([], {})).exit).toBe(2);
    expect((await run(["nope"], {})).exit).toBe(2);
    expect((await run(["diagnose", "--no-db", "--no-db"], {})).exit).toBe(2);
    expect((await run(["retire", "--purpose", "enc:vault"], {})).exit).toBe(2);
    expect((await run(["retire-after", "--purpose", "enc:bogus", "--key-id", "x", "--date", "none"], {})).exit).toBe(2);
    expect((await run(["rewrap", "--workspace", "bad workspace"], {})).exit).toBe(2);
    expect((await run(["codec"], {})).exit).toBe(2);
  });

  it("a database command without a configured Postgres store fails with fixed guidance, naming no configuration", async () => {
    const r = await run(["rewrap-status"], { ZENITH_SECRET_KEY: hex() });
    expect(r.exit).toBe(1);
    expect(r.err).toContain("The key custody command failed");
  });

  it("codec reports which key id a history needs, exit 1 when a key is missing, and never prints plaintext", async () => {
    const cur = hex(), gone = hex();
    const secretText = `payload-${randomBytes(6).toString("hex")}`;
    const plain = { metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from(JSON.stringify({ secretText })) };
    const [a] = await new TemporalPayloadCodec(cur).encode([plain]);
    const [b] = await new TemporalPayloadCodec(gone).encode([plain]);
    const enc = (p: { metadata?: Record<string, Uint8Array> | null; data?: Uint8Array | null }) => ({
      metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v).toString("base64")])),
      data: Buffer.from(p.data ?? new Uint8Array()).toString("base64"),
    });
    const file = path.join(dir, "history.json");
    fs.writeFileSync(file, JSON.stringify({ events: [{ payloads: [enc(a)] }] }));
    const ok = await run(["codec", "--file", file, "--verify"], { ZENITH_SECRET_KEY: cur });
    expect(ok.exit).toBe(0);
    expect(ok.out).toContain("current_key: 1");
    expect(ok.out).toContain("1 ok, 0 failed");
    fs.writeFileSync(file, JSON.stringify({ events: [{ payloads: [enc(a), enc(b)] }] }));
    const missing = await run(["codec", "--file", file, "--verify", "--json"], { ZENITH_SECRET_KEY: cur });
    expect(missing.exit).toBe(1);
    expect(JSON.parse(missing.out)).toMatchObject({ total: 2, byStatus: { current_key: 1, key_unavailable: 1 }, verified: { ok: 1, failed: 1 } });
    for (const text of [ok.out, missing.out, ok.err, missing.err]) { expect(text).not.toContain(secretText); expect(text).not.toContain(cur); }
  });
});
