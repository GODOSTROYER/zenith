/**
 * Ownership proof for one non-AWS DNS record set at teardown (GCP, Azure, OCI).
 *
 * The provider assessors (`gcp|azure|oci/dns-ownership.ts`) already refuse any
 * foreign, malformed, truncated or unreadable target. This module is the
 * shared, deterministic RECORD of what they proved, so teardown can bind it:
 *
 *   - `ownership` names the independent facts that established ownership
 *     (resource tags/labels, companion TXT marker, value-to-target match) and
 *     `stateMatch` says whether the recorded provider id agreed with the live
 *     record set. A proof exists only for a `safe` verdict; there is no proof of
 *     a foreign or unreadable record set.
 *   - the proofs are folded into the reviewed plan summary as `dnsOwnership`
 *     (digest + records). The apply step recomputes them after the final human
 *     approval lookup and refuses unless they equal the reviewed ones, so the
 *     approval covers the exact record sets and values that were reviewed, not a
 *     later re-pointed record (`assertProofsMatchReview`).
 *   - after the delete, readback classifies each record set against its review
 *     (`dnsDisposition`): deleted, already absent (idempotent re-run), still
 *     present, or unknown. Only a non-simulated `missing` observation is absence.
 *
 * Proofs carry only values the assessors have already matched to Zenith's own
 * target (addresses, targets) and never provider error text or credentials.
 * Contract evidence only; no live cloud run.
 */
import { digest } from "@/lib/controlplane/digest";

export type DnsTeardownProvider = "gcp" | "azure" | "oci";

export interface DnsRecordSetProof {
  provider: DnsTeardownProvider;
  /** the graph address of the dns_record node */
  address: string;
  zone: string;
  name: string;
  type: string;
  /** what the assessor read: a live record set, or none (zone readable, record absent) */
  disposition: "present" | "absent";
  /** live values, sorted; empty when absent */
  values: string[];
  /** independent facts that established ownership, e.g. `oci:load_balancer_tags` */
  ownership: string[];
  /** did the node's recorded provider id agree with the live record set? */
  stateMatch: "externalRef" | "unrecorded";
}

export type DnsAssessment = { safe: boolean; reason: string; proof?: DnsRecordSetProof };

const MAX_VALUES = 50;

export function makeProof(input: Omit<DnsRecordSetProof, "values" | "ownership"> & { values: readonly string[]; ownership: readonly string[] }): DnsRecordSetProof {
  return { ...input, values: [...input.values].slice(0, MAX_VALUES).sort(), ownership: [...new Set(input.ownership)].sort() };
}

/** Deterministic order and digest; the digest is what the apply step compares. */
export function sortProofs(proofs: readonly DnsRecordSetProof[]): DnsRecordSetProof[] {
  return [...proofs].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

export function proofsDigest(proofs: readonly DnsRecordSetProof[]): string {
  return digest(sortProofs(proofs));
}

/** The summary fragment stored with the reviewed plan evidence. */
export function dnsOwnershipSummary(proofs: readonly DnsRecordSetProof[]): { digest: string; records: DnsRecordSetProof[] } | undefined {
  if (proofs.length === 0) return undefined;
  const records = sortProofs(proofs);
  return { digest: digest(records), records };
}

export class DnsProofMismatch extends Error {
  readonly code = "dns_ownership_changed";
  constructor() {
    super("DNS record ownership changed since review; a new review is required.");
    this.name = "DnsProofMismatch";
  }
}

/** Is `value` a well-formed stored proof? Anything else is treated as absent. */
function parsedReviewed(value: unknown): { digest: string; records: DnsRecordSetProof[] } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as { digest?: unknown; records?: unknown };
  if (typeof v.digest !== "string" || !/^[0-9a-f]{64}$/.test(v.digest) || !Array.isArray(v.records)) return undefined;
  // The stored digest must itself be the digest of the stored records.
  if (digest(sortProofs(v.records as DnsRecordSetProof[])) !== v.digest) return undefined;
  return { digest: v.digest, records: v.records as DnsRecordSetProof[] };
}

/**
 * Refuse unless the freshly proven record sets equal the reviewed ones. A review
 * without a proof while DNS records are being torn down is refused too: it
 * predates this binding or was tampered with, and must be re-reviewed.
 */
export function assertProofsMatchReview(fresh: readonly DnsRecordSetProof[], reviewedSummary: unknown): void {
  if (fresh.length === 0) {
    // Nothing to tear down now; a reviewed proof for records that no longer exist is a changed environment.
    if (parsedReviewed(reviewedSummary)?.records.length) throw new DnsProofMismatch();
    return;
  }
  const reviewed = parsedReviewed(reviewedSummary);
  if (!reviewed || reviewed.digest !== proofsDigest(fresh)) throw new DnsProofMismatch();
}

export type DnsDisposition = "deleted" | "already_absent" | "still_present" | "unknown";

/**
 * Classify one record set after teardown against its review. `deleted` means it
 * was present at review and independent readback now says missing;
 * `already_absent` means it was already absent at review (an idempotent re-run
 * is not an error). Anything other than a definite observation is `unknown`.
 */
export function dnsDisposition(reviewed: DnsRecordSetProof | undefined, observed: { presence: string; simulated: boolean }): DnsDisposition {
  if (!reviewed || observed.simulated) return "unknown";
  if (observed.presence === "present") return "still_present";
  if (observed.presence !== "missing") return "unknown";
  return reviewed.disposition === "present" ? "deleted" : "already_absent";
}

export function reviewedProofFor(reviewedSummary: unknown, address: string): DnsRecordSetProof | undefined {
  return parsedReviewed(reviewedSummary)?.records.find((r) => r.address === address);
}
