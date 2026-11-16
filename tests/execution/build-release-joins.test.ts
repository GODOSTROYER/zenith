/**
 * LIFE-08 -> LIFE-09 -> LIFE-10 composition over genuine inspection, context admission,
 * signed provenance and platform release safety. GitHub HTTP and build/workload providers
 * are controlled ports; operation/approval ports use the existing isolated execution fixture.
 * PGlite supplies the canonical source/release stores. No live GitHub, cloud build or rollout.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as evidenceRepo from "@/lib/controlplane/db/repos/evidence";
import * as buildProvenance from "@/lib/execution/build-provenance";
import { createBuildRecordVerifier, createPlatformReleaseSafety } from "@/lib/platform/release-safety";
import { registeredProvenanceVerifiers, resetProvenanceVerifiersForTests } from "@/lib/release-safety/provenance";
import { createGithubContextVerifier, createGithubSourceInspector } from "@/lib/sources/github/inspect";
import { ENV, OP, WS, builtManifest } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const COMMIT = "a".repeat(40);
const APPS_TREE = "1".repeat(40);
const API_TREE = "2".repeat(40);
const DOCKERFILE_BLOB = "4".repeat(40);
const CONTEXT = "apps/api";
const DOCKERFILE = `${CONTEXT}/Dockerfile`;
const SERVICE = "container_service/api";
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const PINNED_DIGEST = `sha256:${"8".repeat(64)}`;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** A bounded source archive for the real static inspector; no source code is executed. */
function archive(): Buffer {
  const blocks: Buffer[] = [];
  const files: [string, string][] = [
    ["repo/", ""],
    [`repo/${DOCKERFILE}`, "FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD [\"node\",\"index.js\"]\n"],
    [`repo/${CONTEXT}/package.json`, JSON.stringify({ name: "api", scripts: { start: "node index.js" } })],
  ];
  for (const [name, text] of files) {
    const body = Buffer.from(text), header = Buffer.alloc(512), directory = name.endsWith("/");
    header.write(name, 0, 100, "utf8");
    header.write((directory ? "0000755" : "0000644") + "\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii"); header.write("0000000\0", 116, 8, "ascii");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii"); header.fill(" ", 148, 156);
    header.write(directory ? "5" : "0", 156, 1, "ascii"); header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

let db: PlatformDbHandle;
const worlds: World[] = [];
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite", migrate: true }); }, 60_000);
afterAll(async () => { await db?.close(); });
afterEach(() => {
  vi.restoreAllMocks();
  resetProvenanceVerifiersForTests();
  while (worlds.length) worlds.pop()!.dispose();
});

function github() {
  const requests: { url: string; authorization: string | null }[] = [];
  let dockerfileBlob = DOCKERFILE_BLOB;
  const entry = (path: string, type: "tree" | "blob", sha: string) => ({ path, type, sha, mode: type === "tree" ? "040000" : "100644" });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url === "https://api.github.com/repos/acme/api") return json({ id: 101, name: "api", private: false, owner: { login: "acme" } });
    if (url === "https://api.github.com/repos/acme/api/commits/main" || url === `https://api.github.com/repos/acme/api/commits/${COMMIT}`) return new Response(COMMIT);
    if (url === `https://codeload.github.com/acme/api/tar.gz/${COMMIT}`) return new Response(new Uint8Array(archive()));
    const prefix = "https://api.github.com/repos/acme/api/git/trees/";
    if (url === prefix + COMMIT) return json({ truncated: false, tree: [entry("apps", "tree", APPS_TREE)] });
    if (url === prefix + APPS_TREE) return json({ truncated: false, tree: [entry("api", "tree", API_TREE)] });
    if (url === prefix + API_TREE) return json({ truncated: false, tree: [entry("Dockerfile", "blob", dockerfileBlob)] });
    throw new Error("Unexpected controlled GitHub request.");
  });
  const deps = { db: async () => db, fetchImpl, env: {} };
  return {
    requests,
    inspect: createGithubSourceInspector(deps),
    verify: createGithubContextVerifier(deps),
    changeDockerfile: () => { dockerfileBlob = "6".repeat(40); },
  };
}

async function inspected() {
  const source = github();
  const result = await source.inspect({ workspaceId: WS, environmentId: ENV, owner: "acme", repo: "api", ref: "main", root: CONTEXT });
  expect(result.execution).toBe("static_only");
  expect(result.viaBinding).toBe(false);
  expect(result.buildSource).toBeDefined();
  const buildSource = result.buildSource!;
  // Independent expected binding: no expected value is obtained from the context verifier.
  const expected = createHash("sha256").update(JSON.stringify({ repo: "acme/api", commit: COMMIT, contextDir: CONTEXT, contextTree: API_TREE, dockerfile: DOCKERFILE, dockerfileBlob: DOCKERFILE_BLOB })).digest("hex");
  expect(buildSource).toEqual({ repo: "acme/api", ref: COMMIT, dockerfile: DOCKERFILE, contextDir: CONTEXT, contextDigest: expected });
  return { source, buildSource };
}

async function ready(buildSource: { repo: string; ref: string; dockerfile: string; contextDir: string; contextDigest?: string }, source: ReturnType<typeof github>) {
  const safety = createPlatformReleaseSafety(db, {});
  const w = createWorld({ releaseSafety: safety });
  worlds.push(w);
  const manifest = builtManifest();
  manifest.services[0].source = { type: "git", ...buildSource };
  w.product.setManifest(manifest);
  w.deps.sourceContext = source.verify;
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  await w.activities.planInfrastructure({ operationId: OP, lease });
  w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-review" };
  return { w, lease, safety };
}

function noBuild(w: World) {
  expect(w.sourceBundle.calls).toHaveLength(0);
  expect(w.build.started).toHaveLength(0);
  expect(w.evidence.ofKind("build")).toHaveLength(0);
  expect(w.workloads.deployed).toHaveLength(0);
}

describe("inspected source to signed build to release safety", () => {
  it("re-derives the inspected context before build and consumes signed provenance once as an attested release verdict", async () => {
    const { source, buildSource } = await inspected();
    const { w, lease, safety } = await ready(buildSource, source);
    const beforeBuild = source.requests.length;
    const order: string[] = [];
    w.deps.sourceContext = async input => {
      const admitted = await source.verify(input);
      if (admitted) order.push("context-admitted");
      return admitted;
    };
    const prepare = w.sourceBundle.prepare.bind(w.sourceBundle);
    vi.spyOn(w.sourceBundle, "prepare").mockImplementation(async (...args) => {
      expect(order).toEqual(["context-admitted"]);
      order.push("source-prepared");
      return prepare(...args);
    });
    const startBuild = w.build.startBuild.bind(w.build);
    const start = vi.spyOn(w.build, "startBuild").mockImplementation(async (...args) => {
      expect(order).toEqual(["context-admitted", "source-prepared"]);
      order.push("build-started");
      return startBuild(...args);
    });
    const output = await w.activities.buildArtifacts({ operationId: OP, lease });
    const admissionRequests = source.requests.slice(beforeBuild);
    expect(admissionRequests.map(r => r.url)).toContain(`https://api.github.com/repos/acme/api/commits/${COMMIT}`);
    expect(admissionRequests.filter(r => r.url.endsWith(`/git/trees/${API_TREE}`))).toHaveLength(2);
    expect(start).toHaveBeenCalledOnce();
    expect(order).toEqual(["context-admitted", "source-prepared", "build-started"]);
    expect(w.sourceBundle.calls).toHaveLength(1);
    const [signed] = w.evidence.ofKind("build").filter(row => row.summary.kind === "build.provenance");
    expect(signed.summary).toMatchObject({ imageDigest: IMAGE_DIGEST, sourceDigest: "5".repeat(64), commit: COMMIT });
    const claims = JSON.parse(Buffer.from((signed.summary.jwsParts as string[])[1], "base64url").toString());
    expect(claims.stmt.predicate.buildDefinition.externalParameters.source).toMatchObject({ contextDir: CONTEXT, contextDigest: buildSource.contextDigest });
    const keys = vi.spyOn(w.deps.provenance!, "keys");
    const verifySignature = vi.spyOn(buildProvenance, "verifyBuildProvenance");
    const attestation = registeredProvenanceVerifiers().find(v => v.name === "zenith.build-attestation")!;
    const consumed = vi.spyOn(attestation, "verify");
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: output.images })).resolves.toEqual({ services: 1 });
    expect(keys).toHaveBeenCalledOnce();
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(verifySignature.mock.calls[0][1]).toMatchObject({ contextDir: CONTEXT, contextDigest: buildSource.contextDigest, source: { commitSha: COMMIT, archiveDigest: "5".repeat(64), dockerfile: DOCKERFILE } });
    expect(consumed).toHaveBeenCalledOnce();
    expect(consumed.mock.calls[0][0]).toMatchObject({ origin: "built", imageDigest: IMAGE_DIGEST });
    const [run] = await safety.list(WS, { operationId: OP });
    expect(run).toMatchObject({ state: "deployed", imageDigest: IMAGE_DIGEST, provenance: { level: "attested", evidenceRef: `evidence:${signed.id}` } });
    expect((await safety.events(WS, run.id)).map(event => event.to)).toEqual(["planned", "built", "verified", "deployed"]);
    expect(w.workloads.deployed).toHaveLength(1);
    expect(source.requests.every(request => request.authorization === null)).toBe(true);
  });

  it("refuses a mismatched inspection digest before preparing source or starting a build", async () => {
    const { source, buildSource } = await inspected();
    const { w, lease } = await ready({ ...buildSource, contextDigest: "0".repeat(64) }, source);
    await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/does not match what source inspection reported/);
    noBuild(w);
  });

  it("refuses a different context directory paired with the inspected digest before build", async () => {
    const { source, buildSource } = await inspected();
    const { w, lease } = await ready({ ...buildSource, contextDir: "apps/other" }, source);
    await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/does not match what source inspection reported/);
    noBuild(w);
  });

  it("refuses a non-inspected subdirectory without a digest before context access or build", async () => {
    const { source, buildSource } = await inspected();
    const uninspected = { repo: buildSource.repo, ref: buildSource.ref, dockerfile: buildSource.dockerfile, contextDir: buildSource.contextDir };
    const { w, lease } = await ready(uninspected, source);
    const before = source.requests.length;
    await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/without the digest source inspection returns/);
    expect(source.requests).toHaveLength(before);
    noBuild(w);
  });

  it("rechecks the pinned Dockerfile blob and refuses changed tree evidence before build", async () => {
    const { source, buildSource } = await inspected();
    const { w, lease } = await ready(buildSource, source);
    source.changeDockerfile();
    await expect(w.activities.buildArtifacts({ operationId: OP, lease })).rejects.toThrow(/does not match what source inspection reported/);
    noBuild(w);
  });

  it("refuses tampered signed provenance before the release gate or any rollout", async () => {
    const { source, buildSource } = await inspected();
    const { w, lease, safety } = await ready(buildSource, source);
    const output = await w.activities.buildArtifacts({ operationId: OP, lease });
    const releasesBefore = await safety.list(WS, { operationId: OP });
    const signed = w.evidence.ofKind("build").find(row => row.summary.kind === "build.provenance")!;
    const parts = [...signed.summary.jwsParts as string[]];
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    claims.stmt.predicate.buildDefinition.externalParameters.source.contextDigest = "0".repeat(64);
    parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
    signed.summary = { ...signed.summary, jwsParts: parts };
    await expect(w.activities.deployWorkloads({ operationId: OP, lease, images: output.images })).rejects.toThrow(/does not verify/);
    expect(w.workloads.deployed).toHaveLength(0);
    expect(await safety.list(WS, { operationId: OP })).toEqual(releasesBefore);
  });
});

describe("platform provenance floors at the build and release join", () => {
  it("refuses an unattested Zenith-built image even when a genuine build-record verifier accepts its evidence", async () => {
    const subject = { workspaceId: WS, environmentId: ENV, operationId: "op-join-unattested", serviceAddress: SERVICE, imageUri: `ghcr.io/acme/api@${IMAGE_DIGEST}`, imageDigest: IMAGE_DIGEST, sourceDigest: "5".repeat(64), origin: "built" as const };
    const record = await evidenceRepo.insert(db, { workspaceId: WS, operationId: subject.operationId, kind: "build", digest: "3".repeat(64), summary: { service: SERVICE, imageDigest: IMAGE_DIGEST, sourceDigest: subject.sourceDigest }, simulated: false });
    await expect(createBuildRecordVerifier(db).verify(subject)).resolves.toMatchObject({ verified: true, level: "build_record", evidenceRef: `evidence:${record.id}` });
    const safety = createPlatformReleaseSafety(db, {});
    await expect(safety.begin({ ...subject, kind: "deploy", provider: "aws", nodeKind: "container_service", requestedBy: "human-join" })).rejects.toMatchObject({ code: "provenance_unverified" });
    const [run] = await safety.list(WS, { operationId: subject.operationId });
    expect(run).toMatchObject({ state: "refused", provenance: { level: "none" } });
    expect((await safety.events(WS, run.id)).map(event => event.to)).toEqual(["planned", "built", "refused"]);
  });

  it("admits an external pinned digest only as pinned_digest and refuses it at the attested floor", async () => {
    const subject = { workspaceId: WS, environmentId: ENV, serviceAddress: SERVICE, imageUri: `ghcr.io/acme/external@${PINNED_DIGEST}`, imageDigest: PINNED_DIGEST, origin: "pinned" as const, kind: "deploy" as const, provider: "aws", nodeKind: "container_service", requestedBy: "human-join" };
    const pinned = createPlatformReleaseSafety(db, {});
    const run = await pinned.begin({ ...subject, operationId: "op-join-pinned" });
    expect(run).toMatchObject({ state: "verified", provenance: { level: "pinned_digest", evidenceRef: `pinned:${PINNED_DIGEST}` } });
    const strict = createPlatformReleaseSafety(db, { ZENITH_RELEASE_MIN_PROVENANCE: "attested" });
    await expect(strict.begin({ ...subject, operationId: "op-join-pinned-strict" })).rejects.toMatchObject({ code: "provenance_unverified" });
    expect((await strict.list(WS, { operationId: "op-join-pinned-strict" }))[0].state).toBe("refused");
  });
});
