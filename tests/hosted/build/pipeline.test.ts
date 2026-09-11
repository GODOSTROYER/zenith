/**
 * Source → build → artifact → publisher, end to end, with nothing simulated.
 *
 * This is the W2 half of acceptance gate 1: a pinned source really is compiled
 * by the platform recipe, the output really is stored under a SHA-256 over its
 * own bytes with provenance, and the trusted publisher really recomputes those
 * bytes before a release could reference them. A hostile submission is refused
 * at the first step and never reaches a runner.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, uuid } from "../_fixtures";
import { entriesFromDirectory, writeTar } from "../../_support/tar";

const DATA = isolatedDataDir("zenith-w2-pipeline-");
const FIXTURE = path.join(process.cwd(), "fixtures", "hosted", "minimal-app");

let build: typeof import("@/lib/hosted/build");
let source: typeof import("@/lib/hosted/source");
let artifacts: typeof import("@/lib/hosted/artifacts");
let contracts: typeof import("@/lib/hosted/contracts");

beforeAll(async () => {
  build = await import("@/lib/hosted/build");
  source = await import("@/lib/hosted/source");
  artifacts = await import("@/lib/hosted/artifacts");
  contracts = await import("@/lib/hosted/contracts");
  process.env.ZENITH_BUILD_RUNNER = "recipe-local";
});

afterAll(async () => {
  delete process.env.ZENITH_BUILD_RUNNER;
  removeDir(DATA);
});

describe("the whole W2 path", () => {
  it("takes a tarball to a verified, content-addressed artifact", async () => {
    const tarball = writeTar(entriesFromDirectory(FIXTURE));
    const validated = source.validateSource({ kind: "tarball", bytes: tarball });
    const jobId = uuid();

    const runner = new build.RecipeLocalRunner();
    const result = await runner.run(
      {
        jobId,
        appId: "app-alpha",
        source: validated,
        recipe: contracts.RECIPE_V1,
        limits: { timeoutMs: 120_000, maxLogBytes: 64_000, memoryMb: 512 },
      },
      new AbortController().signal
    );
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    const outputDir = result.outputDir as string;
    try {
      const store = new artifacts.FsArtifactStore(path.join(DATA, "artifacts"));
      const artifact = await store.put(outputDir, {
        sourceDigest: validated.digest,
        sourceKind: validated.kind,
        jobId,
        recipe: contracts.RECIPE_V1,
        contractVersion: 1,
        schemaVersion: 1,
        builtBy: result.runner,
        buildBoundary: result.boundary,
        builtAt: new Date().toISOString(),
      });

      expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.provenance.sourceDigest).toBe(validated.digest);
      expect(artifact.provenance.buildBoundary).toContain("not a hostile-code sandbox");

      const files = await store.list(artifact.digest);
      expect(files.some((f) => f.path === "index.html")).toBe(true);
      expect(files.some((f) => f.path.startsWith("assets/") && f.path.endsWith(".js"))).toBe(true);
      expect(files.some((f) => f.path.endsWith(".map"))).toBe(false);

      const served = await store.open(artifact.digest, "index.html");
      expect(served?.file.contentType).toBe("text/html; charset=utf-8");
      expect(served?.bytes.toString("utf8")).toContain("<div id=\"root\">");

      const verdict = await artifacts.verifyForRelease(store, artifact.digest, {
        sourceDigest: validated.digest,
        jobId,
        recipe: contracts.RECIPE_V1,
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.artifact?.verifiedAt).toBeTruthy();

      // A release that names a different source cannot borrow this artifact.
      const wrong = await artifacts.verifyForRelease(store, artifact.digest, {
        sourceDigest: "0".repeat(64),
        jobId,
        recipe: contracts.RECIPE_V1,
      });
      expect(wrong.ok).toBe(false);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses a hostile submission before any runner is reached", async () => {
    const hostile = writeTar([
      ...entriesFromDirectory(FIXTURE),
      { path: "vite.config.ts", bytes: Buffer.from("export default { plugins: [require('./evil')] }") },
      { path: "../../etc/cron.d/pwn", bytes: Buffer.from("* * * * * root sh") },
    ]);
    let reasons: string[] = [];
    try {
      source.validateSource({ kind: "tarball", bytes: hostile });
      throw new Error("the hostile archive was accepted");
    } catch (err) {
      expect(err).toBeInstanceOf(contracts.HostedError);
      reasons = (err as import("@/lib/hosted/contracts").HostedError).details?.reasons as string[];
    }
    expect(reasons.some((r) => r.includes("vite.config.ts"))).toBe(true);
    expect(reasons.some((r) => r.includes('".." segment'))).toBe(true);
  });
});
