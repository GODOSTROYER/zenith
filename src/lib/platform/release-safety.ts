/**
 * Composition root for release and data migration safety (PROD-LIFE-10).
 *
 *  store      the platform control store (`release_runs`, `release_events`, `release_migration_approvals`)
 *  verifiers  Zenith's own build-record check plus whatever LIFE-09 registers through
 *             `registerProvenanceVerifier` (isolated build attestation). Consumed, never produced, here.
 *  policy     the weakest provenance level a release may carry, from `ZENITH_RELEASE_MIN_PROVENANCE`
 *             (`pinned_digest` default, `build_record`, `attested`). Raising it is an operator decision;
 *             lowering it below `pinned_digest` is not possible: a tag or an unknown digest is refused.
 */
import type { Sql } from "@/lib/controlplane/types";
import { platformDb } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { createPlatformReleaseStore } from "@/lib/controlplane/db/repos/release-pipelines";
import {
  ReleaseSafetyService,
  isProvenanceLevel,
  registeredProvenanceVerifiers,
  type ProvenanceLevel,
  type ProvenanceSubject,
  type ProvenanceVerdict,
  type ProvenanceVerifier,
} from "@/lib/release-safety";
import { ensurePlatformApp } from "./app";

const DEFAULT_MIN: ProvenanceLevel = "pinned_digest";

export function releaseMinProvenance(env: Record<string, string | undefined> = process.env): ProvenanceLevel {
  const raw = env.ZENITH_RELEASE_MIN_PROVENANCE;
  if (!raw) return DEFAULT_MIN;
  if (!isProvenanceLevel(raw) || raw === "none") throw new Error("ZENITH_RELEASE_MIN_PROVENANCE must be pinned_digest, build_record or attested.");
  return raw;
}

/**
 * Zenith's own evidence. An image Zenith built is `build_record` only when this operation recorded a
 * real (non-simulated) build for exactly this service, digest and approved source. A digest the
 * manifest pins is `pinned_digest`: Zenith knows the digest, nothing about where it came from.
 */
export function createBuildRecordVerifier(db: Sql): ProvenanceVerifier {
  return {
    name: "zenith.build-record",
    async verify(subject: ProvenanceSubject): Promise<ProvenanceVerdict> {
      if (!subject.imageUri.endsWith(`@${subject.imageDigest}`)) return { verified: false, level: "none", reason: "the image reference does not carry the digest" };
      if (subject.origin === "pinned") return { verified: true, level: "pinned_digest", evidenceRef: `pinned:${subject.imageDigest}`, verifiedAt: new Date().toISOString() };
      const rows = await repos.evidence.list(db, subject.workspaceId, { operationId: subject.operationId, limit: 200 });
      const build = rows.find((e) => {
        const s = e.summary as Record<string, unknown>;
        return e.kind === "build" && !e.simulated && s.service === subject.serviceAddress && s.imageDigest === subject.imageDigest && typeof s.sourceDigest === "string" && (!subject.sourceDigest || s.sourceDigest === subject.sourceDigest);
      });
      if (!build) return { verified: false, level: "none", reason: "no build record for this digest in this operation" };
      return { verified: true, level: "build_record", evidenceRef: `evidence:${build.id}`, verifiedAt: new Date().toISOString() };
    },
  };
}

export function createPlatformReleaseSafety(db: Sql, env: Record<string, string | undefined> = process.env): ReleaseSafetyService {
  const builtIn = createBuildRecordVerifier(db);
  return new ReleaseSafetyService({
    store: createPlatformReleaseStore(db),
    verifiers: () => [builtIn, ...registeredProvenanceVerifiers()],
    minProvenance: releaseMinProvenance(env),
  });
}

type G = typeof globalThis & { __zenithReleaseSafety?: Promise<ReleaseSafetyService | null> };

/** The service the REST routes use. `null` when the platform store is not configured. */
export function platformReleaseSafety(): Promise<ReleaseSafetyService | null> {
  const g = globalThis as G;
  g.__zenithReleaseSafety ??= (async () => {
    if (!(await ensurePlatformApp())) return null;
    return createPlatformReleaseSafety(await platformDb());
  })().catch((e) => {
    delete g.__zenithReleaseSafety;
    throw e;
  });
  return g.__zenithReleaseSafety;
}

/** Test isolation only. */
export function resetPlatformReleaseSafetyForTests(): void {
  delete (globalThis as G).__zenithReleaseSafety;
}
