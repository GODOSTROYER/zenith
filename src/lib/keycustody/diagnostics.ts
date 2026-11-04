/**
 * Operator diagnostics for key custody (PROD-OPS-05). Everything here is safe to print: key ids (purpose-bound,
 * non-secret), purposes, roles, source variable NAMES, ages, retirement state, certificate fingerprints and
 * expiry. No function in this file receives or returns key material; the Temporal payload inspector reads only
 * the plaintext envelope metadata (encoding and key id) that is written beside every ciphertext.
 */
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { KeyDescriptor, KeyRing, KeyViolation } from "./registry";
import { KEY_PURPOSES, PURPOSE_SPECS, type KeyPurpose } from "./purposes";
import type { StoredKey } from "./store";

export type RetirementState = "current" | "unscheduled" | "scheduled" | "overdue" | "retired";

export interface KeyReportEntry extends KeyDescriptor {
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** whole days since first seen; absent when no durable record exists yet */
  ageDays?: number;
  retireAfter?: string;
  retiredAt?: string;
  retirement: RetirementState;
}

export interface PurposeSummary {
  purpose: KeyPurpose;
  protects: string;
  configured: boolean;
  currentKeyId?: string;
  decryptOnly: number;
  verifyOnly: number;
  configurationError?: string;
}

export interface KeyReport {
  generatedAt: string;
  entries: KeyReportEntry[];
  purposes: PurposeSummary[];
  violations: KeyViolation[];
  /** operator-readable findings: overdue retirements, unscheduled historical keys, expiring certificates */
  findings: string[];
  /** false when a durable key record was not available (ages and retirement dates are then unknown) */
  durable: boolean;
}

const DAY = 86_400_000;

export function buildKeyReport(ring: KeyRing, stored: readonly StoredKey[] | undefined, now: Date = new Date(), extra: readonly KeyReportEntry[] = []): KeyReport {
  const byKey = new Map((stored ?? []).map((s) => [`${s.purpose}|${s.keyId}`, s]));
  const findings: string[] = [];
  const entries: KeyReportEntry[] = [...ring.descriptors().map((d): KeyReportEntry => {
    const record = byKey.get(`${d.purpose}|${d.keyId}`);
    const retireAfter = record?.retireAfter ?? undefined;
    const retiredAt = record?.retiredAt ?? undefined;
    let retirement: RetirementState;
    if (d.role === "current") retirement = "current";
    else if (retiredAt) retirement = "retired";
    else if (!retireAfter) retirement = "unscheduled";
    else retirement = Date.parse(retireAfter) <= now.getTime() ? "overdue" : "scheduled";
    if (retirement === "overdue") findings.push(`${d.purpose} key ${d.keyId} is past its retirement date and is still configured (${d.role.replace("_", "-")}).`);
    if (retirement === "unscheduled" && stored !== undefined) findings.push(`${d.purpose} key ${d.keyId} is ${d.role.replace("_", "-")} with no retirement date; schedule one.`);
    return {
      ...d,
      ...(record ? { firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt, ageDays: Math.max(0, Math.floor((now.getTime() - Date.parse(record.firstSeenAt)) / DAY)) } : {}),
      ...(retireAfter ? { retireAfter } : {}),
      ...(retiredAt ? { retiredAt } : {}),
      retirement,
    };
  }), ...extra];
  for (const e of extra) {
    if (e.notAfter === undefined) continue;
    const left = Date.parse(e.notAfter) - now.getTime();
    if (left <= 0) findings.push(`${e.purpose} certificate ${e.keyId} has expired.`);
    else if (left < 30 * DAY) findings.push(`${e.purpose} certificate ${e.keyId} expires in ${Math.floor(left / DAY)} days.`);
  }
  const errors = new Map(ring.configurationErrors().map((e) => [e.purpose, e.message]));
  const purposes = KEY_PURPOSES.map((purpose): PurposeSummary => {
    const own = entries.filter((e) => e.purpose === purpose);
    return {
      purpose,
      protects: PURPOSE_SPECS[purpose].protects,
      configured: own.length > 0,
      currentKeyId: own.find((e) => e.role === "current")?.keyId,
      decryptOnly: own.filter((e) => e.role === "decrypt_only").length,
      verifyOnly: own.filter((e) => e.role === "verify_only").length,
      ...(errors.has(purpose) ? { configurationError: errors.get(purpose) } : {}),
    };
  });
  return { generatedAt: now.toISOString(), entries, purposes, violations: ring.violations(), findings, durable: stored !== undefined };
}

/** Plain-text rendering for terminals. Same safety as the structure it renders. */
export function renderKeyReport(report: KeyReport): string[] {
  const lines = [`Key custody report (${report.generatedAt})${report.durable ? "" : " - no durable key records: ages and retirement dates are unknown"}`, ""];
  for (const p of report.purposes) {
    lines.push(`${p.purpose}  ${p.configured ? "configured" : "not configured"}${p.currentKeyId ? `  current=${p.currentKeyId}` : ""}  decrypt-only=${p.decryptOnly}  verify-only=${p.verifyOnly}`);
    if (p.configurationError) lines.push(`  ERROR ${p.configurationError}`);
    for (const e of report.entries.filter((x) => x.purpose === p.purpose))
      lines.push(`  - ${e.keyId}  ${e.role}  ${e.algorithm}  from ${e.source}${e.ageDays !== undefined ? `  age=${e.ageDays}d` : ""}  retirement=${e.retirement}${e.retireAfter ? ` (after ${e.retireAfter})` : ""}${e.notAfter ? `  expires=${e.notAfter}` : ""}`);
  }
  if (report.violations.length) { lines.push("", "Separation findings:"); for (const v of report.violations) lines.push(`  [${v.severity}] ${v.code}: ${v.message}`); }
  if (report.findings.length) { lines.push("", "Custody findings:"); for (const f of report.findings) lines.push(`  ${f}`); }
  return lines;
}

/** Process exit code: 1 when any error-level separation finding or configuration error exists. */
export function reportExitCode(report: KeyReport): number {
  return report.violations.some((v) => v.severity === "error") ? 1 : 0;
}

/* ------------------------------ temporal mTLS ------------------------------ */

/** Certificate facts for the Temporal client certificate: fingerprint and expiry only. Never reads the private key file. */
export function inspectTemporalMtls(env: Readonly<Record<string, string | undefined>> = process.env, read: (path: string) => Buffer = readFileSync): KeyReportEntry | undefined {
  const certFile = env.ZENITH_TEMPORAL_TLS_CERT_FILE?.trim();
  if (!certFile) return undefined;
  const base: KeyReportEntry = { purpose: "tls:temporal-mtls", keyId: "unreadable", role: "verify_only", source: "ZENITH_TEMPORAL_TLS_CERT_FILE", derivation: "certificate", algorithm: "X509", retirement: "unscheduled" };
  try {
    const cert = new X509Certificate(read(certFile));
    const keyFile = env.ZENITH_TEMPORAL_TLS_KEY_FILE?.trim();
    return { ...base, keyId: cert.fingerprint256.replace(/:/g, "").toLowerCase().slice(0, 32), role: "current", notAfter: new Date(cert.validTo).toISOString(), algorithm: keyFile && existsSync(keyFile) ? "X509 (key file present)" : "X509 (key file missing)", retirement: "current" };
  } catch {
    return base;
  }
}

/* ----------------------------- temporal payloads ---------------------------- */

/** Must equal the constants in src/lib/workflows/codec.ts (tests assert it). */
export const CODEC_ENCODING = "binary/zenith.temporal.v1";
export const CODEC_KEY_ID_METADATA = "zenith.temporal.key-id";

export type PayloadStatus = "legacy_plaintext" | "current_key" | "decrypt_only_key" | "key_unavailable" | "invalid_envelope";
export interface PayloadFinding { path: string; status: PayloadStatus; keyId?: string }

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try { return Buffer.from(value, "base64").toString("utf8"); } catch { return undefined; }
};

/**
 * Walk any JSON (a `temporal workflow show --output json` document, or an array of payloads) and classify every
 * payload by its envelope metadata. Does not decrypt anything; the key ids it reports are the ones the codec
 * wrote, so an operator can see which retired key an old history still needs.
 */
export function inspectTemporalPayloads(ring: KeyRing, document: unknown, limit = 10_000): PayloadFinding[] {
  const held = new Map(ring.descriptors("enc:temporal-payload").map((d) => [d.keyId, d.role]));
  const out: PayloadFinding[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (out.length >= limit || depth > 24 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1)); return; }
    const record = node as Record<string, unknown>;
    const metadata = record.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && "encoding" in (metadata as object)) {
      const m = metadata as Record<string, unknown>;
      const encoding = text(m.encoding);
      const keyId = text(m[CODEC_KEY_ID_METADATA]);
      if (encoding === CODEC_ENCODING) {
        if (!keyId || !/^[a-f0-9]{32}$/.test(keyId)) out.push({ path, status: "invalid_envelope" });
        else {
          const role = held.get(keyId);
          out.push({ path, keyId, status: role === "current" ? "current_key" : role === "decrypt_only" ? "decrypt_only_key" : "key_unavailable" });
        }
      } else if (encoding?.startsWith("binary/zenith.temporal") || keyId !== undefined) out.push({ path, status: "invalid_envelope" });
      else out.push({ path, status: "legacy_plaintext" });
      return;
    }
    for (const [k, v] of Object.entries(record)) visit(v, `${path}.${k}`, depth + 1);
  };
  visit(document, "$", 0);
  return out;
}

export function summarizePayloadFindings(findings: readonly PayloadFinding[]): { total: number; byStatus: Record<PayloadStatus, number>; byKeyId: Record<string, number> } {
  const byStatus: Record<PayloadStatus, number> = { legacy_plaintext: 0, current_key: 0, decrypt_only_key: 0, key_unavailable: 0, invalid_envelope: 0 };
  const byKeyId: Record<string, number> = {};
  for (const f of findings) {
    byStatus[f.status]++;
    if (f.keyId) byKeyId[f.keyId] = (byKeyId[f.keyId] ?? 0) + 1;
  }
  return { total: findings.length, byStatus, byKeyId };
}
