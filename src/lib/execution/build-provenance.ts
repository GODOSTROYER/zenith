/**
 * Build provenance (PROD-LIFE-09).
 *
 * Every artifact built from customer source gets a SLSA v1 style provenance
 * statement (in-toto Statement v1, predicateType https://slsa.dev/provenance/v1)
 * that records WHAT was built (subject: the image digest), FROM WHAT (resolved
 * dependencies: the approved source commit, the source archive digest, the
 * Dockerfile digest, the toolchain image), BY WHOM (builder id and the
 * dedicated build identity) and UNDER WHICH ISOLATION (the observed profile).
 *
 * The statement is signed as a compact JWS (`typ: zenith-build-provenance+jwt`,
 * `alg: EdDSA`) with the control-plane key already used for capability grants
 * and runbooks (`getControlSigner`). Honest trust level: the attestor is the
 * control plane. It signs only facts the provider adapter read back from the
 * provider's own API after the build; the cloud builder does not co-sign (the
 * statement says so in `builder.version.attestor`). The signature protects the
 * record from later edits; it does not turn a compromised provider API into
 * truth.
 *
 * Release admission (`admitBuiltArtifact`) re-verifies the signature against
 * PINNED public keys, re-derives every bound claim from the REVIEWED approved
 * source snapshot and the operation, and re-runs the isolation profile check
 * before a workload is pointed at the image. Header rules mirror capability
 * grants and runbooks: EdDSA only, a pinned `kid`, no embedded-key headers.
 */
import { createPublicKey } from "node:crypto";
import { compactVerify } from "jose";
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import type { JwtSigner, PublicJwk } from "@/lib/credentials/signing/types";
import type { ApprovedSourceSnapshot } from "./source-snapshot";
import { allowlistDigest, assertBuildIsolation, BUILD_ISOLATION_PROFILES, type BuildAttestation, type BuildIsolationPolicy, type BuildProviderKey, type ObservedBuildIsolation } from "./build-isolation";

export const PROVENANCE_TYP = "zenith-build-provenance+jwt";
export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
export const ZENITH_BUILD_TYPE = "https://tryzenith.cloud/build/isolated-source/v1";
export const PROVENANCE_ATTESTOR = "zenith-control-plane-observed";
const B64U = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_HEADERS = ["jwk", "jku", "x5u", "x5c", "x5t", "x5t#S256", "crit"] as const;
const MAX_JWS_BYTES = 16 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;

export class BuildProvenanceError extends Error {
  readonly code = "build_provenance_invalid";
  constructor(message = "The build provenance does not verify; the artifact will not be released.") {
    super(message);
    this.name = "BuildProvenanceError";
  }
}
// One fixed message for every signature/claim failure: a refusal never tells a forger which check failed.
const fail = (): never => {
  throw new BuildProvenanceError();
};

/* -------------------------------- statement -------------------------------- */

const Isolation = z
  .object({
    profileId: z.string().max(80),
    identity: z.object({ principal: z.string().max(400), dedicated: z.boolean(), deployCredentials: z.enum(["absent", "present", "unknown"]) }).strict(),
    metadata: z.object({ exposes: z.enum(["none", "build_identity_only", "unknown"]), mechanism: z.string().max(400) }).strict(),
    network: z.object({ egress: z.enum(["allowlisted", "unrestricted"]), verifiedBy: z.enum(["provider_read", "compile_binding"]).optional(), allowlistDigest: z.string().regex(HEX64).optional(), mechanism: z.string().max(400) }).strict(),
    dependencies: z.object({ downloads: z.enum(["allowlisted", "direct"]) }).strict(),
    filesystem: z.object({ sourceMount: z.enum(["read_only", "read_write"]) }).strict(),
    resources: z.object({ timeoutSec: z.number().int(), computeClass: z.string().max(80) }).strict(),
  })
  .strict();

const Dep = z.object({ name: z.string().max(80), uri: z.string().max(500).optional(), digest: z.record(z.string(), z.string().max(130)) }).strict();

export const StatementSchema = z
  .object({
    _type: z.literal(IN_TOTO_STATEMENT_V1),
    subject: z.array(z.object({ name: z.string().max(500), digest: z.object({ sha256: z.string().regex(HEX64) }).strict() }).strict()).length(1),
    predicateType: z.literal(SLSA_PROVENANCE_V1),
    predicate: z
      .object({
        buildDefinition: z
          .object({
            buildType: z.literal(ZENITH_BUILD_TYPE),
            externalParameters: z
              .object({
                provider: z.enum(["aws", "gcp", "azure", "zenith"]),
                service: z.string().max(200),
                pipeline: z.string().max(200),
                source: z.object({ repository: z.string().max(200), ref: z.string().max(250), commit: z.string().regex(/^[a-f0-9]{40}$/), dockerfile: z.string().max(200), contextDir: z.string().max(200), contextDigest: z.string().regex(HEX64).optional() }).strict(),
              })
              .strict(),
            internalParameters: z.object({ workspaceId: z.string().max(200), operationId: z.string().max(200), environmentId: z.string().max(200), isolation: Isolation, exceptions: z.array(z.string().max(60)).max(8) }).strict(),
            resolvedDependencies: z.array(Dep).min(3).max(12),
          })
          .strict(),
        runDetails: z
          .object({
            builder: z.object({ id: z.string().min(1).max(500), version: z.object({ attestor: z.literal(PROVENANCE_ATTESTOR), profile: z.string().max(80) }).strict() }).strict(),
            metadata: z.object({ invocationId: z.string().min(1).max(300), startedOn: z.string().max(40).optional(), finishedOn: z.string().max(40).optional() }).strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type ProvenanceStatement = z.infer<typeof StatementSchema>;

export interface ProvenanceInput {
  workspaceId: string;
  operationId: string;
  environmentId: string;
  provider: BuildProviderKey;
  serviceAddress: string;
  pipelineAddress: string;
  /** validated build context subdirectory ("." for the repository root) */
  contextDir: string;
  /** the inspection digest that admitted a non-root `contextDir` (absent for the repository root) */
  contextDigest?: string;
  /** registry path without tag or digest, e.g. `123.dkr.ecr.us-east-1.amazonaws.com/web` */
  imageName: string;
  imageDigest: string;
  source: ApprovedSourceSnapshot;
  attestation: BuildAttestation;
  exceptions: readonly string[];
}

const hex = (d: string): string => d.replace(/^sha256:/, "");

export function buildProvenanceStatement(i: ProvenanceInput): ProvenanceStatement {
  const s = i.source;
  const deps: z.infer<typeof Dep>[] = [
    { name: "source", uri: `git+https://github.com/${s.owner}/${s.repo}@${s.requestedRef}`, digest: { gitCommit: s.commitSha } },
    { name: "source-archive", digest: { sha256: s.archiveDigest } },
    { name: "dockerfile", uri: s.dockerfile, digest: { sha256: s.dockerfileDigest } },
  ];
  if (i.attestation.builderImage) {
    const m = /@sha256:([a-f0-9]{64})$/.exec(i.attestation.builderImage);
    deps.push({ name: "builder-image", uri: i.attestation.builderImage, digest: m ? { sha256: m[1] } : { unpinned: "tag-only" } });
  }
  const statement: ProvenanceStatement = {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: i.imageName, digest: { sha256: hex(i.imageDigest) } }],
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType: ZENITH_BUILD_TYPE,
        externalParameters: { provider: i.provider, service: i.serviceAddress, pipeline: i.pipelineAddress, source: { repository: `${s.owner}/${s.repo}`, ref: s.requestedRef, commit: s.commitSha, dockerfile: s.dockerfile, contextDir: i.contextDir, ...(i.contextDigest ? { contextDigest: i.contextDigest } : {}) } },
        internalParameters: { workspaceId: i.workspaceId, operationId: i.operationId, environmentId: i.environmentId, isolation: i.attestation.isolation as ObservedBuildIsolation, exceptions: [...i.exceptions] },
        resolvedDependencies: deps,
      },
      runDetails: {
        builder: { id: i.attestation.builderId, version: { attestor: PROVENANCE_ATTESTOR, profile: BUILD_ISOLATION_PROFILES[i.provider].id } },
        metadata: { invocationId: i.attestation.invocationId, ...(i.attestation.startedOn ? { startedOn: i.attestation.startedOn } : {}), ...(i.attestation.finishedOn ? { finishedOn: i.attestation.finishedOn } : {}) },
      },
    },
  };
  const parsed = StatementSchema.safeParse(statement);
  if (!parsed.success) throw new BuildProvenanceError("The provider's build attestation is not a well-formed provenance input.");
  return parsed.data;
}

/** Deterministic evidence digest an admission can recompute from the operation, service and image. */
export const provenanceEvidenceDigest = (operationId: string, serviceAddress: string, imageDigest: string): string => digest({ kind: "build.provenance", operationId, service: serviceAddress, image: hex(imageDigest) });

/* ---------------------------------- claims --------------------------------- */

const ClaimsSchema = z
  .object({
    iss: z.literal("zenith-control"),
    ws: z.string().min(1).max(200),
    op: z.string().min(1).max(200),
    svc: z.string().min(1).max(200),
    img: z.string().regex(HEX64),
    sd: z.string().regex(HEX64),
    stmt: StatementSchema,
    iat: z.number().int().min(0),
  })
  .strict();
export type ProvenanceClaims = z.infer<typeof ClaimsSchema>;

export interface SignedProvenance {
  jws: string;
  kid: string;
  statementDigest: string;
  statement: ProvenanceStatement;
}

export async function signBuildProvenance(signer: JwtSigner, input: ProvenanceInput, now: Date): Promise<SignedProvenance> {
  if (signer.alg !== "EdDSA") throw new BuildProvenanceError("Build provenance must be signed with the EdDSA control-plane key.");
  const statement = buildProvenanceStatement(input);
  const statementDigest = digest(statement);
  const claims: ProvenanceClaims = { iss: "zenith-control", ws: input.workspaceId, op: input.operationId, svc: input.serviceAddress, img: hex(input.imageDigest), sd: statementDigest, stmt: statement, iat: Math.floor(now.getTime() / 1000) };
  const jws = await signer.sign({ typ: PROVENANCE_TYP }, claims as unknown as Record<string, unknown>);
  return { jws, kid: signer.kid, statementDigest, statement };
}

/* -------------------------------- verification ----------------------------- */

export interface ProvenanceExpectation {
  workspaceId: string;
  operationId: string;
  environmentId: string;
  provider: BuildProviderKey;
  serviceAddress: string;
  pipelineAddress: string;
  contextDir: string;
  contextDigest?: string;
  imageDigest: string;
  /** the REVIEWED approved source snapshot for this service */
  source: ApprovedSourceSnapshot;
  policy: BuildIsolationPolicy;
}

/**
 * Throws `BuildProvenanceError` unless the JWS verifies under a pinned key AND
 * every claim is exactly what the reviewed operation expects. Throws
 * `BuildIsolationError` when the signed observation violates the profile.
 */
export async function verifyBuildProvenance(jws: unknown, expected: ProvenanceExpectation, keys: readonly PublicJwk[]): Promise<{ claims: ProvenanceClaims; exceptions: string[] }> {
  if (typeof jws !== "string" || jws.length === 0 || jws.length > MAX_JWS_BYTES) return fail();
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && B64U.test(p))) return fail();
  let header: Record<string, unknown>;
  try {
    const h: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!h || typeof h !== "object" || Array.isArray(h)) return fail();
    header = h as Record<string, unknown>;
  } catch {
    return fail();
  }
  if (header.alg !== "EdDSA" || header.typ !== PROVENANCE_TYP || typeof header.kid !== "string" || !header.kid) return fail();
  if (FORBIDDEN_HEADERS.some((h) => h in header)) return fail();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return fail();
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(jws, createPublicKey({ key: jwk as never, format: "jwk" }), { algorithms: ["EdDSA"] }));
  } catch {
    return fail();
  }
  let claims: ProvenanceClaims;
  try {
    const parsed = ClaimsSchema.safeParse(JSON.parse(Buffer.from(payload).toString("utf8")));
    if (!parsed.success) return fail();
    claims = parsed.data;
  } catch {
    return fail();
  }
  const s = expected.source;
  const stmt = claims.stmt;
  const bd = stmt.predicate.buildDefinition;
  const dep = (name: string) => bd.resolvedDependencies.filter((d) => d.name === name);
  const [src, archive, dockerfile] = [dep("source"), dep("source-archive"), dep("dockerfile")];
  if (
    claims.ws !== expected.workspaceId ||
    claims.op !== expected.operationId ||
    claims.svc !== expected.serviceAddress ||
    claims.img !== hex(expected.imageDigest) ||
    claims.sd !== digest(stmt) ||
    stmt.subject[0].digest.sha256 !== claims.img ||
    bd.internalParameters.workspaceId !== expected.workspaceId ||
    bd.internalParameters.operationId !== expected.operationId ||
    bd.internalParameters.environmentId !== expected.environmentId ||
    bd.externalParameters.provider !== expected.provider ||
    bd.externalParameters.service !== expected.serviceAddress ||
    bd.externalParameters.pipeline !== expected.pipelineAddress ||
    bd.externalParameters.source.commit !== s.commitSha ||
    bd.externalParameters.source.repository !== `${s.owner}/${s.repo}` ||
    bd.externalParameters.source.dockerfile !== s.dockerfile ||
    bd.externalParameters.source.contextDir !== expected.contextDir ||
    bd.externalParameters.source.contextDigest !== expected.contextDigest ||
    src.length !== 1 ||
    src[0].digest.gitCommit !== s.commitSha ||
    archive.length !== 1 ||
    archive[0].digest.sha256 !== s.archiveDigest ||
    dockerfile.length !== 1 ||
    dockerfile[0].digest.sha256 !== s.dockerfileDigest ||
    stmt.predicate.runDetails.builder.version.profile !== BUILD_ISOLATION_PROFILES[expected.provider].id
  ) {
    return fail();
  }
  const { exceptions } = assertBuildIsolation(expected.provider, bd.internalParameters.isolation as ObservedBuildIsolation, expected.policy);
  // The exceptions the statement records must be exactly the ones the current policy admits for this observation.
  if (digest([...bd.internalParameters.exceptions].sort()) !== digest([...exceptions].sort())) return fail();
  return { claims, exceptions };
}

/** Attestation helper for adapters that bind an allowlist by digest. */
export { allowlistDigest };
