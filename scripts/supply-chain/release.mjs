#!/usr/bin/env node
/**
 * Release verification manifest, SLSA provenance and offline verification (PROD-OPS-09).
 *
 * The release bundle is a directory:
 *
 *   release-manifest.json     signed envelope: { manifest: base64url(bytes), signatures: [{ kid, sig }] }
 *   sbom.cdx.json             CycloneDX 1.5 (scripts/supply-chain/sbom.mjs)
 *   provenance.intoto.json    in-toto Statement v1, SLSA provenance v1 predicate (this file, `provenance`)
 *   go/<os>-<arch>/<cmd>      Go binaries           images/<name>.oci.tar   OCI image archives
 *   updater/<component>.json  MACH-04 signed update manifests (go/cmd/zenith-release), when an update host is set
 *
 * The signature is the SAME scheme the runner updater uses (docs/platform/RUNNER-UPDATES.md): an offline Ed25519 key
 * (purpose `signing:release`) signs `domain-prefix || manifest bytes`; verifiers pin the PUBLIC keys themselves and never
 * take a key from the bundle. The control plane never holds this key. Commands:
 *
 *   release.mjs provenance --dir DIR --out FILE --repository OWNER/REPO --commit SHA --ref REF --workflow PATH
 *                          --run-url URL --lock package-lock.json [--started ISO]
 *   release.mjs manifest   --dir DIR --out FILE --tag TAG --version V --commit SHA --repository OWNER/REPO
 *                          [--image NAME=images/x.oci.tar]... [--valid-days N] [--now ISO]
 *   release.mjs sign       --manifest FILE --key SEED_FILE --kid ID --out release-manifest.json
 *   release.mjs oci-digest --archive FILE      prints the verified image manifest digest of an OCI archive
 *
 * Honest trust level of the provenance: it is asserted by the release workflow and bound by the release signature. It is
 * not a Sigstore/GitHub attestation and no SLSA level is claimed.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateSbom } from "./sbom.mjs";

export const MANIFEST_SCHEMA = "zenith.release-verification/v1";
export const SIGNING_PREFIX = `${MANIFEST_SCHEMA}\n`;
export const ENVELOPE_FILE = "release-manifest.json";
export const SBOM_FILE = "sbom.cdx.json";
export const PROVENANCE_FILE = "provenance.intoto.json";
export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
export const RELEASE_BUILD_TYPE = "https://tryzenith.cloud/build/release-workflow/v1";
const MAX_ENVELOPE_BYTES = 1 << 20;
const HEX64 = /^[0-9a-f]{64}$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`${next} is a symbolic link; release bundles contain regular files only`);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push(next);
    }
  };
  walk("");
  return out;
}

export function artifactKind(name) {
  if (name === SBOM_FILE) return "sbom";
  if (name === PROVENANCE_FILE) return "provenance";
  if (name.startsWith("updater/")) return "updater-manifest";
  if (name.startsWith("go/")) return "binary";
  if (name.endsWith(".oci.tar")) return "image-archive";
  return "file";
}

/* ----------------------------- OCI archive digests ----------------------------- */

/**
 * Read an uncompressed OCI image-layout tar: returns the digests of the image manifests listed by index.json and checks
 * that every blob's content hashes to its name, so the image digest is verified from the archive alone, offline.
 */
export function ociArchive(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(512);
    const blobs = [];
    let indexJson;
    let layout = false;
    let offset = 0;
    let zeroBlocks = 0;
    while (offset + 512 <= size && zeroBlocks < 2) {
      fs.readSync(fd, header, 0, 512, offset);
      if (header.every((b) => b === 0)) { zeroBlocks++; offset += 512; continue; }
      zeroBlocks = 0;
      const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
      const name = (prefix ? `${prefix}/${rawName}` : rawName).replace(/^\.\//, "");
      const entrySize = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
      const type = String.fromCharCode(header[156] || 48);
      if (!Number.isSafeInteger(entrySize) || entrySize < 0 || offset + 512 + entrySize > size) throw new Error("the image archive is truncated or malformed");
      if (type === "0" || type === "\0") {
        if (name === "index.json") { indexJson = Buffer.alloc(entrySize); fs.readSync(fd, indexJson, 0, entrySize, offset + 512); }
        else if (name === "oci-layout") layout = true;
        else if (name.startsWith("blobs/sha256/")) {
          const hash = createHash("sha256");
          const buf = Buffer.allocUnsafe(1 << 20);
          for (let done = 0; done < entrySize;) {
            const n = fs.readSync(fd, buf, 0, Math.min(buf.length, entrySize - done), offset + 512 + done);
            if (n <= 0) throw new Error("the image archive is truncated");
            hash.update(buf.subarray(0, n));
            done += n;
          }
          blobs.push({ name: name.slice("blobs/sha256/".length), actual: hash.digest("hex") });
        }
      } else if (type === "1" || type === "2") throw new Error("the image archive contains links, which an OCI layout does not");
      offset += 512 + Math.ceil(entrySize / 512) * 512;
    }
    if (!layout || !indexJson) throw new Error("not an OCI image-layout archive (oci-layout or index.json is missing; gzip is not supported)");
    const bad = blobs.filter((b) => b.name !== b.actual);
    if (bad.length) throw new Error(`${bad.length} blob(s) do not hash to their names: the archive was altered`);
    const index = JSON.parse(indexJson.toString("utf8"));
    const digests = (index.manifests ?? []).map((m) => m.digest).filter((d) => /^sha256:[0-9a-f]{64}$/.test(d));
    if (digests.length === 0) throw new Error("the image archive lists no image manifest");
    const present = new Set(blobs.map((b) => b.name));
    for (const d of digests) if (!present.has(d.slice(7))) throw new Error("the image archive does not contain the manifest blob its index names");
    return { digests, blobCount: blobs.length };
  } finally { fs.closeSync(fd); }
}

/* --------------------------------- provenance --------------------------------- */

export function buildProvenance({ dir, repository, commit, ref, workflow, runUrl, lockSha256, startedOn, finishedOn }) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository ?? "")) throw new Error("--repository must be OWNER/REPO");
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit must be a full 40 hex git commit");
  if (!/^https:\/\//.test(runUrl ?? "")) throw new Error("--run-url must be an https URL of the workflow run");
  if (!HEX64.test(lockSha256 ?? "")) throw new Error("the package-lock digest is required");
  const files = listFiles(dir).filter((f) => f !== PROVENANCE_FILE && f !== ENVELOPE_FILE);
  if (files.length === 0) throw new Error("the bundle directory is empty");
  const subject = files.map((name) => ({ name, digest: { sha256: sha256File(path.join(dir, name)) } }));
  const builderId = `https://github.com/${repository}/${workflow}@${ref}`;
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject,
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType: RELEASE_BUILD_TYPE,
        externalParameters: { repository: `https://github.com/${repository}`, ref, workflow },
        internalParameters: { runner: "github-actions" },
        resolvedDependencies: [
          { uri: `git+https://github.com/${repository}@${ref}`, digest: { gitCommit: commit } },
          { name: "package-lock.json", digest: { sha256: lockSha256 } },
        ],
      },
      runDetails: {
        builder: { id: builderId, version: { attestor: "zenith-release-workflow-self-asserted", note: "asserted by the release workflow and bound by the release signature; not a Sigstore or GitHub attestation" } },
        metadata: { invocationId: runUrl, ...(startedOn ? { startedOn } : {}), ...(finishedOn ? { finishedOn } : {}) },
      },
    },
  };
}

/* ----------------------------- manifest and signature ----------------------------- */

export function buildManifest({ dir, tag, version, commit, repository, images = [], validDays = 365, now = new Date() }) {
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/.test(tag ?? "")) throw new Error("--tag must look like v1.2.3");
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit must be a full 40 hex git commit");
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 730) throw new Error("--valid-days must be 1-730");
  const files = listFiles(dir).filter((f) => f !== ENVELOPE_FILE);
  for (const required of [SBOM_FILE, PROVENANCE_FILE]) if (!files.includes(required)) throw new Error(`${required} must be in the bundle before the manifest is built`);
  const artifacts = files.map((name) => ({ name, kind: artifactKind(name), sha256: sha256File(path.join(dir, name)), size: fs.statSync(path.join(dir, name)).size }));
  const imageEntries = images.map(({ name, archive }) => {
    if (!files.includes(archive)) throw new Error(`image archive ${archive} is not in the bundle`);
    const { digests } = ociArchive(path.join(dir, archive));
    if (digests.length !== 1) throw new Error(`${archive} lists ${digests.length} image manifests; exactly one is supported`);
    return { name, archive, digest: digests[0] };
  });
  return {
    schema: MANIFEST_SCHEMA,
    repository,
    tag,
    version,
    commit,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + validDays * 86_400_000).toISOString(),
    sbom: { name: SBOM_FILE, sha256: artifacts.find((a) => a.name === SBOM_FILE).sha256 },
    provenance: { name: PROVENANCE_FILE, sha256: artifacts.find((a) => a.name === PROVENANCE_FILE).sha256 },
    images: imageEntries,
    artifacts,
  };
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export function privateKeyFromSeed(seed) {
  if (seed.length !== 32) throw new Error("the key file is not a base64url Ed25519 seed");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}
export function publicKeyEntry(kid, seed) {
  return { kid, publicKey: b64u(createPublicKey(privateKeyFromSeed(seed)).export({ format: "der", type: "spki" }).subarray(-32)) };
}

export function signManifest(manifestBytes, seed, kid) {
  const sig = sign(null, Buffer.concat([Buffer.from(SIGNING_PREFIX), manifestBytes]), privateKeyFromSeed(seed));
  return { manifest: b64u(manifestBytes), signatures: [{ kid, sig: b64u(sig) }] };
}

function publicKeyObject(entry) {
  const raw = unb64u(entry.publicKey ?? "");
  if (raw.length !== 32 || typeof entry.kid !== "string" || entry.kid === "") throw new Error(`pinned key ${entry.kid ?? "?"} is invalid`);
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(raw) }, format: "jwk" });
}

/* ------------------------------------ verify ------------------------------------ */

/**
 * Verify a release bundle offline. `keys` are pinned public key entries ({ kid, publicKey } as in the agent config).
 * Never throws on bad input; every failed check is listed. `lock` (package-lock.json text) is optional: when given,
 * the SBOM's npm components must be exactly the lockfile's.
 */
export function verifyRelease({ dir, keys, now = new Date(), strict = false, lock }) {
  const errors = [];
  const warnings = [];
  const fail = (m) => errors.push(m);
  const result = (extra = {}) => ({ ok: errors.length === 0, errors, warnings, ...extra });
  let manifest;
  try {
    if (!Array.isArray(keys) || keys.length === 0) return result({ errors: ["no pinned release public keys were supplied"], ok: false });
    const envelopePath = path.join(dir, ENVELOPE_FILE);
    if (!fs.existsSync(envelopePath) || fs.statSync(envelopePath).size > MAX_ENVELOPE_BYTES) { fail(`${ENVELOPE_FILE} is missing or too large`); return result(); }
    const envelope = JSON.parse(fs.readFileSync(envelopePath, "utf8"));
    if (!isObject(envelope) || typeof envelope.manifest !== "string" || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0 || envelope.signatures.length > 8) { fail("the release envelope is malformed"); return result(); }
    const body = unb64u(envelope.manifest);
    const message = Buffer.concat([Buffer.from(SIGNING_PREFIX), body]);
    const pinned = new Map(keys.map((k) => [k.kid, publicKeyObject(k)]));
    const signedBy = envelope.signatures.find((s) => isObject(s) && pinned.has(s.kid) && typeof s.sig === "string" && unb64u(s.sig).length === 64 && verify(null, message, pinned.get(s.kid), unb64u(s.sig)));
    if (!signedBy) { fail("the release manifest signature does not verify against any pinned release key"); return result(); }
    manifest = JSON.parse(body.toString("utf8"));
    if (!isObject(manifest) || manifest.schema !== MANIFEST_SCHEMA) { fail("the signed manifest has the wrong schema"); return result(); }

    const issued = Date.parse(manifest.issuedAt);
    const expires = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires)) fail("the manifest dates are invalid");
    else {
      if (issued > now.getTime() + 5 * 60_000) fail("the manifest is issued in the future");
      if (expires <= now.getTime()) fail("the manifest has expired");
    }
    if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) fail("the manifest carries no full git commit");
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) { fail("the manifest lists no artifacts"); return result({ manifest }); }

    // 1. every listed artifact is present and has the signed digest and size; nothing unlisted ships in the bundle
    const listed = new Set();
    for (const a of manifest.artifacts) {
      if (!isObject(a) || typeof a.name !== "string" || a.name.includes("..") || path.isAbsolute(a.name) || !HEX64.test(a.sha256 ?? "")) { fail("an artifact entry is malformed"); continue; }
      listed.add(a.name);
      const file = path.join(dir, a.name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { fail(`artifact ${a.name} is missing`); continue; }
      if (fs.statSync(file).size !== a.size) fail(`artifact ${a.name} has a different size than the signed manifest`);
      if (sha256File(file) !== a.sha256) fail(`artifact ${a.name} does not match its signed sha256`);
    }
    const unlisted = listFiles(dir).filter((f) => f !== ENVELOPE_FILE && !listed.has(f));
    if (unlisted.length) (strict ? fail : (m) => warnings.push(m))(`files in the bundle that the signed manifest does not list: ${unlisted.join(", ")}`);

    // 2. SBOM
    let sbom;
    const sbomEntry = manifest.artifacts.find((a) => a.name === manifest.sbom?.name);
    if (!sbomEntry || sbomEntry.sha256 !== manifest.sbom?.sha256) fail("the signed manifest does not bind the SBOM");
    else {
      try { sbom = JSON.parse(fs.readFileSync(path.join(dir, sbomEntry.name), "utf8")); } catch { fail("the SBOM is not valid JSON"); }
    }
    if (sbom) {
      for (const p of validateSbom(sbom)) fail(`SBOM: ${p}`);
      const meta = sbom.metadata?.component;
      if (meta?.version !== manifest.version) fail("the SBOM describes a different release version than the manifest");
      if (!(meta?.properties ?? []).some((p) => p.name === "zenith:git:commit" && p.value === manifest.commit.slice(0, p.value.length) && p.value.length >= 7)) fail("the SBOM does not record the manifest's git commit");
      const components = Array.isArray(sbom.components) ? sbom.components : [];
      for (const image of manifest.images ?? []) {
        if (!components.some((c) => c["bom-ref"] === `zenith-image:${image.name}@${image.digest}`)) fail(`the SBOM does not list image ${image.name} at ${image.digest}`);
      }
      const tagOnly = components.filter((c) => (c.properties ?? []).some((p) => p.name === "zenith:pinned" && p.value === "tag-only"));
      if (tagOnly.length) (strict ? fail : (m) => warnings.push(m))(`base images pinned by tag only (not digest): ${tagOnly.map((c) => `${c.name}:${c.version}`).join(", ")}`);
      if (lock !== undefined) {
        try {
          const packages = JSON.parse(lock).packages ?? {};
          const expected = Object.keys(packages).filter((n) => n).map((n) => `${packages[n].name ?? n.slice(n.lastIndexOf("node_modules/") + 13)}@${packages[n].version}`).sort();
          const actual = components.filter((c) => c.purl?.startsWith("pkg:npm/")).map((c) => `${c.name}@${c.version}`).sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) fail("the SBOM's npm components are not exactly those of the supplied package-lock.json");
        } catch { fail("the supplied package-lock.json is unreadable"); }
      }
    }

    // 3. image archives: digests recomputed from the archive itself
    for (const image of manifest.images ?? []) {
      if (!isObject(image) || !/^sha256:[0-9a-f]{64}$/.test(image.digest ?? "") || !listed.has(image.archive)) { fail("an image entry is malformed or its archive is not listed"); continue; }
      try {
        const { digests } = ociArchive(path.join(dir, image.archive));
        if (!digests.includes(image.digest)) fail(`image ${image.name}: the archive's manifest digest is not the signed digest ${image.digest}`);
      } catch (e) { fail(`image ${image.name}: ${e instanceof Error ? e.message : "unreadable archive"}`); }
    }

    // 4. provenance
    const provEntry = manifest.artifacts.find((a) => a.name === manifest.provenance?.name);
    if (!provEntry || provEntry.sha256 !== manifest.provenance?.sha256) fail("the signed manifest does not bind the provenance");
    else {
      let statement;
      try { statement = JSON.parse(fs.readFileSync(path.join(dir, provEntry.name), "utf8")); } catch { fail("the provenance is not valid JSON"); }
      if (statement) {
        if (statement._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== SLSA_PROVENANCE_V1 || !isObject(statement.predicate)) fail("the provenance is not an in-toto v1 SLSA v1 statement");
        else {
          const subjects = new Map((statement.subject ?? []).map((s) => [s.name, s.digest?.sha256]));
          for (const a of manifest.artifacts) {
            if (a.name === manifest.provenance.name) continue;
            if (subjects.get(a.name) !== a.sha256) fail(`the provenance does not attest ${a.name} at its signed digest`);
          }
          for (const name of subjects.keys()) if (!listed.has(name)) fail(`the provenance attests ${name}, which the manifest does not list`);
          const deps = statement.predicate.buildDefinition?.resolvedDependencies ?? [];
          const source = deps.find((d) => typeof d.uri === "string" && d.uri.startsWith("git+https://github.com/"));
          if (source?.digest?.gitCommit !== manifest.commit) fail("the provenance was built from a different git commit than the manifest");
          if (manifest.repository && source && !source.uri.startsWith(`git+https://github.com/${manifest.repository}@`)) fail("the provenance source repository differs from the manifest");
          const builderId = statement.predicate.runDetails?.builder?.id ?? "";
          if (manifest.repository && !builderId.startsWith(`https://github.com/${manifest.repository}/`)) fail("the provenance builder is not this repository's release workflow");
          if (!String(statement.predicate.buildDefinition?.buildType ?? "").startsWith("https://tryzenith.cloud/build/")) fail("the provenance has an unrecognised build type");
        }
      }
    }
  } catch (e) {
    fail(`could not verify: ${e instanceof Error ? e.message : "unreadable input"}`);
  }
  return result({ manifest });
}

/* ------------------------------------- CLI ------------------------------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (key === "image") (out.image ??= []).push(value);
    else out[key] = value;
  }
  return out;
}

export function main(argv, stdout = process.stdout, stderr = process.stderr) {
  try {
    const [command, ...rest] = argv;
    const a = parseArgs(rest);
    if (command === "provenance") {
      const statement = buildProvenance({ dir: a.dir, repository: a.repository, commit: a.commit, ref: a.ref, workflow: a.workflow, runUrl: a["run-url"], lockSha256: sha256File(a.lock), startedOn: a.started, finishedOn: new Date().toISOString() });
      fs.writeFileSync(a.out, `${JSON.stringify(statement, null, 2)}\n`);
      stdout.write(`${JSON.stringify({ out: a.out, subjects: statement.subject.length })}\n`);
    } else if (command === "manifest") {
      const images = (a.image ?? []).map((s) => { const eq = s.indexOf("="); if (eq < 1) throw new Error("--image must be NAME=archive"); return { name: s.slice(0, eq), archive: s.slice(eq + 1) }; });
      const manifest = buildManifest({ dir: a.dir, tag: a.tag, version: a.version, commit: a.commit, repository: a.repository, images, validDays: a["valid-days"] ? Number(a["valid-days"]) : 365, now: a.now ? new Date(a.now) : new Date() });
      fs.writeFileSync(a.out, JSON.stringify(manifest));
      stdout.write(`${JSON.stringify({ out: a.out, artifacts: manifest.artifacts.length })}\n`);
    } else if (command === "sign") {
      const seed = unb64u(fs.readFileSync(a.key, "utf8").trim());
      const envelope = signManifest(fs.readFileSync(a.manifest), seed, a.kid);
      fs.writeFileSync(a.out, `${JSON.stringify(envelope, null, 2)}\n`);
      stdout.write(`${JSON.stringify({ out: a.out, kid: a.kid })}\n`);
    } else if (command === "oci-digest") {
      const { digests } = ociArchive(a.archive);
      if (digests.length !== 1) throw new Error(`${a.archive} lists ${digests.length} image manifests; exactly one is supported`);
      stdout.write(`${digests[0]}
`);
    } else throw new Error("usage: release.mjs provenance|manifest|sign|oci-digest [flags]");
    return 0;
  } catch (e) {
    stderr.write(`release: ${e instanceof Error ? e.message : "failed"}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
