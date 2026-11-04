/**
 * PROD-LIFE-09 / PROD-LIFE-10 join: signed build provenance is consumed by the release gate as the
 * `attested` verdict through ONE path (the admission the deploy step already ran), and an image Zenith
 * built can never be released on a weaker verdict than that, whatever the pinned-image floor is.
 */
import { describe, expect, it } from "vitest";
import {
  ReleaseSafetyService,
  createBuiltAdmissionVerifier,
  createMemoryReleaseStore,
  type BeginInput,
  type ProvenanceLevel,
  type ProvenanceVerifier,
} from "@/lib/release-safety";

const D = `sha256:${"a".repeat(64)}`;
const clock = () => new Date("2026-10-05T10:00:00.000Z");
let n = 0;
const buildRecord: ProvenanceVerifier = { name: "zenith.build-record", verify: async () => ({ verified: true, level: "build_record", evidenceRef: "evidence:rec" }) };
const base = (over: Partial<BeginInput> = {}): BeginInput => ({
  workspaceId: "ws-1", environmentId: "env-1", operationId: `op-${++n}`, serviceAddress: "container_service/web", provider: "gcp", nodeKind: "container_service",
  kind: "deploy", imageUri: `registry.example.test/web@${D}`, imageDigest: D, origin: "built", requestedBy: "alice", ...over,
});
const service = (floor: ProvenanceLevel) => {
  const store = createMemoryReleaseStore(clock);
  return new ReleaseSafetyService({
    store, clock, ids: () => `id${++n}`, verifiers: [buildRecord, createBuiltAdmissionVerifier()], minProvenance: floor,
    minProvenanceFor: (origin) => (origin === "built" && floor !== "attested" ? "attested" : floor),
  });
};

describe("built images are attested through the single admission path", () => {
  it("accepts a built image whose signed provenance admission resolved, and records the attested level", async () => {
    const run = await service("pinned_digest").begin(base({ builtAdmission: async () => ({ evidenceRef: "evidence:prov" }) }));
    expect(run.provenance).toMatchObject({ level: "attested", evidenceRef: "evidence:prov" });
  });

  it("refuses a built image with only a build record (no admission), even though the floor is pinned_digest", async () => {
    await expect(service("pinned_digest").begin(base())).rejects.toMatchObject({ code: "provenance_unverified" });
  });

  it("refuses a built image whose admission rejects; the build record cannot paper over it", async () => {
    const svc = service("pinned_digest");
    await expect(svc.begin(base({ builtAdmission: async () => { throw new Error("signature did not verify"); } }))).rejects.toMatchObject({ code: "provenance_unverified" });
  });

  it("holds a pinned image to the floor only: it has no attestation source", async () => {
    const run = await service("pinned_digest").begin(base({ origin: "pinned" }));
    expect(run.provenance.level).toBe("build_record");
    const verdict = await createBuiltAdmissionVerifier().verify({ workspaceId: "ws-1", environmentId: "env-1", operationId: "op", serviceAddress: "s", imageUri: `r@${D}`, imageDigest: D, origin: "pinned", builtAdmission: async () => ({ evidenceRef: "x" }) });
    expect(verdict.verified).toBe(false);
  });
});
