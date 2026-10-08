/**
 * PROD-LIFE-09 build provenance: SLSA-style statement, signature with a
 * control-plane style key, and verification before release admission. Pure.
 */
import { describe, expect, it } from "vitest";
import { BuildIsolationError } from "@/lib/execution/build-isolation";
import {
  BuildProvenanceError,
  IN_TOTO_STATEMENT_V1,
  PROVENANCE_TYP,
  SLSA_PROVENANCE_V1,
  buildProvenanceStatement,
  provenanceEvidenceDigest,
  signBuildProvenance,
  verifyBuildProvenance,
  type ProvenanceExpectation,
  type ProvenanceInput,
} from "@/lib/execution/build-provenance";
import { immutableSourceSnapshot } from "@/lib/execution/source-snapshot";
import { awsAttestation, newProvenanceKeys } from "./fakes/provenance";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const IMAGE = `sha256:${"9".repeat(64)}`;
const source = immutableSourceSnapshot({
  format: "zenith.approved-source.v1",
  workspaceId: "ws-1",
  operationId: "op-1",
  projectId: "proj-1",
  environmentId: "env-1",
  serviceAddress: "container_service/api",
  serviceSpecDigest: "1".repeat(64),
  pipelineAddress: "build_pipeline/api",
  pipelineSpecDigest: "2".repeat(64),
  provider: "aws",
  region: "us-east-1",
  owner: "acme",
  repo: "api",
  repositoryId: 101,
  requestedRef: "main",
  commitSha: "a".repeat(40),
  githubBinding: null,
  dockerfile: "Dockerfile",
  dockerfileDigest: "d".repeat(64),
  recipeDigest: "3".repeat(64),
  archiveFormat: "zip",
  archiveDigest: "5".repeat(64),
  archiveBytes: 100,
});
const input = (over: Partial<ProvenanceInput> = {}): ProvenanceInput => ({
  workspaceId: "ws-1",
  operationId: "op-1",
  environmentId: "env-1",
  provider: "aws",
  serviceAddress: "container_service/api",
  pipelineAddress: "build_pipeline/api",
  contextDir: ".",
  imageName: "123456789012.dkr.ecr.us-east-1.amazonaws.com/zenith-api",
  imageDigest: IMAGE,
  source,
  attestation: awsAttestation(),
  exceptions: [],
  ...over,
});
const expectation = (over: Partial<ProvenanceExpectation> = {}): ProvenanceExpectation => {
  const { workspaceId, operationId, environmentId, provider, serviceAddress, pipelineAddress, contextDir, imageDigest } = input();
  return { workspaceId, operationId, environmentId, provider, serviceAddress, pipelineAddress, contextDir, imageDigest, source, policy: { allowOpenEgress: false }, ...over };
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("provenance statement", () => {
  it("is an in-toto v1 statement with a SLSA provenance v1 predicate that names the subject, source, builder and isolation", () => {
    const s = buildProvenanceStatement(input());
    expect(s._type).toBe(IN_TOTO_STATEMENT_V1);
    expect(s.predicateType).toBe(SLSA_PROVENANCE_V1);
    expect(s.subject).toEqual([{ name: "123456789012.dkr.ecr.us-east-1.amazonaws.com/zenith-api", digest: { sha256: "9".repeat(64) } }]);
    const deps = s.predicate.buildDefinition.resolvedDependencies;
    expect(deps.find((d) => d.name === "source")).toMatchObject({ digest: { gitCommit: "a".repeat(40) } });
    expect(deps.find((d) => d.name === "source-archive")?.digest).toEqual({ sha256: "5".repeat(64) });
    expect(deps.find((d) => d.name === "dockerfile")?.digest).toEqual({ sha256: "d".repeat(64) });
    expect(deps.find((d) => d.name === "builder-image")).toMatchObject({ uri: "aws/codebuild/standard:7.0", digest: { unpinned: "tag-only" } });
    expect(s.predicate.runDetails.builder.id).toContain(":project/zenith-api");
    expect(s.predicate.runDetails.builder.version.attestor).toBe("zenith-control-plane-observed");
    expect(s.predicate.buildDefinition.internalParameters.isolation.identity.principal).toMatch(/-build$/);
  });

  it("pins a builder image that carries a digest", () => {
    const pinned = `gcr.io/cloud-builders/docker@sha256:${"c".repeat(64)}`;
    const s = buildProvenanceStatement(input({ attestation: { ...awsAttestation(), builderImage: pinned } }));
    expect(s.predicate.buildDefinition.resolvedDependencies.find((d) => d.name === "builder-image")?.digest).toEqual({ sha256: "c".repeat(64) });
  });

  it("refuses an attestation that does not form a valid statement", () => {
    expect(() => buildProvenanceStatement(input({ attestation: { ...awsAttestation(), builderId: "" } }))).toThrow(BuildProvenanceError);
  });

  it("derives a deterministic evidence digest from operation, service and image", () => {
    expect(provenanceEvidenceDigest("op-1", "container_service/api", IMAGE)).toBe(provenanceEvidenceDigest("op-1", "container_service/api", "9".repeat(64)));
    expect(provenanceEvidenceDigest("op-1", "container_service/api", IMAGE)).not.toBe(provenanceEvidenceDigest("op-2", "container_service/api", IMAGE));
  });
});

describe("signing and verification", () => {
  it("round-trips under the pinned key", async () => {
    const keys = newProvenanceKeys();
    const signed = await signBuildProvenance(keys.signerObject, input(), NOW);
    const out = await verifyBuildProvenance(signed.jws, expectation(), keys.publicKeys);
    expect(out.exceptions).toEqual([]);
    expect(out.claims).toMatchObject({ iss: "zenith-control", ws: "ws-1", op: "op-1", svc: "container_service/api", img: "9".repeat(64), sd: signed.statementDigest });
    expect(JSON.parse(Buffer.from(signed.jws.split(".")[0], "base64url").toString())).toMatchObject({ alg: "EdDSA", typ: PROVENANCE_TYP, kid: keys.signerObject.kid });
  });

  it("refuses a key that is not pinned", async () => {
    const keys = newProvenanceKeys();
    const other = newProvenanceKeys();
    const signed = await signBuildProvenance(keys.signerObject, input(), NOW);
    await expect(verifyBuildProvenance(signed.jws, expectation(), other.publicKeys)).rejects.toBeInstanceOf(BuildProvenanceError);
    await expect(verifyBuildProvenance(signed.jws, expectation(), [])).rejects.toBeInstanceOf(BuildProvenanceError);
  });

  it.each([
    ["a different image digest", { imageDigest: `sha256:${"8".repeat(64)}` }],
    ["a different workspace", { workspaceId: "ws-2" }],
    ["a different operation", { operationId: "op-2" }],
    ["a different environment", { environmentId: "env-2" }],
    ["a different service", { serviceAddress: "container_service/other" }],
    ["a different pipeline", { pipelineAddress: "build_pipeline/other" }],
    ["a different build context", { contextDir: "services/other" }],
    ["a different provider", { provider: "gcp" as const }],
    ["a different reviewed commit", { source: immutableSourceSnapshot({ ...source, commitSha: "b".repeat(40) }) }],
    ["a different source archive", { source: immutableSourceSnapshot({ ...source, archiveDigest: "6".repeat(64) }) }],
    ["a different Dockerfile", { source: immutableSourceSnapshot({ ...source, dockerfileDigest: "e".repeat(64) }) }],
    ["a different repository", { source: immutableSourceSnapshot({ ...source, repo: "other" }) }],
  ])("refuses a statement for %s, with one fixed message", async (_name, over) => {
    const keys = newProvenanceKeys();
    const signed = await signBuildProvenance(keys.signerObject, input(), NOW);
    const err = await verifyBuildProvenance(signed.jws, expectation(over as Partial<ProvenanceExpectation>), keys.publicKeys).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildProvenanceError);
    expect((err as Error).message).toBe("The build provenance does not verify; the artifact will not be released.");
  });

  it("refuses a tampered payload, a swapped signature and malformed tokens", async () => {
    const keys = newProvenanceKeys();
    const signed = await signBuildProvenance(keys.signerObject, input(), NOW);
    const [h, p, s] = signed.jws.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.img = "8".repeat(64);
    const signature = Buffer.from(s, "base64url");
    const tamperedSignature = Buffer.from(signature);
    tamperedSignature[0] ^= 1;
    expect(tamperedSignature.length).toBe(signature.length);
    expect(tamperedSignature.equals(signature)).toBe(false);
    const tamperedSignatureText = tamperedSignature.toString("base64url");
    expect(tamperedSignatureText).not.toBe(s);
    for (const bad of [`${h}.${b64(claims)}.${s}`, `${h}.${p}.${tamperedSignatureText}`, `${h}.${p}`, "", "a.b.c", `${h}.${p}.${s}.x`, undefined, 7]) {
      await expect(verifyBuildProvenance(bad, expectation(), keys.publicKeys)).rejects.toBeInstanceOf(BuildProvenanceError);
    }
  });

  it("refuses a token of another type or with embedded-key headers", async () => {
    const keys = newProvenanceKeys();
    const signed = await signBuildProvenance(keys.signerObject, input(), NOW);
    const payload = JSON.parse(Buffer.from(signed.jws.split(".")[1], "base64url").toString()) as Record<string, unknown>;
    for (const header of [{ typ: "zenith-runbook+jwt" }, { typ: PROVENANCE_TYP, crit: ["x"] }, { typ: PROVENANCE_TYP, jku: "https://evil.example/keys" }]) {
      const jws = await keys.signerObject.sign(header, payload);
      await expect(verifyBuildProvenance(jws, expectation(), keys.publicKeys)).rejects.toBeInstanceOf(BuildProvenanceError);
    }
  });

  it("refuses a statement whose digest was edited and re-signed without updating the bound digest", async () => {
    const keys = newProvenanceKeys();
    const signed = await signBuildProvenance(keys.signerObject, input(), NOW);
    const payload = JSON.parse(Buffer.from(signed.jws.split(".")[1], "base64url").toString()) as { stmt: { predicate: { buildDefinition: { externalParameters: { source: { commit: string } } } } } } & Record<string, unknown>;
    payload.stmt.predicate.buildDefinition.externalParameters.source.commit = "b".repeat(40);
    const jws = await keys.signerObject.sign({ typ: PROVENANCE_TYP }, payload);
    await expect(verifyBuildProvenance(jws, expectation(), keys.publicKeys)).rejects.toBeInstanceOf(BuildProvenanceError);
  });

  it("re-checks the isolation profile on the SIGNED observation", async () => {
    const keys = newProvenanceKeys();
    // a statement signed over an observation that violates the profile must still be refused at admission
    const bad = input({ attestation: awsAttestation({ filesystem: { sourceMount: "read_write" } }) });
    const signed = await signBuildProvenance(keys.signerObject, bad, NOW);
    await expect(verifyBuildProvenance(signed.jws, expectation(), keys.publicKeys)).rejects.toBeInstanceOf(BuildIsolationError);
  });

  it("admits open egress only when the statement records the exception AND the current policy allows it", async () => {
    const keys = newProvenanceKeys();
    const att = awsAttestation({ network: { egress: "unrestricted", mechanism: "none" }, dependencies: { downloads: "direct" } });
    const recorded = await signBuildProvenance(keys.signerObject, input({ attestation: att, exceptions: ["open_egress"] }), NOW);
    await expect(verifyBuildProvenance(recorded.jws, expectation({ policy: { allowOpenEgress: true } }), keys.publicKeys)).resolves.toMatchObject({ exceptions: ["open_egress"] });
    // the exception was revoked after the build: admission refuses it
    await expect(verifyBuildProvenance(recorded.jws, expectation({ policy: { allowOpenEgress: false } }), keys.publicKeys)).rejects.toBeInstanceOf(BuildIsolationError);
    // a statement that hides the exception does not verify under a policy that would add it
    const hidden = await signBuildProvenance(keys.signerObject, input({ attestation: att, exceptions: [] }), NOW);
    await expect(verifyBuildProvenance(hidden.jws, expectation({ policy: { allowOpenEgress: true } }), keys.publicKeys)).rejects.toBeInstanceOf(BuildProvenanceError);
  });

  it("refuses to sign with a key that is not EdDSA", async () => {
    const keys = newProvenanceKeys();
    const rsaLike = { ...keys.signerObject, alg: "RS256" as const, kid: keys.signerObject.kid, publicJwk: keys.signerObject.publicJwk.bind(keys.signerObject), sign: keys.signerObject.sign.bind(keys.signerObject) };
    await expect(signBuildProvenance(rsaLike, input(), NOW)).rejects.toBeInstanceOf(BuildProvenanceError);
  });
});
