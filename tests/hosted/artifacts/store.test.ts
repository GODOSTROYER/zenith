/**
 * The artifact store and the trusted publisher.
 *
 * The claims worth testing are the ones a release depends on: the same bytes
 * always produce the same digest, a second put never overwrites, a byte changed
 * on disk afterwards is detected and named, a traversal path is refused rather
 * than resolved, a referenced artifact cannot be removed, and provenance that
 * disagrees with the release is refused field by field.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, uuid } from "../_fixtures";

const DATA = isolatedDataDir("zenith-w2-artifacts-");

let artifacts: typeof import("@/lib/hosted/artifacts");
let contracts: typeof import("@/lib/hosted/contracts");

beforeAll(async () => {
  artifacts = await import("@/lib/hosted/artifacts");
  contracts = await import("@/lib/hosted/contracts");
});

afterAll(() => removeDir(DATA));

let counter = 0;
const storeRoot = (): string => path.join(DATA, `store-${++counter}`);

/** A believable build output: index.html, a hashed asset, a public file. */
function outputTree(overrides: Record<string, string> = {}): string {
  const dir = path.join(DATA, `out-${++counter}`);
  const files: Record<string, string> = {
    "index.html": '<!doctype html><title>Minimal app</title><script type="module" src="/assets/index-abc.js"></script>',
    "assets/index-abc.js": "console.log('Minimal app OK')",
    "assets/index-def.css": ".app{padding:2rem}",
    "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ...overrides,
  };
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

const provenance = (
  overrides: Partial<import("@/lib/hosted/contracts").ArtifactProvenance> = {}
): import("@/lib/hosted/contracts").ArtifactProvenance => ({
  sourceDigest: "a".repeat(64),
  sourceKind: "tarball",
  jobId: "11111111-1111-4111-8111-111111111111",
  recipe: contracts.RECIPE_V1,
  contractVersion: 1,
  schemaVersion: 1,
  builtBy: "recipe-local",
  buildBoundary: "test double",
  builtAt: new Date().toISOString(),
  ...overrides,
});

describe("FsArtifactStore — put, get, list, open", () => {
  it("stores an output tree under its own digest and reads it back", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());

    expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.fileCount).toBe(4);
    expect(artifact.byteSize).toBeGreaterThan(0);
    expect(artifact.provenance.builtBy).toBe("recipe-local");
    expect(artifact.verifiedAt).toBeUndefined();

    expect(fs.existsSync(path.join(store.root, "sha256", artifact.digest, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(store.root, "sha256", artifact.digest, "files", "index.html"))).toBe(true);

    expect(await store.get(artifact.digest)).toEqual(artifact);
    const files = await store.list(artifact.digest);
    expect(files.map((f) => f.path)).toEqual([
      "assets/index-abc.js",
      "assets/index-def.css",
      "favicon.svg",
      "index.html",
    ]);
    expect(files.find((f) => f.path === "index.html")?.contentType).toBe("text/html; charset=utf-8");
    expect(files.find((f) => f.path === "assets/index-abc.js")?.contentType).toBe("text/javascript");
    expect(files.find((f) => f.path === "favicon.svg")?.contentType).toBe("image/svg+xml");

    const opened = await store.open(artifact.digest, "assets/index-abc.js");
    expect(opened?.bytes.toString("utf8")).toBe("console.log('Minimal app OK')");
    expect(opened?.file.sha256).toBe(files.find((f) => f.path === "assets/index-abc.js")?.sha256);
  });

  it("gives identical bytes the same digest whatever directory they were built in", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const first = await store.put(outputTree(), provenance());
    const second = await store.put(outputTree(), provenance({ jobId: uuid() }));
    expect(second.digest).toBe(first.digest);
  });

  it("treats a second put of identical bytes as a verified no-op that never overwrites", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const first = await store.put(outputTree(), provenance());
    const manifestPath = path.join(store.root, "sha256", first.digest, "manifest.json");
    const before = fs.readFileSync(manifestPath, "utf8");

    const laterProvenance = provenance({ jobId: uuid(), builtBy: "docker" });
    const second = await store.put(outputTree(), laterProvenance);

    expect(second.digest).toBe(first.digest);
    // The first artifact's provenance stands: an immutable record is not
    // rewritten by whoever happens to build the same bytes next.
    expect(second.provenance.jobId).toBe(first.provenance.jobId);
    expect(second.provenance.builtBy).toBe("recipe-local");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
    expect(new artifacts.FsArtifactStore(store.root).digests()).toEqual([first.digest]);
  });

  it("gives a different digest when one byte of one file changes", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const first = await store.put(outputTree(), provenance());
    const second = await store.put(outputTree({ "assets/index-abc.js": "console.log('changed')" }), provenance());
    expect(second.digest).not.toBe(first.digest);
    expect(store.digests().length).toBe(2);
  });

  it("refuses an output with no index.html", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const dir = path.join(DATA, `bad-${++counter}`);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "only.js"), "x");
    await expect(store.put(dir, provenance())).rejects.toThrow(/index\.html/);
  });

  it("refuses a source map, naming why", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    await expect(store.put(outputTree({ "assets/index-abc.js.map": "{}" }), provenance())).rejects.toThrow(
      /source map/
    );
  });

  it("refuses an extension it has no content type for", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    await expect(store.put(outputTree({ "assets/run.sh": "#!/bin/sh" }), provenance())).rejects.toThrow(
      /publishable content type/
    );
  });

  it("refuses an empty output and a missing one", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const empty = path.join(DATA, `empty-${++counter}`);
    fs.mkdirSync(empty, { recursive: true });
    await expect(store.put(empty, provenance())).rejects.toThrow(/empty/);
    await expect(store.put(path.join(DATA, "nowhere"), provenance())).rejects.toThrow(/no build output/);
  });
});

describe("FsArtifactStore — open never leaves the artifact", () => {
  it("refuses traversal, absolute, backslash and empty paths", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    for (const attempt of [
      "../manifest.json",
      "assets/../../manifest.json",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "assets\\index-abc.js",
      "",
      "..",
    ])
      expect(await store.open(artifact.digest, attempt), attempt).toBeNull();
  });

  it("answers null for a file the artifact does not hold and for an unknown digest", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    expect(await store.open(artifact.digest, "assets/missing.js")).toBeNull();
    expect(await store.open("b".repeat(64), "index.html")).toBeNull();
    expect(await store.open("not-a-digest", "index.html")).toBeNull();
    expect(await store.get("not-a-digest")).toBeNull();
    expect(await store.list("not-a-digest")).toEqual([]);
  });

  it("normalises a harmless ./ prefix rather than refusing it", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    expect((await store.open(artifact.digest, "./index.html"))?.file.path).toBe("index.html");
  });
});

describe("FsArtifactStore — verify catches tampering", () => {
  it("passes on stored bytes", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    const verdict = await store.verify(artifact.digest);
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("digest matches");
  });

  it("fails and names the file when a stored byte changes without changing its length", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    const target = path.join(store.root, "sha256", artifact.digest, "files", "assets", "index-abc.js");
    const original = fs.readFileSync(target);
    const swapped = Buffer.from(original);
    swapped[0] = original[0] === 0x63 ? 0x43 : 0x63; // c <-> C: same length, different bytes
    fs.writeFileSync(target, swapped);

    const verdict = await store.verify(artifact.digest);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("assets/index-abc.js");
    expect(verdict.detail).toContain("has changed");
  });

  it("fails and names the file when a stored file changes length", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    fs.writeFileSync(
      path.join(store.root, "sha256", artifact.digest, "files", "assets", "index-abc.js"),
      "console.log('tampered')"
    );
    const verdict = await store.verify(artifact.digest);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("assets/index-abc.js");
    expect(verdict.detail).toContain("the manifest records");
  });

  it("fails when a file is deleted from the store", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    fs.rmSync(path.join(store.root, "sha256", artifact.digest, "files", "favicon.svg"));
    const verdict = await store.verify(artifact.digest);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("favicon.svg");
    expect(verdict.detail).toContain("missing");
  });

  it("fails when an unlisted file is added to the store", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    fs.writeFileSync(path.join(store.root, "sha256", artifact.digest, "files", "extra.js"), "surprise");
    const verdict = await store.verify(artifact.digest);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("extra.js");
  });

  it("fails when the manifest's own file table no longer hashes to its key", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    const manifestPath = path.join(store.root, "sha256", artifact.digest, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as import("@/lib/hosted/artifacts").ArtifactManifest;
    const forged = "0".repeat(64);
    manifest.files = manifest.files.map((f) => (f.path === "index.html" ? { ...f, sha256: forged } : f));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const verdict = await store.verify(artifact.digest);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("index.html");
  });

  it("refuses a put whose digest exists but whose stored manifest was edited", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    const manifestPath = path.join(store.root, "sha256", artifact.digest, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as import("@/lib/hosted/artifacts").ArtifactManifest;
    manifest.files = manifest.files.filter((f) => f.path !== "favicon.svg");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(store.put(outputTree(), provenance())).rejects.toThrow(/does not match/);
  });

  it("says so for a digest it does not hold", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    expect((await store.verify("c".repeat(64))).ok).toBe(false);
    expect((await store.verify("nope")).detail).toContain("not a sha256");
  });
});

describe("FsArtifactStore — remove", () => {
  it("refuses while a release references the artifact", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    expect(await store.remove(artifact.digest, async () => true)).toBe(false);
    expect(await store.get(artifact.digest)).not.toBeNull();
  });

  it("removes an artifact nothing references", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    expect(await store.remove(artifact.digest, async () => false)).toBe(true);
    expect(await store.get(artifact.digest)).toBeNull();
    expect(store.digests()).toEqual([]);
  });

  it("answers false for a digest it does not hold", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    expect(await store.remove("d".repeat(64), async () => false)).toBe(false);
    expect(await store.remove("nope", async () => false)).toBe(false);
  });
});

describe("verifyForRelease — the trusted publisher check", () => {
  const expectation = (
    artifact: import("@/lib/hosted/contracts").Artifact
  ): import("@/lib/hosted/artifacts").ReleaseExpectation => ({
    sourceDigest: artifact.provenance.sourceDigest,
    jobId: artifact.provenance.jobId,
    recipe: artifact.provenance.recipe,
  });

  it("passes for matching provenance and records that the bytes were checked", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());

    const verdict = await artifacts.verifyForRelease(store, artifact.digest, expectation(artifact));
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("digest matches");
    expect(verdict.detail).toContain("recipe-local");
    expect(verdict.artifact?.verifiedAt).toMatch(/^\d{4}-/);

    // The stamp is durable, and it did not disturb the bytes it vouches for.
    expect((await store.get(artifact.digest))?.verifiedAt).toBe(verdict.artifact?.verifiedAt);
    expect((await store.verify(artifact.digest)).ok).toBe(true);
  });

  it("refuses a different source digest", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    const verdict = await artifacts.verifyForRelease(store, artifact.digest, {
      ...expectation(artifact),
      sourceDigest: "e".repeat(64),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("built from source");
    expect(verdict.artifact?.verifiedAt).toBeUndefined();
  });

  it("refuses a different job id", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    const verdict = await artifacts.verifyForRelease(store, artifact.digest, {
      ...expectation(artifact),
      jobId: uuid(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("built by job");
  });

  it("refuses a different recipe version, naming the field", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    const verdict = await artifacts.verifyForRelease(store, artifact.digest, {
      ...expectation(artifact),
      recipe: { ...contracts.RECIPE_V1, vite: "6.0.0" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("recipe.vite");
    expect(verdict.detail).toContain("6.0.0");
  });

  it("refuses tampered bytes even when the provenance still matches", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const artifact = await store.put(outputTree(), provenance());
    fs.writeFileSync(
      path.join(store.root, "sha256", artifact.digest, "files", "index.html"),
      "<!doctype html><script>fetch('https://evil.example')</script>"
    );
    const verdict = await artifacts.verifyForRelease(store, artifact.digest, expectation(artifact));
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("do not match the manifest");
    expect(verdict.detail).toContain("index.html");
  });

  it("refuses a digest the store does not hold", async () => {
    const store = new artifacts.FsArtifactStore(storeRoot());
    const verdict = await artifacts.verifyForRelease(store, "f".repeat(64), {
      sourceDigest: "a".repeat(64),
      jobId: uuid(),
      recipe: contracts.RECIPE_V1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("no release may reference it");
  });
});

describe("the store's default root", () => {
  it("lives under the hosted artifact directory", async () => {
    const config = await import("@/lib/hosted/config");
    expect(new artifacts.FsArtifactStore().root).toBe(config.hostedConfig().artifactDir);
    expect(new artifacts.FsArtifactStore().root.startsWith(DATA)).toBe(true);
  });
});
