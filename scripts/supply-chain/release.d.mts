/* eslint-disable @typescript-eslint/no-explicit-any */
// Types for release.mjs (PROD-OPS-09).
import type { KeyObject } from "node:crypto";
export const MANIFEST_SCHEMA: string;
export const SIGNING_PREFIX: string;
export const ENVELOPE_FILE: string;
export const SBOM_FILE: string;
export const PROVENANCE_FILE: string;
export const IN_TOTO_STATEMENT_V1: string;
export const SLSA_PROVENANCE_V1: string;
export const RELEASE_BUILD_TYPE: string;
export interface KeyEntry { kid: string; publicKey: string }
export function sha256File(file: string): string;
export function artifactKind(name: string): string;
export function ociArchive(file: string): { digests: string[]; blobCount: number };
export function buildProvenance(input: { dir: string; repository: string; commit: string; ref: string; workflow: string; runUrl: string; lockSha256: string; startedOn?: string; finishedOn?: string }): any;
export function buildManifest(input: { dir: string; tag: string; version: string; commit: string; repository: string; images?: { name: string; archive: string }[]; validDays?: number; now?: Date }): any;
export function privateKeyFromSeed(seed: Buffer): KeyObject;
export function publicKeyEntry(kid: string, seed: Buffer): KeyEntry;
export function signManifest(manifestBytes: Buffer, seed: Buffer, kid: string): { manifest: string; signatures: { kid: string; sig: string }[] };
export function verifyRelease(input: { dir: string; keys: KeyEntry[]; now?: Date; strict?: boolean; lock?: string }): { ok: boolean; errors: string[]; warnings: string[]; manifest?: any };
export function main(argv: string[], stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream): number;
