/**
 * The seam to build provenance. LIFE-09 (isolated untrusted build provenance) owns producing and
 * verifying attestations; this module only CONSUMES a verdict through `ProvenanceVerifier` and
 * refuses a digest that has none.
 *
 * Several verifiers may be registered (Zenith's own build-record check, and LIFE-09's attestation
 * check when it lands). The strongest verified verdict wins; a verifier that throws counts as
 * "not verified", never as "skip".
 */
import { PROVENANCE_LEVELS, ReleaseSafetyError, scrub, type ProvenanceLevel, type ProvenanceVerdict } from "./types";

export interface ProvenanceSubject {
  workspaceId: string;
  environmentId: string;
  operationId: string;
  serviceAddress: string;
  imageUri: string;
  /** `sha256:` + 64 hex */
  imageDigest: string;
  /** digest of the approved source snapshot the image was built from, when it was built here */
  sourceDigest?: string;
  /** `built`: Zenith built it in this operation; `pinned`: the manifest or a prior release named it */
  origin: "built" | "pinned";
  /**
   * Supplied by the deploy path for an image Zenith built from customer source (PROD-LIFE-09): the
   * signed-provenance admission that already ran for this exact service and digest. Resolves to an
   * evidence reference or rejects. It is the ONLY attestation path; nothing re-verifies it elsewhere.
   */
  builtAdmission?: () => Promise<{ evidenceRef: string }>;
}

export interface ProvenanceVerifier {
  readonly name: string;
  verify(subject: ProvenanceSubject): Promise<ProvenanceVerdict>;
}

const RANK: Readonly<Record<ProvenanceLevel, number>> = Object.fromEntries(PROVENANCE_LEVELS.map((l, i) => [l, i])) as Record<ProvenanceLevel, number>;

export const meetsLevel = (have: ProvenanceLevel, need: ProvenanceLevel): boolean => RANK[have] >= RANK[need];

export const isProvenanceLevel = (v: unknown): v is ProvenanceLevel => typeof v === "string" && (PROVENANCE_LEVELS as readonly string[]).includes(v);

type G = typeof globalThis & { __zenithProvenanceVerifiers?: ProvenanceVerifier[] };

/**
 * The attestation verifier (PROD-LIFE-09's signed build provenance seen through LIFE-10's gate): an
 * image Zenith built is `attested` only when the deploy path's admission of its signed provenance
 * (signature, pinned key, bound operation/service/digest/reviewed source, isolation profile) passed.
 */
export function createBuiltAdmissionVerifier(): ProvenanceVerifier {
  return {
    name: "zenith.build-attestation",
    async verify(subject: ProvenanceSubject): Promise<ProvenanceVerdict> {
      if (subject.origin !== "built") return { verified: false, level: "none", reason: "only an image Zenith built carries a build attestation" };
      if (!subject.builtAdmission) return { verified: false, level: "none", reason: "no signed build provenance was admitted for this image" };
      try {
        const { evidenceRef } = await subject.builtAdmission();
        return { verified: true, level: "attested", evidenceRef, verifiedAt: new Date().toISOString() };
      } catch (e) {
        return { verified: false, level: "none", reason: `build provenance refused: ${scrub(e instanceof Error ? e.message : "error", 120)}` };
      }
    },
  };
}

/** LIFE-09's attestation verifier is registered here at composition (`createPlatformReleaseSafety`). Re-registering a name replaces it. */
export function registerProvenanceVerifier(verifier: ProvenanceVerifier): void {
  const g = globalThis as G;
  g.__zenithProvenanceVerifiers = [...(g.__zenithProvenanceVerifiers ?? []).filter((v) => v.name !== verifier.name), verifier];
}

export const registeredProvenanceVerifiers = (): readonly ProvenanceVerifier[] => (globalThis as G).__zenithProvenanceVerifiers ?? [];

/** Test isolation only. */
export function resetProvenanceVerifiersForTests(): void {
  delete (globalThis as G).__zenithProvenanceVerifiers;
}

/** The strongest verified verdict across `verifiers`, or an unverified verdict that names why. */
export async function verifyProvenance(subject: ProvenanceSubject, verifiers: readonly ProvenanceVerifier[]): Promise<ProvenanceVerdict> {
  let best: ProvenanceVerdict | undefined;
  const reasons: string[] = [];
  for (const v of verifiers) {
    try {
      const verdict = await v.verify(subject);
      if (verdict.verified && isProvenanceLevel(verdict.level) && verdict.level !== "none") {
        if (!best || RANK[verdict.level] > RANK[best.level]) best = { ...verdict, evidenceRef: verdict.evidenceRef ? scrub(verdict.evidenceRef, 200) : undefined };
      } else reasons.push(`${v.name}: ${scrub(verdict.reason ?? "not verified", 120)}`);
    } catch (e) {
      reasons.push(`${v.name}: verification failed (${scrub(e instanceof Error ? e.message : "error", 80)})`);
    }
  }
  return best ?? { verified: false, level: "none", reason: reasons.length ? reasons.join("; ") : "no provenance verifier is configured" };
}

/** Throw unless the verdict is verified at (at least) `minimum`. */
export function requireProvenance(verdict: ProvenanceVerdict, minimum: ProvenanceLevel, what: string): void {
  if (!verdict.verified || !meetsLevel(verdict.level, minimum)) {
    throw new ReleaseSafetyError(
      "provenance_unverified",
      `${what} has no verified provenance (needs ${minimum}, have ${verdict.verified ? verdict.level : "none"}${verdict.reason ? `: ${scrub(verdict.reason, 200)}` : ""}). Nothing was deployed.`
    );
  }
}
