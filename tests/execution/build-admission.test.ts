/**
 * PROD-LIFE-09 through the real release activities: a build is isolated and
 * attested by its provider, signed provenance is retained as evidence, and
 * deployWorkloads admits a built image only when that provenance verifies.
 * Ports are scripted fakes; the signing key is generated per test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { StepFailedError } from "@/lib/execution/errors";
import { PROVENANCE_TYP, provenanceEvidenceDigest, verifyBuildProvenance } from "@/lib/execution/build-provenance";
import { ENV, OP, PROJECT, WS, builtManifest } from "./fakes/fixtures";
import { awsAttestation, newProvenanceKeys } from "./fakes/provenance";
import { createWorld, type World } from "./fakes/world";

const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

async function built(attestation: ReturnType<typeof awsAttestation> | null = awsAttestation()) {
  const w = createWorld();
  worlds.push(w);
  w.product.setManifest(builtManifest());
  w.build.result = { ...w.build.result, attestation: attestation ?? undefined };
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  await w.activities.planInfrastructure({ operationId: OP, lease });
  w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-review" };
  return { w, lease };
}
const provenanceRows = (w: World) => w.evidence.ofKind("build").filter((r) => r.summary.kind === "build.provenance");
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;

describe("isolated build provenance in the release path", () => {
  it("signs provenance after an isolated build, retains it as critical evidence and admits the rollout", async () => {
    const { w, lease } = await built();
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    const [row] = provenanceRows(w);
    expect(row.digest).toBe(provenanceEvidenceDigest(OP, "container_service/api", IMAGE_DIGEST));
    expect(row.simulated).toBe(false);
    expect(row.summary).toMatchObject({ service: "container_service/api", imageDigest: IMAGE_DIGEST, sourceDigest: "5".repeat(64), commit: "a".repeat(40), exceptions: [] });
    // the evidence store refuses JWT-shaped values, so the token is kept as its three segments and never as one string
    expect(row.summary).not.toHaveProperty("jws");
    expect((row.summary.jwsParts as string[]).length).toBe(3);
    const jws = (row.summary.jwsParts as string[]).join(".");
    expect(JSON.parse(Buffer.from(jws.split(".")[0], "base64url").toString())).toMatchObject({ typ: PROVENANCE_TYP, alg: "EdDSA" });
    const claims = JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString());
    expect(claims.stmt.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(claims.stmt.subject[0].digest.sha256).toBe("9".repeat(64));

    const deployed = await w.activities.deployWorkloads({ operationId: OP, lease, images: out.images });
    expect(deployed).toEqual({ services: 1 });
    expect(w.workloads.deployed).toHaveLength(1);
  });

  it("refuses a build whose provider returned no isolation attestation, and records no provenance", async () => {
    const { w, lease } = await built(null);
    const err = await w.activities.buildArtifacts({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/no isolation attestation/);
    expect(provenanceRows(w)).toHaveLength(0);
  });

  it.each([
    ["the build ran under a role that is not a build role", { identity: { principal: "arn:aws:iam::123456789012:role/zenith-deploy", dedicated: true, deployCredentials: "absent" as const } }, /not a build role/],
    ["the source mount was writable", { filesystem: { sourceMount: "read_write" as const } }, /read-only/],
    ["the build ran past the timeout bound", { resources: { timeoutSec: 7200, computeClass: "BUILD_GENERAL1_MEDIUM" } }, /timeout/],
    ["the build had unrestricted egress", { network: { egress: "unrestricted" as const, mechanism: "none" }, dependencies: { downloads: "direct" as const } }, /egress was not restricted/],
  ])("refuses to release an artifact when %s", async (_name, override, message) => {
    const { w, lease } = await built(awsAttestation(override));
    const err = await w.activities.buildArtifacts({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(message);
    expect((err as Error).message).toMatch(/Nothing will be deployed/);
    expect(provenanceRows(w)).toHaveLength(0);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("admits unrestricted egress only under the recorded operator exception", async () => {
    const { w, lease } = await built(awsAttestation({ network: { egress: "unrestricted", mechanism: "none" }, dependencies: { downloads: "direct" } }));
    w.deps.buildIsolation = { allowOpenEgress: true };
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    expect(provenanceRows(w)[0].summary.exceptions).toEqual(["open_egress"]);
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: out.images })).resolves.toEqual({ services: 1 });
    // revoking the exception afterwards makes admission refuse the already built artifact
    w.deps.buildIsolation = { allowOpenEgress: false };
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: out.images })).rejects.toThrow(/egress was not restricted|will not be released/);
  });

  it("refuses to build or release without a provenance signer", async () => {
    const { w, lease } = await built();
    delete (w.deps as { provenance?: unknown }).provenance;
    await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/no build provenance signer/);
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: [{ service: "container_service/api", imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/zenith-api@${IMAGE_DIGEST}`, digest: IMAGE_DIGEST }] })).rejects.toThrow(/not configured/);
    expect(w.workloads.deployed).toHaveLength(0);
  });
});

describe("release admission", () => {
  it("refuses a built image that has no provenance evidence", async () => {
    const { w, lease } = await built();
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    const at = w.evidence.rows.findIndex((r) => r.summary.kind === "build.provenance");
    w.evidence.rows.splice(at, 1);
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: out.images })).rejects.toThrow(/no build provenance/);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("refuses an image whose digest differs from the one the provenance covers", async () => {
    const { w, lease } = await built();
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    const swapped = `sha256:${"7".repeat(64)}`;
    const images = [{ ...out.images[0], digest: swapped, imageUri: out.images[0].imageUri.replace(IMAGE_DIGEST, swapped) }];
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("refuses provenance edited after signing", async () => {
    const { w, lease } = await built();
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    const row = w.evidence.rows.find((r) => r.summary.kind === "build.provenance")!;
    const parts = [...(row.summary.jwsParts as string[])];
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    claims.stmt.predicate.buildDefinition.externalParameters.source.commit = "b".repeat(40);
    parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
    row.summary = { ...row.summary, jwsParts: parts };
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: out.images })).rejects.toThrow(/does not verify/);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("refuses provenance that is malformed storage (not exactly three segments)", async () => {
    const { w, lease } = await built();
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    const row = w.evidence.rows.find((r) => r.summary.kind === "build.provenance")!;
    row.summary = { ...row.summary, jwsParts: ["only", "two"] };
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: out.images })).rejects.toThrow(/does not verify/);
  });

  it("refuses provenance signed by a key that is not pinned", async () => {
    const { w, lease } = await built();
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    const rotated = newProvenanceKeys();
    w.deps.provenance = { signer: rotated.signer, keys: rotated.keys };
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: out.images })).rejects.toThrow(/does not verify/);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("verifies against the reviewed source snapshot the store holds, not anything the workflow supplies", async () => {
    const { w, lease } = await built();
    const out = await w.activities.buildArtifacts({ operationId: OP, lease });
    const [snapshot] = await w.deps.sourceSnapshots!.list({ workspaceId: WS, operationId: OP, projectId: PROJECT, environmentId: ENV });
    const row = provenanceRows(w)[0];
    // the same token verifies against the stored snapshot ...
    await expect(verifyBuildProvenance((row.summary.jwsParts as string[]).join("."), {
      workspaceId: snapshot.workspaceId, operationId: OP, environmentId: snapshot.environmentId, provider: "aws", serviceAddress: "container_service/api", pipelineAddress: "build_pipeline/api", contextDir: ".", imageDigest: IMAGE_DIGEST, source: snapshot, policy: { allowOpenEgress: false },
    }, await w.provenance.keys())).resolves.toBeDefined();
    expect(out.images).toHaveLength(1);
  });
});

