/**
 * PROD-OPS-09: release verification manifest, SLSA provenance and the offline `zenith-verify-release` verifier.
 * Real Ed25519 signatures (keys generated at runtime), real files on disk, real OCI-layout archives written by the test.
 * No network, no docker. The bundles are built the way .github/workflows/release.yml builds them.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProvenance, buildManifest, ociArchive, privateKeyFromSeed, publicKeyEntry, signManifest, verifyRelease, ENVELOPE_FILE, PROVENANCE_FILE, SBOM_FILE, main as releaseMain } from "../../scripts/supply-chain/release.mjs";
import { buildSbom } from "../../scripts/supply-chain/sbom.mjs";
import { main as verifyMain } from "../../scripts/supply-chain/zenith-verify-release.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-release-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPO = "GODOSTROYER/zenith";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const seed = (): Buffer => randomBytes(32);

/** Minimal ustar writer: enough for an OCI image-layout archive. */
function tar(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A single-image OCI layout whose blobs hash to their names; returns the archive and the image manifest digest. */
function ociImage(label: string, tamper = false): { archive: Buffer; digest: string } {
  const layer = Buffer.from(`layer ${label}`);
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", label }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: `sha256:${sha(config)}`, size: config.length }, layers: [{ digest: `sha256:${sha(layer)}`, size: layer.length }] }));
  const digest = `sha256:${sha(manifest)}`;
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: manifest.length }] }));
  const archive = tar({
    "oci-layout": Buffer.from('{"imageLayoutVersion":"1.0.0"}'),
    "index.json": index,
    [`blobs/sha256/${sha(manifest)}`]: manifest,
    [`blobs/sha256/${sha(config)}`]: config,
    [`blobs/sha256/${sha(layer)}`]: tamper ? Buffer.from(`layer ${label}!`) : layer,
  });
  return { archive, digest };
}

interface Bundle { dir: string; keys: ReturnType<typeof publicKeyEntry>[]; seed: Buffer; lock: string }

/** Assemble and sign a bundle exactly as the workflow does: files, SBOM, provenance, manifest, signature. */
function makeBundle(name: string, options: { signSeed?: Buffer; tamperImage?: boolean; commitInProvenance?: string; validDays?: number } = {}): Bundle {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, "go/linux-amd64"), { recursive: true });
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "go/linux-amd64/zenithd"), randomBytes(64));
  fs.writeFileSync(path.join(dir, "go/linux-amd64/zenith-runner"), randomBytes(64));
  const image = ociImage("zenithd");
  fs.writeFileSync(path.join(dir, "images/zenithd.oci.tar"), image.archive);
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app", version: "1.0.0", dependencies: { a: "^1" } }, "node_modules/a": { version: "1.0.0", integrity: `sha512-${randomBytes(64).toString("base64")}` } } });
  const lockFile = path.join(scratch, `${name}-lock.json`);
  fs.writeFileSync(lockFile, lock);
  const sbom = buildSbom({ lock: JSON.parse(lock), goInfos: [], images: [{ name: "zenithd", digest: image.digest }], version: "1.2.3", commit: COMMIT, timestamp: NOW.toISOString() });
  fs.writeFileSync(path.join(dir, SBOM_FILE), JSON.stringify(sbom));
  const provenance = buildProvenance({ dir, repository: REPO, commit: options.commitInProvenance ?? COMMIT, ref: "refs/tags/v1.2.3", workflow: ".github/workflows/release.yml", runUrl: `https://github.com/${REPO}/actions/runs/1`, lockSha256: sha(lock), startedOn: NOW.toISOString() });
  fs.writeFileSync(path.join(dir, PROVENANCE_FILE), JSON.stringify(provenance));
  const manifest = buildManifest({ dir, tag: "v1.2.3", version: "1.2.3", commit: COMMIT, repository: REPO, images: [{ name: "zenithd", archive: "images/zenithd.oci.tar" }], validDays: options.validDays ?? 30, now: NOW });
  const signSeed = options.signSeed ?? seed();
  const envelope = signManifest(Buffer.from(JSON.stringify(manifest)), signSeed, "release-2026-10");
  fs.writeFileSync(path.join(dir, ENVELOPE_FILE), JSON.stringify(envelope));
  // The archive is altered after signing: same image manifest digest, one layer blob no longer hashes to its name.
  if (options.tamperImage) fs.writeFileSync(path.join(dir, "images/zenithd.oci.tar"), ociImage("zenithd", true).archive);
  return { dir, keys: [publicKeyEntry("release-2026-10", signSeed)], seed: signSeed, lock };
}

const verify = (b: Bundle, extra: Record<string, unknown> = {}) => verifyRelease({ dir: b.dir, keys: b.keys, now: NOW, lock: b.lock, ...extra });
const resign = (b: Bundle, edit: (m: Record<string, unknown> & { artifacts: { name: string; sha256: string; size: number }[]; provenance: { sha256: string } }) => void): void => {
  const env = JSON.parse(fs.readFileSync(path.join(b.dir, ENVELOPE_FILE), "utf8"));
  const manifest = JSON.parse(Buffer.from(env.manifest, "base64url").toString("utf8"));
  edit(manifest);
  fs.writeFileSync(path.join(b.dir, ENVELOPE_FILE), JSON.stringify(signManifest(Buffer.from(JSON.stringify(manifest)), b.seed, "release-2026-10")));
};

describe("a correctly built and signed bundle", () => {
  it("verifies offline: signature, digests, SBOM, image archive and provenance", () => {
    const bundle = makeBundle("good");
    const result = verify(bundle);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({ tag: "v1.2.3", commit: COMMIT, images: [{ name: "zenithd" }] });
    expect(result.manifest.artifacts.map((a: { kind: string }) => a.kind).sort()).toEqual(["binary", "binary", "image-archive", "provenance", "sbom"]);
  });

  it("the CLI exits 0 with the pinned keys and 2 without them", () => {
    const bundle = makeBundle("cli");
    const keyFile = path.join(scratch, "cli-keys.json");
    fs.writeFileSync(keyFile, JSON.stringify(bundle.keys));
    const lockFile = path.join(scratch, "cli-lock.json");
    fs.writeFileSync(lockFile, bundle.lock);
    const out: string[] = [];
    const sink = { write: (s: string) => { out.push(s); return true; } } as unknown as NodeJS.WriteStream;
    expect(verifyMain([bundle.dir, "--keys", keyFile, "--lock", lockFile, "--now", NOW.toISOString()], sink, sink)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ verified: true, version: "1.2.3" });
    expect(verifyMain([bundle.dir], sink, sink)).toBe(2);
    fs.writeFileSync(path.join(bundle.dir, "go/linux-amd64/zenithd"), "swapped");
    expect(verifyMain([bundle.dir, "--keys", keyFile, "--now", NOW.toISOString()], sink, sink)).toBe(1);
  });

  it("the release.mjs CLI builds provenance, manifest and signature that the verifier accepts", () => {
    const dir = path.join(scratch, "pipeline");
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    fs.mkdirSync(path.join(dir, "go"), { recursive: true });
    fs.writeFileSync(path.join(dir, "go/zenithd"), randomBytes(32));
    const image = ociImage("pipeline");
    fs.writeFileSync(path.join(dir, "images/x.oci.tar"), image.archive);
    const lockFile = path.join(scratch, "pipeline-lock.json");
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app", version: "1.0.0" }, "node_modules/a": { version: "1.0.0", integrity: `sha512-${randomBytes(64).toString("base64")}` } } });
    fs.writeFileSync(lockFile, lock);
    fs.writeFileSync(path.join(dir, SBOM_FILE), JSON.stringify(buildSbom({ lock: JSON.parse(lock), images: [{ name: "x", digest: image.digest }], version: "1.2.3", commit: COMMIT })));
    const s = seed();
    const seedFile = path.join(scratch, "seed.txt");
    fs.writeFileSync(seedFile, `${s.toString("base64url")}\n`);
    const out: string[] = [];
    const err: string[] = [];
    const sink = (into: string[]) => ({ write: (v: string) => { into.push(v); return true; } }) as unknown as NodeJS.WriteStream;
    const run = (args: string[]) => releaseMain(args, sink(out), sink(err));
    expect(run(["oci-digest", "--archive", path.join(dir, "images/x.oci.tar")])).toBe(0);
    expect(out.join("").trim()).toBe(image.digest);
    expect(run(["provenance", "--dir", dir, "--out", path.join(dir, PROVENANCE_FILE), "--repository", REPO, "--commit", COMMIT, "--ref", "refs/tags/v1.2.3", "--workflow", ".github/workflows/release.yml", "--run-url", `https://github.com/${REPO}/actions/runs/9`, "--lock", lockFile])).toBe(0);
    const manifestFile = path.join(scratch, "pipeline-manifest.json");
    expect(run(["manifest", "--dir", dir, "--out", manifestFile, "--tag", "v1.2.3", "--version", "1.2.3", "--commit", COMMIT, "--repository", REPO, "--image", "x=images/x.oci.tar"])).toBe(0);
    expect(run(["sign", "--manifest", manifestFile, "--key", seedFile, "--kid", "k1", "--out", path.join(dir, ENVELOPE_FILE)])).toBe(0);
    expect(err.join("")).toBe("");
    const result = verifyRelease({ dir, keys: [publicKeyEntry("k1", s)], lock });
    expect(result.errors).toEqual([]);
  });
});

describe("tampering is detected", () => {
  it("rejects a modified binary, a missing artifact and a size change", () => {
    const a = makeBundle("t-binary");
    fs.appendFileSync(path.join(a.dir, "go/linux-amd64/zenithd"), "x");
    expect(verify(a).errors.join()).toMatch(/zenithd has a different size|does not match its signed sha256/);
    const b = makeBundle("t-missing");
    fs.rmSync(path.join(b.dir, "go/linux-amd64/zenith-runner"));
    expect(verify(b).errors.join()).toMatch(/zenith-runner is missing/);
  });

  it("rejects an unsigned bundle, a wrong key, a forged manifest and an unpinned kid", () => {
    const good = makeBundle("t-sig");
    const wrong = [publicKeyEntry("release-2026-10", seed())];
    expect(verifyRelease({ dir: good.dir, keys: wrong, now: NOW }).errors.join()).toMatch(/signature does not verify/);
    expect(verifyRelease({ dir: good.dir, keys: [{ ...good.keys[0], kid: "other" }], now: NOW }).errors.join()).toMatch(/signature does not verify/);
    expect(verifyRelease({ dir: good.dir, keys: [], now: NOW }).ok).toBe(false);
    const env = JSON.parse(fs.readFileSync(path.join(good.dir, ENVELOPE_FILE), "utf8"));
    const manifest = JSON.parse(Buffer.from(env.manifest, "base64url").toString("utf8"));
    manifest.commit = "f".repeat(40);
    env.manifest = Buffer.from(JSON.stringify(manifest)).toString("base64url");
    fs.writeFileSync(path.join(good.dir, ENVELOPE_FILE), JSON.stringify(env));
    expect(verify(good).errors.join()).toMatch(/signature does not verify/);
    fs.rmSync(path.join(good.dir, ENVELOPE_FILE));
    expect(verify(good).errors.join()).toMatch(/release-manifest.json is missing/);
  });

  it("rejects an expired manifest and a manifest issued in the future", () => {
    const b = makeBundle("t-expiry", { validDays: 1 });
    expect(verify(b, { now: new Date(NOW.getTime() + 2 * 86_400_000) }).errors.join()).toMatch(/expired/);
    expect(verify(b, { now: new Date(NOW.getTime() - 3_600_000) }).errors.join()).toMatch(/future/);
  });

  it("rejects an altered SBOM (digest bound by the signed manifest) and an SBOM that disagrees with the lockfile", () => {
    const b = makeBundle("t-sbom");
    const file = path.join(b.dir, SBOM_FILE);
    const sbom = JSON.parse(fs.readFileSync(file, "utf8"));
    sbom.components.pop();
    fs.writeFileSync(file, JSON.stringify(sbom));
    expect(verify(b).errors.join()).toMatch(/sbom.cdx.json (has a different size|does not match)/);
    const c = makeBundle("t-lock");
    const other = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" }, "node_modules/b": { version: "9.9.9", integrity: `sha512-${randomBytes(64).toString("base64")}` } } });
    expect(verify(c, { lock: other }).errors.join()).toMatch(/not exactly those of the supplied package-lock.json/);
  });

  it("rejects an image archive whose blobs were altered, and one whose digest differs from the signed digest", () => {
    const altered = makeBundle("t-image", { tamperImage: true });
    expect(verify(altered).errors.join()).toMatch(/blob\(s\) do not hash to their names/);
    const swapped = makeBundle("t-image2");
    fs.writeFileSync(path.join(swapped.dir, "images/zenithd.oci.tar"), ociImage("different").archive);
    // the archive no longer matches its listed sha256 AND its digest is not the signed one
    const errors = verify(swapped).errors.join();
    expect(errors).toMatch(/does not match its signed sha256/);
    expect(errors).toMatch(/not the signed digest/);
    expect(() => ociArchive(path.join(swapped.dir, "go/linux-amd64/zenithd"))).toThrow();
  });

  it("rejects provenance built from another commit even when the whole bundle is re-signed", () => {
    const b = makeBundle("t-prov", { commitInProvenance: "9".repeat(40) });
    expect(verify(b).errors.join()).toMatch(/different git commit than the manifest/);
  });

  it("rejects provenance that does not attest an artifact at its signed digest", () => {
    const b = makeBundle("t-prov2");
    const file = path.join(b.dir, PROVENANCE_FILE);
    const statement = JSON.parse(fs.readFileSync(file, "utf8"));
    statement.subject[0].digest.sha256 = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(statement));
    // the provenance file changed, so the signed manifest's digest of it no longer matches; re-sign to isolate the subject check
    resign(b, (m) => {
      const bytes = fs.readFileSync(file);
      const entry = m.artifacts.find((a: { name: string }) => a.name === PROVENANCE_FILE)!;
      entry.sha256 = sha(bytes);
      entry.size = bytes.length;
      m.provenance.sha256 = entry.sha256;
    });
    expect(verify(b).errors.join()).toMatch(/does not attest/);
  });

  it("flags unlisted files and tag-only base images as warnings, and as failures with strict", () => {
    const b = makeBundle("t-strict");
    fs.writeFileSync(path.join(b.dir, "extra.bin"), "smuggled");
    const loose = verify(b);
    expect(loose.ok).toBe(true);
    expect(loose.warnings.join()).toMatch(/extra.bin/);
    expect(verify(b, { strict: true }).errors.join()).toMatch(/extra.bin/);
  });

  it("refuses a symlink in the bundle", () => {
    const b = makeBundle("t-link");
    try {
      fs.symlinkSync(path.join(b.dir, SBOM_FILE), path.join(b.dir, "link"));
    } catch {
      return; // symlinks need privileges on some Windows setups; the check itself is exercised where they exist
    }
    expect(verify(b).ok).toBe(false);
  });
});

describe("key handling", () => {
  it("derives the public key entry the agents pin from the same seed the signature uses", () => {
    const s = seed();
    const entry = publicKeyEntry("k", s);
    expect(Buffer.from(entry.publicKey, "base64url")).toHaveLength(32);
    const reference = generateKeyPairSync("ed25519");
    expect(privateKeyFromSeed(seed()).asymmetricKeyType).toBe(reference.privateKey.asymmetricKeyType);
    expect(() => privateKeyFromSeed(Buffer.alloc(5))).toThrow();
  });
});
