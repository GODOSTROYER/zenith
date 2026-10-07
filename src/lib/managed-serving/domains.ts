/**
 * Custom-domain ownership proof for the Zenith-managed platform (PROD-MAN-03).
 *
 * Pure rules and one DNS port; no store here (`domain-service.ts` composes them with the platform store).
 *
 * The proof is a DNS TXT record at `_zenith-challenge.<hostname>` whose value is exactly
 * `zenith-domain-verification=<token>`. The token is random, shown to the claimant once and stored only as the SHA-256 of the
 * whole TXT value, so a database read cannot be replayed as a proof. A proof is time-boxed (`PROOF_TTL_MS`, PROVISIONAL, a
 * product decision not yet made) and RENEWED by re-checking the same record inside `RENEWAL_WINDOW_MS` before expiry; an
 * unrenewable proof lapses after `GRACE_MS` and the host stops being served (the render step only ever sees VERIFIED hosts).
 *
 * Fail-closed on ownership, fail-open on outages: a DNS error is `uncertain` and never counts as a missing record, but a
 * proof that has not been positively renewed by the end of its grace period lapses whatever the reason, because serving a
 * host nobody can currently prove they own is the unsafe direction.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { DomainOutcome, DomainStatus } from "@/lib/controlplane/db/repos/managed-serving";

export const CHALLENGE_LABEL = "_zenith-challenge";
export const CHALLENGE_PREFIX = "zenith-domain-verification=";
/** PROVISIONAL: how long a successful proof is honoured before it must be renewed. */
export const PROOF_TTL_MS = 30 * 24 * 3600_000;
/** PROVISIONAL: renewal starts this long before expiry. */
export const RENEWAL_WINDOW_MS = 7 * 24 * 3600_000;
/** PROVISIONAL: an unrenewed proof keeps serving this long past expiry before it lapses. */
export const GRACE_MS = 3 * 24 * 3600_000;
/** A pending claim must be proven within this long, after which it must be re-issued. */
export const PENDING_TTL_MS = 7 * 24 * 3600_000;
/** PROVISIONAL: custom domain claims one environment may hold (pending within TTL plus verified). */
export const MAX_DOMAINS_PER_ENVIRONMENT = 10;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_TLDS = new Set(["localhost", "local", "internal", "invalid", "test", "example", "onion", "lan", "home", "corp", "intranet", "arpa"]);

export type HostnameCheck = { ok: true; hostname: string } | { ok: false; code: "invalid_hostname" | "managed_suffix" | "reserved_hostname"; reason: string };

/**
 * A hostname a tenant may claim: ASCII, lowercase, at least two labels, no wildcard, no IP literal, no punycode (homograph
 * risk, consistent with managed hostnames), no reserved TLD, and never the platform's own domain or anything under it (those
 * hosts are the platform's and are served natively).
 */
export function checkCustomHostname(input: unknown, baseDomain: string): HostnameCheck {
  if (typeof input !== "string") return { ok: false, code: "invalid_hostname", reason: "The hostname must be text." };
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (host.length < 4 || host.length > 253) return { ok: false, code: "invalid_hostname", reason: "The hostname must be 4 to 253 characters." };
  if (/[^a-z0-9.-]/.test(host)) return { ok: false, code: "invalid_hostname", reason: "Use ASCII letters, digits, hyphens and dots only; wildcards, ports and paths are not accepted." };
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return { ok: false, code: "invalid_hostname", reason: "Each label must be 1 to 63 characters of letters, digits and hyphens, not starting or ending with a hyphen." };
  if (labels.some((l) => l.startsWith("xn--"))) return { ok: false, code: "invalid_hostname", reason: "Internationalized (punycode) hostnames are not supported." };
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, code: "invalid_hostname", reason: "An IP address is not a hostname." };
  if (RESERVED_TLDS.has(labels[labels.length - 1])) return { ok: false, code: "reserved_hostname", reason: "That top-level domain is reserved and cannot be public." };
  if (labels[0] === CHALLENGE_LABEL) return { ok: false, code: "reserved_hostname", reason: "That label is reserved for ownership proofs." };
  const base = baseDomain.toLowerCase();
  if (host === base || host.endsWith(`.${base}`)) return { ok: false, code: "managed_suffix", reason: `Hosts under ${base} are the platform's own and are served automatically; claim a domain you own.` };
  return { ok: true, hostname: host };
}

export const challengeRecordName = (hostname: string): string => `${CHALLENGE_LABEL}.${hostname}`;
export const challengeValue = (token: string): string => `${CHALLENGE_PREFIX}${token}`;
export const hashChallengeValue = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export interface Challenge {
  /** shown to the claimant exactly once */
  token: string;
  recordName: string;
  recordType: "TXT";
  recordValue: string;
  /** what the store keeps */
  hash: string;
}

export function newChallenge(hostname: string): Challenge {
  const token = randomBytes(24).toString("base64url");
  const recordValue = challengeValue(token);
  return { token, recordName: challengeRecordName(hostname), recordType: "TXT", recordValue, hash: hashChallengeValue(recordValue) };
}

/* --------------------------------- DNS port -------------------------------- */

export type TxtLookup = { status: "records"; records: string[] } | { status: "none" } | { status: "error"; code: string };

export interface DomainDnsPort {
  /** TXT values at `name`, each record's chunks already concatenated. CNAME chains are followed by the resolver. */
  resolveTxt(name: string): Promise<TxtLookup>;
}

const MAX_RECORDS = 50;
const MAX_RECORD_LENGTH = 512;

/** `node:dns` with a hard per-lookup timeout and bounded answers. Only error CODES leave this function. */
export function systemDomainDns(opts: { timeoutMs?: number; servers?: string[] } = {}): DomainDnsPort {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const resolver = (): Resolver => {
    const r = new Resolver({ timeout: timeoutMs, tries: 2 });
    if (opts.servers?.length) r.setServers(opts.servers);
    return r;
  };
  const NONE = new Set(["ENODATA", "ENOTFOUND"]);
  return {
    async resolveTxt(name) {
      try {
        const answers = await resolver().resolveTxt(name);
        return { status: "records", records: answers.slice(0, MAX_RECORDS).map((chunks) => chunks.join("").slice(0, MAX_RECORD_LENGTH)) };
      } catch (error) {
        const code = String((error as { code?: unknown }).code ?? "UNKNOWN").slice(0, 40);
        return NONE.has(code) ? { status: "none" } : { status: "error", code };
      }
    },
  };
}

/* ------------------------------- verification ------------------------------ */

export interface VerificationResult {
  outcome: DomainOutcome;
  /** why, in a form safe to show (never a TXT value) */
  detail: string;
}

const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** Look up the challenge record and compare the SHA-256 of each published value with the stored hash. */
export async function verifyChallenge(hostname: string, expectedHash: string, dns: DomainDnsPort): Promise<VerificationResult> {
  const found = await dns.resolveTxt(challengeRecordName(hostname));
  if (found.status === "error") return { outcome: "uncertain", detail: `DNS lookup failed (${found.code}); ownership could not be checked.` };
  if (found.status === "none" || found.records.length === 0) return { outcome: "not_found", detail: `No TXT record at ${challengeRecordName(hostname)}.` };
  for (const record of found.records) {
    if (record.startsWith(CHALLENGE_PREFIX) && sameHash(hashChallengeValue(record.trim()), expectedHash)) return { outcome: "verified", detail: "The challenge record matches." };
  }
  return { outcome: "mismatch", detail: `${challengeRecordName(hostname)} exists but holds no value matching this claim's challenge.` };
}

/* ------------------------------ state machine ------------------------------ */

export interface DomainState {
  status: DomainStatus;
  expiresAt: Date | null;
  failureCount: number;
}

export interface DomainDecision {
  status: DomainStatus;
  outcome: DomainOutcome;
  verifiedAt?: Date | null;
  expiresAt?: Date | null;
  failureCount: number;
  lapsedAt?: Date | null;
  /** how the claim changed, for audit and the API answer */
  change: "verified" | "renewed" | "renewal_failing" | "lapsed" | "unchanged";
}

/**
 * The only place a proof changes state. `verified`/`renewed` set a fresh expiry; a miss keeps serving until the grace period
 * after expiry has passed, then lapses; an uncertain check changes nothing except the same grace rule; nothing ever moves a
 * revoked claim, and a pending claim only moves by being proven.
 */
export function decideDomainTransition(state: DomainState, outcome: DomainOutcome, now: Date): DomainDecision | null {
  if (state.status === "revoked") return null;
  const failures = outcome === "verified" ? 0 : state.failureCount + 1;
  if (outcome === "verified") {
    if (state.status === "verified") return { status: "verified", outcome, verifiedAt: now, expiresAt: new Date(now.getTime() + PROOF_TTL_MS), failureCount: 0, change: "renewed" };
    return { status: "verified", outcome, verifiedAt: now, expiresAt: new Date(now.getTime() + PROOF_TTL_MS), failureCount: 0, change: "verified" };
  }
  if (state.status === "verified" && state.expiresAt && now.getTime() >= state.expiresAt.getTime() + GRACE_MS) {
    return { status: "lapsed", outcome, failureCount: failures, lapsedAt: now, change: "lapsed" };
  }
  if (state.status === "verified") return { status: "verified", outcome, failureCount: failures, change: now.getTime() >= (state.expiresAt?.getTime() ?? Infinity) - RENEWAL_WINDOW_MS ? "renewal_failing" : "unchanged" };
  return { status: state.status, outcome, failureCount: failures, change: "unchanged" };
}

/** Where a claim stands for the person reading it (derived, never stored). */
export function describeDomain(status: DomainStatus, expiresAt: string | null, now: Date): "pending" | "serving" | "renewal_due" | "in_grace" | "lapsed" | "revoked" {
  if (status === "verified") {
    const exp = expiresAt ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(exp)) return "serving";
    if (now.getTime() >= exp) return "in_grace";
    return now.getTime() >= exp - RENEWAL_WINDOW_MS ? "renewal_due" : "serving";
  }
  return status;
}
