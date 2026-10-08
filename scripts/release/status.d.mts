import type { z } from "zod";
export interface ReleaseEvidence { level: string; commit?: string; artifact?: string; logs?: string; sha256?: string; command?: string; environment?: string; result?: string; url?: string; runId?: number }
export interface ReleaseLedger {
  requirements: { id: string; implementationStatus: string; requiredEvidence: string[]; evidence: ReleaseEvidence[] }[];
  releaseStatus?: Record<string, boolean>;
  releaseCandidate?: { commit: string };
  releaseSignoffs?: string[];
}
export interface EvidenceReference { requirementId: string; level: string; path: string; sha256: string }
export interface EvidenceReceipt {
  format: "zenith.release-evidence.v1"; requirementId: string; level: string; commit: string; environment: string; command: string;
  mode: "contract" | "local" | "live" | "remote_ci"; status: "passed" | "failed" | "skipped" | "not_run";
  passed: number; failed: number; skipped: number; exitCode: number; sources: { path: string; sha256: string }[];
}
export interface SignoffRecord {
  format: "zenith.release-signoff.v1"; who: string; when: string; commit: string;
  scope: { status: "productionApproved"; requirements: string[] }; ledgerSha256: string; evidence: EvidenceReference[];
  signature: { algorithm: "Ed25519"; kid: string; value: string };
}
export interface SignoffKey { kid: string; publicKey: string; identity: string }
export interface StatusOptions { root?: string; readEvidence?: (relative: string) => Buffer; commit?: string; keys?: SignoffKey[]; now?: Date }
export const EVIDENCE_FORMAT: "zenith.release-evidence.v1";
export const SIGNOFF_FORMAT: "zenith.release-signoff.v1";
export const EvidenceSchema: z.ZodType<EvidenceReceipt>;
export const SignoffSchema: z.ZodType<SignoffRecord>;
export function sha256(bytes: Buffer | string): string;
export function canonical(value: unknown): string;
export function readRepositoryFile(root: string, relative: string): Buffer;
export function releaseSnapshotDigest(ledger: ReleaseLedger): string;
export function sourceOutcome(source: Record<string, unknown>): { passed: number; failed: number; skipped: number; commit: string; exitCode: number; mode: string; requirements: string[]; command: unknown; environment: unknown; status: unknown };
export function inspectEvidence(requirementId: string, evidence: ReleaseEvidence, options?: StatusOptions): { valid: boolean; recorded: boolean; file: string | null; sha256: string | null; receipt: EvidenceReceipt | null; errors: string[] };
export function selectReleaseEvidence(ledger: ReleaseLedger, options?: StatusOptions, includeRehearsals?: boolean): { errors: string[]; refs: EvidenceReference[] };
export function signSignoff(body: Omit<SignoffRecord, "signature">, seed: Buffer, kid: string): SignoffRecord;
export function verifySignoff(record: unknown, ledger: ReleaseLedger, refs: EvidenceReference[], keys: SignoffKey[], now?: Date): boolean;
export function validateReleaseStatus(ledger: ReleaseLedger, options?: StatusOptions): string[];
