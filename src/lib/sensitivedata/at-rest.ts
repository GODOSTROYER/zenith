/**
 * Encryption-at-rest checks for every sealed column in the inventory (PROD-OPS-06).
 *
 * `atRestCensus` samples rows of each sealed column and checks that what is stored has the SHAPE of ciphertext
 * written by its sealer: a result box with iv, ciphertext and tag; vault columns that decode to a 12 byte nonce
 * and a 16 byte tag; opaque bytes that are not readable JSON or text. It cannot prove a value is encrypted (only
 * that nothing plain-looking is in a column that must hold ciphertext), and it never prints a stored value: a
 * result is counts and column names. Rows are sampled, not exhaustively scanned.
 *
 * Reachable as `scripts/sensitive-data-census.ts` (operator, read-only) and exercised against a real database by
 * tests/security/persistence-leaks.test.ts.
 */
import type { Sql } from "@/lib/controlplane/types";
import { isSealedBox } from "@/lib/runners/seal";
import type { SealScheme } from "./inventory";

export interface CellVerdict { ok: boolean; reason?: string }

const b64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function asJson(cell: unknown): unknown {
  if (typeof cell !== "string") return cell;
  try { return JSON.parse(cell); } catch { return cell; }
}

/** Result envelope of runner_jobs/machine_requests: {sealed, exitCode, startedAt, finishedAt} or a minimized marker. */
export function verifyResultEnvelope(cell: unknown): CellVerdict {
  const value = asJson(cell);
  if (value === null || value === undefined) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "result is not an envelope object" };
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !["sealed", "exitCode", "startedAt", "finishedAt", "minimized"].includes(k));
  if (extra.length) return { ok: false, reason: "result envelope carries fields beyond the sealed body and non-secret metadata" };
  if ("sealed" in record) return isSealedBox(record.sealed) ? { ok: true } : { ok: false, reason: "result body is not a sealed box" };
  return record.minimized === true ? { ok: true } : { ok: false, reason: "result has neither a sealed body nor a minimized marker" };
}

export function verifySealedBox(cell: unknown): CellVerdict {
  const value = asJson(cell);
  if (value === null || value === undefined) return { ok: true };
  return isSealedBox(value) ? { ok: true } : { ok: false, reason: "value is not a sealed box" };
}

/** iv (12 bytes), auth tag (16 bytes) and ciphertext columns, base64. */
export function verifySealedColumns(row: Record<string, unknown>): CellVerdict {
  const decode = (v: unknown): Buffer | undefined => (typeof v === "string" && v.length > 0 && b64.test(v) ? Buffer.from(v, "base64") : undefined);
  const iv = decode(row.iv), tag = decode(row.auth_tag), ct = decode(row.ciphertext);
  if (!iv || iv.length !== 12) return { ok: false, reason: "iv is not a 12 byte nonce" };
  if (!tag || tag.length !== 16) return { ok: false, reason: "auth tag is not 16 bytes" };
  if (!ct || ct.length < 1) return { ok: false, reason: "ciphertext is missing" };
  return { ok: true };
}

function bytesOf(cell: unknown): Buffer | undefined {
  if (cell instanceof Uint8Array) return Buffer.from(cell);
  if (typeof cell === "string" && cell.startsWith("\\x")) return Buffer.from(cell.slice(2), "hex");
  return undefined;
}

/** Opaque sealed bytes: long enough for nonce and tag, and neither JSON nor mostly printable text. */
export function verifyOpaqueBytes(cell: unknown): CellVerdict {
  if (cell === null || cell === undefined) return { ok: true };
  const bytes = bytesOf(cell);
  if (!bytes) return { ok: false, reason: "value is not a byte string" };
  if (bytes.length < 28) return { ok: false, reason: "value is too short to hold a nonce and tag" };
  const head = bytes.subarray(0, Math.min(bytes.length, 256));
  // Random ciphertext may start with { or [ by chance; only a value that actually parses as JSON is a finding.
  if (head[0] === 0x7b || head[0] === 0x5b) {
    try { JSON.parse(bytes.toString("utf8")); return { ok: false, reason: "value looks like JSON" }; } catch { /* not JSON */ }
  }
  let printable = 0;
  for (const b of head) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) printable++;
  return printable / head.length > 0.9 ? { ok: false, reason: "value is readable text" } : { ok: true };
}

interface Check {
  id: string;
  table: string;
  /** inventory columns this check validates */
  columns: readonly string[];
  scheme: SealScheme;
  sql: string;
  verify: (row: Record<string, unknown>) => CellVerdict;
}

export const AT_REST_CHECKS: readonly Check[] = [
  { id: "runner-results", table: "platform.runner_jobs", columns: ["result"], scheme: "result-box", sql: "select result as cell from platform.runner_jobs where result is not null limit $1", verify: (r) => verifyResultEnvelope(r.cell) },
  { id: "machine-results", table: "platform.machine_requests", columns: ["result"], scheme: "result-box", sql: "select result as cell from platform.machine_requests where result is not null limit $1", verify: (r) => verifyResultEnvelope(r.cell) },
  { id: "machine-artifacts", table: "platform.idempotency_keys", columns: ["response"], scheme: "result-box", sql: "select response as cell from platform.idempotency_keys where response is not null limit $1", verify: (r) => verifySealedBox(r.cell) },
  { id: "effect-receipts", table: "platform.agent_effect_receipts", columns: ["sealed"], scheme: "result-box", sql: "select sealed as cell from platform.agent_effect_receipts limit $1", verify: (r) => verifySealedBox(r.cell) },
  { id: "plan-artifacts", table: "platform.plan_artifacts", columns: ["auth_tag", "ciphertext"], scheme: "plan-columns", sql: "select iv, auth_tag, ciphertext from platform.plan_artifacts limit $1", verify: verifySealedColumns },
  { id: "plan-settlements", table: "platform.standalone_plan_settlements", columns: ["auth_tag", "ciphertext"], scheme: "plan-columns", sql: "select iv, auth_tag, ciphertext from platform.standalone_plan_settlements limit $1", verify: verifySealedColumns },
  { id: "plan-custody-grants", table: "platform.plan_custody_grants", columns: ["wrap_ciphertext"], scheme: "plan-columns", sql: "select wrap_iv as iv, wrap_tag as auth_tag, wrap_ciphertext as ciphertext from platform.plan_custody_grants limit $1", verify: verifySealedColumns },
  { id: "vault", table: "public.secrets", columns: ["auth_tag", "ciphertext"], scheme: "vault-columns", sql: "select iv, auth_tag, ciphertext from public.secrets limit $1", verify: verifySealedColumns },
  { id: "invite-deliveries", table: "hosted.invite_deliveries", columns: ["sealed_payload"], scheme: "opaque-bytes", sql: "select sealed_payload as cell from hosted.invite_deliveries where sealed_payload is not null limit $1", verify: (r) => verifyOpaqueBytes(r.cell) },
  { id: "agent-link-secrets", table: "agent.agent_link_codes", columns: ["secret_ct"], scheme: "opaque-bytes", sql: "select secret_ct as cell from agent.agent_link_codes where secret_ct is not null limit $1", verify: (r) => verifyOpaqueBytes(r.cell) },
];

/** `table.column` for everything the census validates; the inventory test requires every sealed column here. */
export const CENSUS_COVERS: ReadonlySet<string> = new Set(AT_REST_CHECKS.flatMap((c) => c.columns.map((col) => `${c.table}.${col}`)));

export interface CensusResult {
  id: string;
  table: string;
  scheme: SealScheme;
  /** the table does not exist in this database */
  absent: boolean;
  sampled: number;
  violations: number;
  /** distinct fixed reasons, never values */
  reasons: string[];
}

export async function atRestCensus(db: Sql, options: { sample?: number } = {}): Promise<CensusResult[]> {
  const sample = Math.max(1, Math.min(10_000, Math.trunc(options.sample ?? 500)));
  const out: CensusResult[] = [];
  for (const check of AT_REST_CHECKS) {
    const present = await db.query<{ t: string | null }>("select to_regclass($1)::text as t", [check.table]);
    if (!present[0]?.t) { out.push({ id: check.id, table: check.table, scheme: check.scheme, absent: true, sampled: 0, violations: 0, reasons: [] }); continue; }
    const rows = await db.query<Record<string, unknown>>(check.sql, [sample]);
    const reasons = new Set<string>();
    let violations = 0;
    for (const row of rows) {
      const verdict = check.verify(row);
      if (!verdict.ok) { violations++; reasons.add(verdict.reason ?? "unexpected shape"); }
    }
    out.push({ id: check.id, table: check.table, scheme: check.scheme, absent: false, sampled: rows.length, violations, reasons: [...reasons].sort() });
  }
  return out;
}
