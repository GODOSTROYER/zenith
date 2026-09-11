/**
 * The immutable, content-addressed artifact store.
 *
 * An artifact is the compiled output of one build, keyed by a SHA-256 over its
 * own bytes. Two properties matter and both are enforced here rather than
 * assumed:
 *
 *  - **Create-only.** A digest directory is written into a temporary directory
 *    and moved into place with one `rename`, so a reader never sees a partial
 *    artifact and a second `put` of the same bytes cannot overwrite the first.
 *    A `put` whose digest already exists verifies the stored manifest against
 *    what it just computed and returns the existing record.
 *  - **Re-checkable.** `verify()` recomputes every file's hash and the overall
 *    digest from the bytes on disk, so tampering after the fact is detectable
 *    and is what the trusted publisher looks at before a release may point here.
 *
 * Layout:
 *
 *     <root>/sha256/<digest>/manifest.json
 *     <root>/sha256/<digest>/files/<path>
 *
 * Workstream W2 (hosted R3).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  HostedError,
  type Artifact,
  type ArtifactFile,
  type ArtifactProvenance,
  type ArtifactStore,
} from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { byPath, sha256, treeDigest } from "@/lib/hosted/digest";
import { removeQuietly } from "@/lib/hosted/fs";

/**
 * Content types an artifact may carry, by extension.
 *
 * The table is an allowlist, not a lookup with a default: an extension that is
 * not here is refused at `put` time, because an artifact is served straight to
 * a browser and a guessed type is a way to smuggle one thing in as another.
 */
export const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Extensions refused with their own explanation rather than the generic one. */
const REFUSED_EXTENSIONS: Record<string, string> = {
  ".map": "a source map would publish the app's source; the recipe builds with sourcemap: false",
};

const extensionOf = (p: string): string => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

/**
 * The artifact identity.
 *
 * `artifactDigest(files)` = SHA-256, hex, of the concatenation, over every file
 * sorted byte-wise by path, of:
 *
 *     <path> + "\0" + <sha256-hex of that file's bytes> + "\n"
 *
 * The same formula as the source digest, deliberately: one rule to reason about,
 * and neither is affected by timestamps, permissions or directory order.
 */
export function artifactDigest(files: { path: string; sha256: string }[]): string {
  return treeDigest(files);
}

/** What `manifest.json` holds: the record, and the file table the record covers. */
export interface ArtifactManifest {
  artifact: Artifact;
  files: ArtifactFile[];
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

/** Normalise a path a caller asked for, or refuse it. Never resolves outside the artifact. */
export function artifactPath(raw: string): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.includes("\u0000") || raw.includes("\\")) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/** Walk a built output tree without following links, into `path`-sorted files. */
function walkOutput(root: string): { path: string; bytes: Buffer }[] {
  const out: { path: string; bytes: Buffer }[] = [];
  const visit = (absolute: string, relative: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absolute, entry.name);
      const stat = fs.lstatSync(childAbsolute, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink())
        throw new HostedError("invalid_input", `The build output holds a symbolic link at ${childRelative}.`, {
          fix: "A recipe build never emits links. Re-run the build; if it happens again, the output directory was tampered with.",
        });
      if (stat.isDirectory()) {
        visit(childAbsolute, childRelative);
        continue;
      }
      if (!stat.isFile())
        throw new HostedError("invalid_input", `The build output holds a special file at ${childRelative}.`, {
          fix: "Re-run the build; only regular files can be published.",
        });
      out.push({ path: childRelative, bytes: fs.readFileSync(childAbsolute) });
    }
  };
  visit(root, "");
  return out.sort(byPath);
}

/** The content type for one artifact path, or a refusal naming why. */
export function artifactContentType(relative: string): string {
  const ext = extensionOf(relative);
  const refused = REFUSED_EXTENSIONS[ext];
  if (refused)
    throw new HostedError("invalid_input", `${relative} cannot be published: ${refused}.`, {
      fix: "Remove the file from the build output. The recipe does not emit source maps.",
    });
  const type = ARTIFACT_CONTENT_TYPES[ext];
  if (!type)
    throw new HostedError("invalid_input", `${relative} has no publishable content type ("${ext || "no extension"}").`, {
      fix: `Publishable extensions are ${Object.keys(ARTIFACT_CONTENT_TYPES).join(" ")}. Remove the file or give it one of them.`,
    });
  return type;
}

/**
 * Parsed manifests held per store instance.
 *
 * Safe to hold without invalidation because the thing cached is immutable by
 * construction: a digest directory is created once by `rename` and its
 * `manifest.json` describes bytes that hash to that same digest. The two
 * places that do change a stored artifact — `markVerified`, which rewrites the
 * manifest with a timestamp, and `remove`, which deletes it — update this
 * cache themselves rather than leaving it to a timeout.
 *
 * ponytail: LRU by insertion order; a Map is the stdlib's LRU.
 */
const MANIFEST_CACHE_MAX = 64;

/** What one file of an artifact is, without having read its bytes. */
export interface ArtifactStat {
  file: ArtifactFile;
  /** the size on disk, which is what every length header is computed from */
  size: number;
  /** absolute path of the file, already checked to be inside the artifact */
  absolute: string;
}

export class FsArtifactStore implements ArtifactStore {
  /** Absolute root of the store; defaults to `hostedConfig().artifactDir`. */
  readonly root: string;

  /** digest → parsed manifest.json; see MANIFEST_CACHE_MAX. */
  private readonly manifests = new Map<string, ArtifactManifest>();

  constructor(root?: string) {
    this.root = root ?? hostedConfig().artifactDir;
  }

  private digestDir(digest: string): string {
    return path.join(this.root, "sha256", digest);
  }

  private manifestPath(digest: string): string {
    return path.join(this.digestDir(digest), "manifest.json");
  }

  private cacheManifest(digest: string, manifest: ArtifactManifest): ArtifactManifest {
    this.manifests.delete(digest);
    this.manifests.set(digest, manifest);
    if (this.manifests.size > MANIFEST_CACHE_MAX)
      this.manifests.delete(this.manifests.keys().next().value as string);
    return manifest;
  }

  /**
   * The manifest as it is on disk, right now.
   *
   * Every tamper check — `verify`, and the second-put comparison — goes
   * through this rather than the cache, because a cached copy would answer
   * with the bytes an edit was meant to be caught against.
   */
  private readManifest(digest: string): ArtifactManifest | null {
    try {
      return this.cacheManifest(
        digest,
        JSON.parse(fs.readFileSync(this.manifestPath(digest), "utf8")) as ArtifactManifest
      );
    } catch {
      // Absence is never cached: a digest that is missing now can be published
      // a moment later, and a negative entry would hide it.
      this.manifests.delete(digest);
      return null;
    }
  }

  /** The manifest for the read path: parsed once per digest, then remembered. */
  private cachedManifest(digest: string): ArtifactManifest | null {
    const hit = this.manifests.get(digest);
    if (hit) {
      this.manifests.delete(digest); // re-insert = most recently used
      this.manifests.set(digest, hit);
      return hit;
    }
    return this.readManifest(digest);
  }

  async put(outputDir: string, provenance: ArtifactProvenance): Promise<Artifact> {
    if (!fs.existsSync(outputDir))
      throw new HostedError("invalid_input", `There is no build output at ${outputDir}.`, {
        fix: "Store an artifact only after a runner reported ok with an outputDir.",
      });

    const raw = walkOutput(outputDir);
    if (raw.length === 0)
      throw new HostedError("invalid_input", "The build output is empty.", {
        fix: "A publishable artifact needs at least index.html. Re-run the build.",
      });
    const files: ArtifactFile[] = raw.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: sha256(file.bytes),
      contentType: artifactContentType(file.path),
    }));
    if (!files.some((f) => f.path === "index.html"))
      throw new HostedError("invalid_input", "The build output has no index.html at its root.", {
        fix: "The gateway serves index.html for every app route. Re-run the build.",
      });

    const digest = artifactDigest(files);
    const artifact: Artifact = {
      digest,
      byteSize: files.reduce((sum, f) => sum + f.bytes, 0),
      fileCount: files.length,
      provenance,
      createdAt: new Date().toISOString(),
    };

    const existing = this.readManifest(digest);
    if (existing) return this.reuse(existing, files, digest);

    fs.mkdirSync(path.join(this.root, "sha256"), { recursive: true });
    const staging = fs.mkdtempSync(path.join(this.root, "sha256", `.staging-${digest.slice(0, 12)}-`));
    try {
      for (const file of raw) {
        const target = path.join(staging, "files", ...file.path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.bytes);
      }
      const manifest: ArtifactManifest = { artifact, files };
      fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      try {
        fs.renameSync(staging, this.digestDir(digest));
      } catch (err) {
        // Another writer won the race with identical bytes; that is the whole
        // point of content addressing, so accept theirs rather than overwrite.
        const raced = this.readManifest(digest);
        if (!raced) throw err;
        return this.reuse(raced, files, digest);
      }
      this.cacheManifest(digest, manifest);
      return artifact;
    } finally {
      removeQuietly(staging);
    }
  }

  /** A second put of identical bytes: check the stored manifest still agrees, return it. */
  private reuse(stored: ArtifactManifest, computed: ArtifactFile[], digest: string): Artifact {
    const same =
      stored.files.length === computed.length &&
      [...stored.files].sort(byPath).every((file, i) => {
        const other = computed[i];
        return other !== undefined && file.path === other.path && file.sha256 === other.sha256;
      });
    if (!same)
      throw new HostedError("conflict", `The stored artifact ${digest} does not match the output that was just built.`, {
        fix: "Run verify() on that digest: the stored manifest has been edited, because identical bytes cannot produce a different file table.",
        details: { digest },
      });
    return stored.artifact;
  }

  async get(digest: string): Promise<Artifact | null> {
    if (!DIGEST_RE.test(digest)) return null;
    return this.cachedManifest(digest)?.artifact ?? null;
  }

  async list(digest: string): Promise<ArtifactFile[]> {
    if (!DIGEST_RE.test(digest)) return [];
    return this.cachedManifest(digest)?.files ?? [];
  }

  /**
   * Everything about one file except its bytes.
   *
   * The gateway answers `HEAD` and a 304 from this alone — both need the
   * etag and the length and neither sends a body, so reading the file would be
   * work thrown away. Every check `open` makes is made here, including the
   * filesystem one, so a stat-only answer can never be more permissive than a
   * read.
   */
  statFile(digest: string, relative: string): ArtifactStat | null {
    if (!DIGEST_RE.test(digest)) return null;
    const normalised = artifactPath(relative);
    if (!normalised) return null;
    const manifest = this.cachedManifest(digest);
    if (!manifest) return null;
    const file = manifest.files.find((f) => f.path === normalised);
    if (!file) return null;
    const target = path.join(this.digestDir(digest), "files", ...normalised.split("/"));
    // The manifest is the index, but the filesystem answer is checked too: a
    // path that resolves outside the artifact is never read, whatever it says.
    const base = path.join(this.digestDir(digest), "files");
    const relativeToBase = path.relative(base, target);
    if (relativeToBase.startsWith("..") || path.isAbsolute(relativeToBase)) return null;
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return null;
    return { file, size: stat.size, absolute: target };
  }

  /**
   * The bytes of one file, or of one byte range of it.
   *
   * A range is read positionally: a client asking for the last 64 KB of a
   * large asset must not cost the whole asset in memory first.
   */
  readFile(stat: ArtifactStat, range?: { start: number; end: number }): Buffer {
    if (!range) return fs.readFileSync(stat.absolute);
    const length = Math.max(0, range.end - range.start + 1);
    if (length === 0) return Buffer.alloc(0);
    const fd = fs.openSync(stat.absolute, "r");
    try {
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, range.start);
      return read === length ? buf : buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  }

  async open(digest: string, relative: string): Promise<{ bytes: Buffer; file: ArtifactFile } | null> {
    const stat = this.statFile(digest, relative);
    if (!stat) return null;
    return { bytes: this.readFile(stat), file: stat.file };
  }

  async verify(digest: string): Promise<{ ok: boolean; detail: string }> {
    if (!DIGEST_RE.test(digest)) return { ok: false, detail: `"${digest}" is not a sha256 hex digest.` };
    const manifest = this.readManifest(digest);
    if (!manifest) return { ok: false, detail: `No artifact ${digest} is stored.` };

    const base = path.join(this.digestDir(digest), "files");
    let present: { path: string; bytes: Buffer }[];
    try {
      present = walkOutput(base);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    const onDisk = new Map(present.map((f) => [f.path, f.bytes]));

    for (const file of manifest.files) {
      const bytes = onDisk.get(file.path);
      if (!bytes) return { ok: false, detail: `${file.path} is listed in the manifest but missing from the store.` };
      if (bytes.length !== file.bytes)
        return { ok: false, detail: `${file.path} is ${bytes.length} bytes; the manifest records ${file.bytes}.` };
      const actual = sha256(bytes);
      if (actual !== file.sha256)
        return { ok: false, detail: `${file.path} has changed: sha256 ${actual}, manifest ${file.sha256}.` };
      onDisk.delete(file.path);
    }
    if (onDisk.size > 0)
      return { ok: false, detail: `${[...onDisk.keys()].sort().join(", ")} is stored but not listed in the manifest.` };

    const recomputed = artifactDigest(manifest.files);
    if (recomputed !== digest)
      return { ok: false, detail: `The manifest's file table hashes to ${recomputed}, not to its own key ${digest}.` };
    if (manifest.artifact.digest !== digest)
      return { ok: false, detail: `The manifest records digest ${manifest.artifact.digest} under the key ${digest}.` };

    return { ok: true, detail: `${manifest.files.length} files, ${manifest.artifact.byteSize} bytes, digest matches.` };
  }

  async remove(digest: string, referencedBy: (digest: string) => Promise<boolean>): Promise<boolean> {
    if (!DIGEST_RE.test(digest)) return false;
    if (!fs.existsSync(this.digestDir(digest))) return false;
    if (await referencedBy(digest)) return false;
    removeQuietly(this.digestDir(digest));
    this.manifests.delete(digest);
    return !fs.existsSync(this.digestDir(digest));
  }

  /**
   * Record that the trusted publisher recomputed this artifact's bytes.
   *
   * Not part of `ArtifactStore`: only `verifyForRelease` calls it, and it never
   * touches `files/`, so the digest the artifact is keyed by cannot change.
   */
  markVerified(digest: string, at: string = new Date().toISOString()): Artifact | null {
    const manifest = this.readManifest(digest);
    if (!manifest) return null;
    const updated: ArtifactManifest = { ...manifest, artifact: { ...manifest.artifact, verifiedAt: at } };
    const temporary = `${this.manifestPath(digest)}.${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`);
    fs.renameSync(temporary, this.manifestPath(digest));
    this.cacheManifest(digest, updated);
    return updated.artifact;
  }

  /** Every digest the store holds, in lexical order. */
  digests(): string[] {
    const dir = path.join(this.root, "sha256");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DIGEST_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }
}
