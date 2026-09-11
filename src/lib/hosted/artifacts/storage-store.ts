/**
 * The artifact store, backed by object storage instead of local disk.
 *
 * `FsArtifactStore` gets create-only for free: a digest directory is built in a
 * temporary directory and moved into place with one `rename`, so a reader never
 * sees half an artifact. Object storage has no rename and no directories, so the
 * same two properties are bought a different way:
 *
 *  - **Create-only.** Every object is uploaded with `x-upsert: false`, so a
 *    write can only ever create. The *manifest is uploaded last*, after every
 *    file it lists — and the manifest is the only thing `get`/`list`/`open`
 *    consult, so a digest whose upload died half way through is simply not
 *    there, and a later put of the same bytes finishes the job. A put whose
 *    digest already has a manifest verifies that manifest against what it just
 *    computed and returns the stored record, exactly as the filesystem store's
 *    second-put path does.
 *  - **Re-checkable.** `verify()` downloads every listed file and recomputes
 *    its hash, the file table's digest and the manifest's own key, so the
 *    trusted publisher asks this store the same question it asks the other one.
 *
 * Layout, under `ZENITH_ARTIFACT_BUCKET` (a private bucket — every read here is
 * a service-role request, nothing is ever served to a browser directly):
 *
 *     sha256/<digest>/manifest.json
 *     sha256/<digest>/files/<path>
 *
 * `statFile`/`readFile` are deliberately **not** implemented. They are the
 * filesystem store's shortcut for answering `HEAD` and `304` without reading
 * bytes; here there is no such shortcut — a stat would be a second network round
 * trip — so the gateway's feature detection (`gateway/artifacts.ts`) falls
 * through to awaiting `open()`, which is the contract every store signs.
 */
import fs from "node:fs";
import {
  HostedError,
  type Artifact,
  type ArtifactFile,
  type ArtifactProvenance,
  type ArtifactStore,
} from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { byPath, sha256 } from "@/lib/hosted/digest";
import { artifactContentType, artifactDigest, artifactPath, walkOutput, type ArtifactManifest } from "./store";

const DIGEST_RE = /^[0-9a-f]{64}$/;

/** Same ceiling as the filesystem store; a Map is the stdlib's LRU. */
const MANIFEST_CACHE_MAX = 64;

/** One byte range, inclusive at both ends — the shape `serveArtifact` parses. */
export interface ByteRange {
  start: number;
  end: number;
}

/** What `StorageArtifactStore` needs to reach Supabase Storage. */
export interface StorageStoreOptions {
  /** Project URL; defaults to `NEXT_PUBLIC_SUPABASE_URL`, read at call time. */
  url?: string;
  /** Service-role key; defaults to `SUPABASE_SERVICE_ROLE_KEY`, read at call time. */
  key?: string;
  /** Bucket; defaults to `ZENITH_ARTIFACT_BUCKET`. */
  bucket?: string;
  /**
   * Key prefix every object sits under. Empty in production — the bucket is
   * the artifact store. A contract test sets one so the bytes it writes into a
   * real bucket are identifiable, and deletable, as its own.
   */
  prefix?: string;
  /** The transport. Injectable so a test can answer without a network. */
  fetch?: typeof fetch;
}

/** The object key for one file of an artifact. */
export const artifactObjectKey = (digest: string, relative: string): string =>
  `sha256/${digest}/files/${relative}`;

/** The object key for an artifact's manifest. */
export const artifactManifestKey = (digest: string): string => `sha256/${digest}/manifest.json`;

/** The prefix everything about one artifact lives under. */
const artifactPrefix = (digest: string): string => `sha256/${digest}`;

/** Percent-encode each path segment; the separators stay separators. */
const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

/** One entry of a Storage list response; a folder has a null `id`. */
interface StorageListEntry {
  name: string;
  id: string | null;
}

export class StorageArtifactStore implements ArtifactStore {
  private readonly options: StorageStoreOptions;

  /** digest → parsed manifest; immutable by content address, so never invalidated. */
  private readonly manifests = new Map<string, ArtifactManifest>();

  constructor(options: StorageStoreOptions = {}) {
    this.options = options;
  }

  /* --------------------------------- keys ---------------------------------- */

  /** The configured prefix, normalised to "" or to something ending in "/". */
  private get prefix(): string {
    const raw = this.options.prefix ?? "";
    return raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
  }

  private objectKey(digest: string, relative: string): string {
    return `${this.prefix}${artifactObjectKey(digest, relative)}`;
  }

  private manifestKey(digest: string): string {
    return `${this.prefix}${artifactManifestKey(digest)}`;
  }

  private prefixOf(digest: string): string {
    return `${this.prefix}${artifactPrefix(digest)}`;
  }

  /* ------------------------------ transport ------------------------------- */

  /**
   * The project URL, service-role key and bucket — read on every call rather
   * than captured in the constructor, so a process that exports them late (a
   * test, a script sourcing `.env.local`) still gets them.
   */
  private config(): { url: string; key: string; bucket: string } {
    const url = (this.options.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
    const key = this.options.key ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const bucket = this.options.bucket ?? hostedConfig().ZENITH_ARTIFACT_BUCKET;
    if (!url || !key)
      throw new HostedError(
        "internal",
        "The artifact store is object storage, but the project URL and service-role key are not set.",
        {
          fix: "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only; never shipped to a browser), or set ZENITH_HOSTED_STORE=sqlite to use the local artifact directory.",
        }
      );
    return { url, key, bucket };
  }

  private async request(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const { url, key } = this.config();
    const send = this.options.fetch ?? globalThis.fetch;
    try {
      return await send(`${url}/storage/v1/${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, apikey: key, ...init.headers },
        body: init.body,
      });
    } catch (err) {
      // The key is never in the message: only the endpoint that failed.
      throw new HostedError("internal", `Object storage did not answer: ${err instanceof Error ? err.message : String(err)}`, {
        fix: "Check that the Supabase project is reachable from this host and that the artifact bucket exists.",
      });
    }
  }

  /** Turn a non-2xx Storage answer into a HostedError that names the object. */
  private async fail(res: Response, what: string): Promise<never> {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      detail = "";
    }
    throw new HostedError("internal", `Object storage refused ${what} with ${res.status}. ${detail}`.trim(), {
      fix: "Check the bucket exists and the service-role key belongs to this project.",
    });
  }

  /* -------------------------------- objects -------------------------------- */

  /** Upload one object, create-only. `true` when it was created, `false` when it already existed. */
  private async upload(key: string, bytes: Buffer, contentType: string): Promise<boolean> {
    const { bucket } = this.config();
    const res = await this.request("POST", `object/${bucket}/${encodeKey(key)}`, {
      headers: { "content-type": contentType, "x-upsert": "false", "cache-control": "max-age=31536000" },
      body: new Uint8Array(bytes),
    });
    if (res.ok) return true;
    // A duplicate is the create-only guarantee doing its job. The bytes under a
    // content-addressed key cannot differ, so an existing object is the same
    // object: an earlier put that died before its manifest, or a concurrent one.
    if (res.status === 409) return false;
    return this.fail(res, `an upload of ${key}`);
  }

  /** Download one object, or one byte range of it; null when it is not there. */
  private async download(key: string, range?: ByteRange): Promise<Buffer | null> {
    const { bucket } = this.config();
    // The range goes to Storage as a `range` header, so a client asking for the
    // last few KB of a large asset costs those KB and not the whole object.
    const headers = range ? { range: `bytes=${range.start}-${range.end}` } : undefined;
    const res = await this.request("GET", `object/${bucket}/${encodeKey(key)}`, { headers });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok && res.status !== 206) return this.fail(res, `a read of ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Every object key under a prefix, recursively, in listing order. */
  private async listPrefix(prefix: string): Promise<string[]> {
    const { bucket } = this.config();
    const out: string[] = [];
    let offset = 0;
    for (;;) {
      const res = await this.request("POST", `object/list/${bucket}`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prefix,
          limit: 100,
          offset,
          sortBy: { column: "name", order: "asc" },
        }),
      });
      if (!res.ok) return this.fail(res, `a listing of ${prefix}`);
      const page = (await res.json()) as StorageListEntry[];
      if (!Array.isArray(page) || page.length === 0) break;
      for (const entry of page) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) out.push(...(await this.listPrefix(key)));
        else out.push(key);
      }
      if (page.length < 100) break;
      offset += page.length;
    }
    return out;
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const { bucket } = this.config();
    const res = await this.request("DELETE", `object/${bucket}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefixes: keys }),
    });
    if (!res.ok) return this.fail(res, `a delete of ${keys.length} object(s)`);
  }

  /* ------------------------------- manifests ------------------------------- */

  private cacheManifest(digest: string, manifest: ArtifactManifest): ArtifactManifest {
    this.manifests.delete(digest);
    this.manifests.set(digest, manifest);
    if (this.manifests.size > MANIFEST_CACHE_MAX)
      this.manifests.delete(this.manifests.keys().next().value as string);
    return manifest;
  }

  /**
   * The manifest object as it is right now — one GET, no cache.
   *
   * Every tamper check goes through this, for the same reason the filesystem
   * store's does: a cached copy would answer with the bytes an edit was meant
   * to be caught against.
   */
  private async readManifest(digest: string): Promise<ArtifactManifest | null> {
    const bytes = await this.download(this.manifestKey(digest));
    if (!bytes) {
      // Absence is never cached: a digest missing now can be published a moment
      // later, and a negative entry would hide it.
      this.manifests.delete(digest);
      return null;
    }
    try {
      return this.cacheManifest(digest, JSON.parse(bytes.toString("utf8")) as ArtifactManifest);
    } catch {
      this.manifests.delete(digest);
      return null;
    }
  }

  /**
   * The manifest for the read path: fetched once per digest, then remembered.
   *
   * Safe without invalidation because the thing cached is immutable by
   * construction — the manifest under `sha256/<digest>/` describes bytes that
   * hash to that digest, and nothing but `remove` (which clears the entry) ever
   * takes it away.
   */
  private async cachedManifest(digest: string): Promise<ArtifactManifest | null> {
    const hit = this.manifests.get(digest);
    if (hit) {
      this.manifests.delete(digest); // re-insert = most recently used
      this.manifests.set(digest, hit);
      return hit;
    }
    return this.readManifest(digest);
  }

  /* --------------------------------- store --------------------------------- */

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

    const existing = await this.readManifest(digest);
    if (existing) return reuse(existing, files, digest);

    const byPathType = new Map(files.map((f) => [f.path, f.contentType]));
    for (const file of raw)
      await this.upload(
        this.objectKey(digest, file.path),
        file.bytes,
        byPathType.get(file.path) ?? "application/octet-stream"
      );

    // Last, and only now: the manifest is what every read consults, so until
    // this object exists the digest does not exist as far as anything else is
    // concerned.
    const manifest: ArtifactManifest = { artifact, files };
    const created = await this.upload(
      this.manifestKey(digest),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      "application/json; charset=utf-8"
    );
    if (!created) {
      // Another writer finished first with identical bytes; that is the whole
      // point of content addressing, so accept theirs rather than overwrite.
      const raced = await this.readManifest(digest);
      if (raced) return reuse(raced, files, digest);
    }
    this.cacheManifest(digest, manifest);
    return artifact;
  }

  async get(digest: string): Promise<Artifact | null> {
    if (!DIGEST_RE.test(digest)) return null;
    return (await this.cachedManifest(digest))?.artifact ?? null;
  }

  async list(digest: string): Promise<ArtifactFile[]> {
    if (!DIGEST_RE.test(digest)) return [];
    return (await this.cachedManifest(digest))?.files ?? [];
  }

  /**
   * The bytes of one file, or of one byte range of it.
   *
   * `range` is an extension of the contract, not a replacement for it: the
   * gateway's fallback calls `open(digest, path)` and slices, while a caller
   * that already parsed a `Range` header can hand it here and pay only for the
   * bytes it asked for. The returned `file` is always the manifest record — the
   * full size and the whole file's sha256 — which is what `serveArtifact` needs
   * to answer 206 and 416 correctly even when the body is a slice.
   */
  async open(
    digest: string,
    relative: string,
    range?: ByteRange
  ): Promise<{ bytes: Buffer; file: ArtifactFile } | null> {
    if (!DIGEST_RE.test(digest)) return null;
    const normalised = artifactPath(relative);
    if (!normalised) return null;
    const manifest = await this.cachedManifest(digest);
    if (!manifest) return null;
    const file = manifest.files.find((f) => f.path === normalised);
    if (!file) return null;
    const bytes = await this.download(this.objectKey(digest, normalised), range);
    if (!bytes) return null;
    return { bytes, file };
  }

  async verify(digest: string): Promise<{ ok: boolean; detail: string }> {
    if (!DIGEST_RE.test(digest)) return { ok: false, detail: `"${digest}" is not a sha256 hex digest.` };
    const manifest = await this.readManifest(digest);
    if (!manifest) return { ok: false, detail: `No artifact ${digest} is stored.` };

    const stored = new Set(await this.listPrefix(`${this.prefixOf(digest)}/files`));
    for (const file of manifest.files) {
      const key = this.objectKey(digest, file.path);
      const bytes = await this.download(key);
      if (!bytes) return { ok: false, detail: `${file.path} is listed in the manifest but missing from the store.` };
      if (bytes.length !== file.bytes)
        return { ok: false, detail: `${file.path} is ${bytes.length} bytes; the manifest records ${file.bytes}.` };
      const actual = sha256(bytes);
      if (actual !== file.sha256)
        return { ok: false, detail: `${file.path} has changed: sha256 ${actual}, manifest ${file.sha256}.` };
      stored.delete(key);
    }
    if (stored.size > 0) {
      const extra = [...stored]
        .map((key) => key.slice(`${this.prefixOf(digest)}/files/`.length))
        .sort()
        .join(", ");
      return { ok: false, detail: `${extra} is stored but not listed in the manifest.` };
    }

    const recomputed = artifactDigest(manifest.files);
    if (recomputed !== digest)
      return { ok: false, detail: `The manifest's file table hashes to ${recomputed}, not to its own key ${digest}.` };
    if (manifest.artifact.digest !== digest)
      return { ok: false, detail: `The manifest records digest ${manifest.artifact.digest} under the key ${digest}.` };

    return { ok: true, detail: `${manifest.files.length} files, ${manifest.artifact.byteSize} bytes, digest matches.` };
  }

  async remove(digest: string, referencedBy: (digest: string) => Promise<boolean>): Promise<boolean> {
    if (!DIGEST_RE.test(digest)) return false;
    const keys = await this.listPrefix(this.prefixOf(digest));
    if (keys.length === 0) return false;
    if (await referencedBy(digest)) return false;
    // The manifest first: the moment it is gone the digest is unreadable, so a
    // reader can never meet a half-deleted artifact.
    const manifestKey = this.manifestKey(digest);
    if (keys.includes(manifestKey)) await this.deleteKeys([manifestKey]);
    await this.deleteKeys(keys.filter((key) => key !== manifestKey));
    this.manifests.delete(digest);
    return true;
  }
}

/** A second put of identical bytes: check the stored manifest still agrees, return it. */
function reuse(stored: ArtifactManifest, computed: ArtifactFile[], digest: string): Artifact {
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
