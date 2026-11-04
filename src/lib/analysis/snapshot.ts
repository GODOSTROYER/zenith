/**
 * Repository intake: bytes in, a bounded `RepoSnapshot` out.
 *
 * This is the first code that touches a stranger's repository, so it is
 * pessimistic. Nothing is written to disk, executed, installed or evaluated.
 * Every entry is refused rather than "handled" when it could name a file
 * outside the repository (absolute path, `..`, backslash, NUL/control
 * characters) or is not plain text data (symlinks, hard links, devices,
 * binary content). Only files an analyser can use are kept: manifests, build
 * files, config and source by extension, under per-file and total caps.
 * `.env`-style files are rewritten to names-only before they are kept, so a
 * committed secret value never reaches the analysis.
 *
 * Why not `hosted/source/tar.ts`: that reader enforces the React+Vite source
 * contract (500 files, 2 MiB per file, 20 MiB decompressed, every link or
 * unknown entry a hard failure). Repository analysis needs different limits
 * and must SKIP-and-report hostile entries instead of aborting, because real
 * repositories legitimately contain symlinks. Its `safeEntryPath` idea is
 * mirrored here with configurable limits.
 *
 * Limits are a defence against resource exhaustion, not a guarantee: the
 * decompressed archive is held in memory (up to `maxUncompressedBytes`).
 */
import zlib from "node:zlib";
import { redactEnvFile, isEnvFileName } from "./envfile";
import { basename, displayPath } from "./text";
import {
  AnalysisInputError,
  DEFAULT_SNAPSHOT_LIMITS,
  type RepoFile,
  type RepoSnapshot,
  type SkipReason,
  type SkippedSummary,
  type SnapshotLimits,
  type SnapshotSource,
} from "./types";

/* ------------------------------ path relevance --------------------------- */

/** Directories whose contents are never analysed (vendored, generated, tests, docs). */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "site-packages",
  "bower_components",
  ".terraform",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "spec",
  "e2e",
  "fixtures",
  "fixture",
  "testdata",
]);

/**
 * Ignored only as the first path segment: a top-level `docs/` or `examples/` is
 * documentation and demos, but `apps/docs` is very often a real deployable site.
 */
const IGNORED_TOP_DIRS = new Set(["docs", "doc", "example", "examples", "sample", "samples"]);

export function isIgnoredPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.length > 1 && IGNORED_TOP_DIRS.has(segments[0])) return true;
  for (let i = 0; i < segments.length - 1; i++) if (IGNORED_DIRS.has(segments[i])) return true;
  return false;
}

const SENSITIVE_BASENAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "terraform.tfvars", "secrets.yml", "secrets.yaml", "secrets.json"]);
const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".tfstate", ".tfstate.backup", ".auto.tfvars", ".kdbx"];

/** Private keys, Terraform state and variables, package-manager credentials: present is a finding, content is never wanted. */
export function isSensitivePath(path: string): boolean {
  const lower = basename(path).toLowerCase();
  return SENSITIVE_BASENAMES.has(lower) || SENSITIVE_SUFFIXES.some((s) => lower.endsWith(s));
}

export type FileClass = "source" | "config" | "env" | "marker";

/** Present-or-absent signals; their content is never read, so it is not kept. */
const MARKER_BASENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "gemfile.lock", "poetry.lock", "pipfile.lock", "uv.lock", "go.sum", "gradlew", "mvnw"]);

const SOURCE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rb", ".go", ".java", ".kt", ".kts", ".php", ".rs"]);

const CONFIG_BASENAMES = new Set([
  "package.json",
  "composer.json",
  "vercel.json",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "rush.json",
  "pnpm-workspace.yaml",
  "procfile",
  "pyproject.toml",
  "pipfile",
  "setup.cfg",
  "alembic.ini",
  "go.mod",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "cargo.toml",
  "fly.toml",
  "netlify.toml",
  "render.yaml",
  "render.yml",
  "serverless.yml",
  "serverless.yaml",
  "schema.prisma",
  ".sequelizerc",
  "database.yml",
  "storage.yml",
  "sidekiq.yml",
  "config.ru",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "runtime.txt",
  "containerfile",
  "dockerfile",
]);

const K8S_DIRS = new Set(["k8s", "kubernetes", "deploy", "deployment", "deployments", "manifests", "kustomize", "overlays", "base"]);

/** What a path is for, or undefined when no analyser reads it. */
export function classifyPath(path: string): FileClass | undefined {
  if (isIgnoredPath(path)) return undefined;
  const base = basename(path);
  const lower = base.toLowerCase();
  if (isEnvFileName(lower)) return "env";
  if (CONFIG_BASENAMES.has(lower)) return "config";
  if (MARKER_BASENAMES.has(lower)) return "marker";
  if (lower === "index.html" && path.split("/").length <= 4) return "config";
  if (lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile")) return "config";
  if (/^(?:docker-)?compose(?:\.[a-z0-9_-]{1,30})?\.ya?ml$/.test(lower)) return "config";
  if (/^requirements(?:[-_.][a-z0-9_.-]{1,40})?\.txt$/.test(lower)) return "config";
  if (/^application(?:-[a-z0-9_]{1,30})?\.(?:properties|ya?ml)$/.test(lower)) return "config";
  if (lower.endsWith(".tf")) return "config";
  const dot = lower.lastIndexOf(".");
  const ext = dot === -1 ? "" : lower.slice(dot);
  const segments = path.split("/");
  if (ext === ".txt" && segments.length > 1 && segments[segments.length - 2] === "requirements") return "config";
  if ((ext === ".yml" || ext === ".yaml") && segments.slice(0, -1).some((s) => K8S_DIRS.has(s))) return "config";
  if (ext === ".sql" && segments.slice(0, -1).some((s) => /^(?:migrations?|migrate|db)$/.test(s))) return "marker";
  if (SOURCE_EXT.has(ext)) return "source";
  return undefined;
}

/* -------------------------------- path safety ---------------------------- */

/** Letters, digits and the punctuation real repositories use; no quotes, backticks, `;|&<>*?{}!` or `\`. */
const SAFE_PATH_CHARS = /^[\p{L}\p{N}._\-/@+~$()[\]#,= ]+$/u;

export type PathCheck = { ok: true; path: string } | { ok: false; reason: SkipReason };

/**
 * Normalise an entry path to forward-slash, repository-relative form, or say
 * why not. `.` segments and doubled slashes are dropped; `..` is refused.
 */
export function checkEntryPath(raw: string, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS): PathCheck {
  if (raw.length === 0) return { ok: false, reason: "bad_path" };
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { ok: false, reason: "bad_path" };
  }
  if (raw.includes("\\")) return { ok: false, reason: "bad_path" };
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return { ok: false, reason: "absolute_path" };
  // Paths reach evidence, explanations and manifests, so refuse shell/markup metacharacters outright.
  if (!SAFE_PATH_CHARS.test(raw)) return { ok: false, reason: "bad_path" };
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "traversal" };
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, reason: "bad_path" };
  const joined = segments.join("/");
  if (joined.length > limits.maxPathLength) return { ok: false, reason: "path_too_long" };
  if (segments.length > limits.maxDepth) return { ok: false, reason: "too_deep" };
  return { ok: true, path: joined };
}

/* ---------------------------------- builder ------------------------------ */

const BINARY_SNIFF = 8_000;

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Accumulates accepted files and a summary of everything refused. Every
 * intake path (tarball, GitHub, hand-built fixtures) goes through `add`, so
 * the same rules apply to all of them.
 */
export class SnapshotBuilder {
  private readonly kept = new Map<string, string>();
  private keptBytes = 0;
  private readonly skips = new Map<SkipReason, { count: number; examples: string[] }>();
  truncated = false;

  constructor(
    readonly limits: SnapshotLimits,
    private source: SnapshotSource
  ) {}

  setCommit(commit: string): void {
    this.source = { ...this.source, commit };
  }

  skip(reason: SkipReason, path?: string): void {
    const entry = this.skips.get(reason) ?? { count: 0, examples: [] };
    entry.count++;
    if (path !== undefined && reason !== "irrelevant" && entry.examples.length < 3) entry.examples.push(displayPath(path));
    this.skips.set(reason, entry);
  }

  /** Offer one regular file (already path-normalised) to the snapshot. */
  add(path: string, bytes: Uint8Array): void {
    if (this.kept.has(path)) return this.skip("duplicate", path);
    if (isIgnoredPath(path)) return this.skip("irrelevant", path);
    // Files that usually hold secrets are never read; they are counted so the analysis can say they exist.
    if (isSensitivePath(path)) return this.skip("sensitive", path);
    const cls = classifyPath(path);
    if (cls === undefined) return this.skip("irrelevant", path);
    // A marker's bytes are dropped, so its size and encoding do not matter.
    if (cls !== "marker" && bytes.length > this.limits.maxFileBytes) return this.skip("oversize", path);
    if (this.kept.size >= this.limits.maxKeptFiles) {
      this.truncated = true;
      return this.skip("limit_kept_files", path);
    }
    if (cls !== "marker" && this.keptBytes + bytes.length > this.limits.maxKeptBytes) {
      this.truncated = true;
      return this.skip("limit_kept_bytes", path);
    }
    if (cls !== "marker" && looksBinary(bytes)) return this.skip("binary", path);
    let text = cls === "marker" ? "" : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    if (cls === "env") text = redactEnvFile(text);
    this.keptBytes += text.length;
    this.kept.set(path, text);
  }

  finish(): RepoSnapshot {
    const files: RepoFile[] = [...this.kept.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => ({ path, content }));
    const skipped: SkippedSummary[] = [...this.skips.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reason, v]) => ({ reason, count: v.count, examples: v.examples }));
    return { files, truncated: this.truncated, source: this.source, ...(skipped.length > 0 ? { skipped } : {}) };
  }
}

/**
 * Build a snapshot from an in-memory file map (fixtures, tests, callers that
 * already have the files). The same path-safety, relevance, size and redaction
 * rules apply as for a tarball.
 */
export function snapshotFromFiles(
  files: Record<string, string> | RepoFile[],
  opts: { source?: SnapshotSource; limits?: Partial<SnapshotLimits> } = {}
): RepoSnapshot {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...opts.limits };
  const builder = new SnapshotBuilder(limits, opts.source ?? { kind: "fixture" });
  const list: RepoFile[] = Array.isArray(files) ? files : Object.entries(files).map(([path, content]) => ({ path, content }));
  for (const f of [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const check = checkEntryPath(f.path, limits);
    if (!check.ok) {
      builder.skip(check.reason, f.path);
      continue;
    }
    builder.add(check.path, Buffer.from(f.content, "utf8"));
  }
  return builder.finish();
}

/* ------------------------------------ tar -------------------------------- */

const BLOCK = 512;

const cstr = (buf: Buffer, offset: number, length: number): string => {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
};

/** Octal header field; null when empty, malformed or GNU base-256. */
function readOctal(buf: Buffer, offset: number, length: number): number | null {
  if (((buf[offset] ?? 0) & 0x80) !== 0) return null;
  const text = buf
    .subarray(offset, offset + length)
    .toString("latin1")
    .replace(/\u0000/g, " ")
    .trim();
  if (text === "" || !/^[0-7]{1,20}$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function checksumOk(header: Buffer): boolean {
  const stored = readOctal(header, 148, 8);
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const raw = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    unsigned += raw;
    signed += raw > 127 ? raw - 256 : raw;
  }
  return stored === unsigned || stored === signed;
}

const isZeroBlock = (buf: Buffer): boolean => {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
};

/** `path`, `size` and (global) `comment` from a pax record body. Other keys are ignored. */
function parsePax(data: Buffer): { path?: string; size?: number; comment?: string } {
  const out: { path?: string; size?: number; comment?: string } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("latin1"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) break;
    const record = data
      .subarray(space + 1, offset + length)
      .toString("utf8")
      .replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq !== -1) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === "path") out.path = value;
      else if (key === "comment") out.comment = value;
      else if (key === "size") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isSafeInteger(parsed) && parsed >= 0) out.size = parsed;
      }
    }
    offset += length;
  }
  return out;
}

interface RawEntry {
  path: string;
  kind: "file" | "dir" | "symlink" | "hardlink" | "special";
  dataStart: number;
  size: number;
}

const SINGLE_TOP_KEEP = new Set(["src", "app", "lib", "pkg", "cmd", "internal", "config", "public", "static", "scripts", "apps", "packages", "services", "prisma", "db"]);

function gunzip(input: Buffer, limits: SnapshotLimits): Buffer {
  const gzipped = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b;
  if (!gzipped) {
    if (input.length > limits.maxUncompressedBytes)
      throw new AnalysisInputError("uncompressed_too_large", `The archive is larger than the ${limits.maxUncompressedBytes} byte ceiling.`);
    return input;
  }
  try {
    return zlib.gunzipSync(input, { maxOutputLength: limits.maxUncompressedBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      throw new AnalysisInputError("uncompressed_too_large", `The archive expands past the ${limits.maxUncompressedBytes} byte decompression ceiling.`);
    throw new AnalysisInputError("not_gzip", "The upload is not a readable gzip stream.");
  }
}

/**
 * Read a (gzipped) tar buffer into a snapshot.
 *
 * Refused-and-reported, never thrown, per entry: links, devices, traversal and
 * absolute paths, oversize and binary files. Thrown for the archive as a
 * whole: empty input, compressed size over the cap, decompression over the
 * cap, unreadable gzip. A damaged or truncated tar stops the read and marks
 * the snapshot `truncated`.
 *
 * `stripComponents`: `"auto"` removes a single shared top-level directory
 * (what `git archive --prefix` and GitHub produce) unless it is a conventional
 * source directory such as `src`; a number strips exactly that many leading
 * components.
 */
export function snapshotFromTarball(
  input: Buffer,
  limits: Partial<SnapshotLimits> = {},
  opts: { source?: SnapshotSource; stripComponents?: number | "auto" } = {}
): RepoSnapshot {
  const lim: SnapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
  if (input.length === 0) throw new AnalysisInputError("empty_archive", "The upload is empty.");
  if (input.length > lim.maxCompressedBytes)
    throw new AnalysisInputError("compressed_too_large", `The archive is ${input.length} bytes; the ceiling is ${lim.maxCompressedBytes}.`);
  const buf = gunzip(input, lim);
  const builder = new SnapshotBuilder(lim, opts.source ?? { kind: "tarball" });

  /* pass 1: walk headers, no copying */
  const entries: RawEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  let pendingSize: number | undefined;
  let commit: string | undefined;
  let seen = 0;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;
    if (!checksumOk(header)) {
      builder.truncated = true;
      break;
    }
    const size = pendingSize ?? readOctal(header, 124, 12);
    if (size === null || size === undefined) {
      builder.truncated = true;
      break;
    }
    const dataStart = offset + BLOCK;
    const paddedEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + size > buf.length) {
      builder.truncated = true; // archive cut short
      break;
    }
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const posix = header.subarray(257, 263).toString("latin1") === "ustar\u0000" && header.subarray(263, 265).toString("latin1") === "00";
    const prefix = posix ? cstr(header, 345, 155) : "";
    const named = cstr(header, 0, 100);
    const rawPath = pendingPath ?? (prefix ? `${prefix}/${named}` : named);
    pendingPath = undefined;
    pendingSize = undefined;
    offset = paddedEnd;

    if (typeflag === "x" || typeflag === "X") {
      const pax = parsePax(buf.subarray(dataStart, dataStart + size));
      pendingPath = pax.path;
      pendingSize = pax.size;
      continue;
    }
    if (typeflag === "g") {
      const c = parsePax(buf.subarray(dataStart, dataStart + size)).comment;
      if (c !== undefined && /^[0-9a-f]{40}$/.test(c)) commit = c;
      continue;
    }
    if (typeflag === "L") {
      pendingPath = buf
        .subarray(dataStart, dataStart + size)
        .toString("utf8")
        .replace(/\u0000+$/, "");
      continue;
    }
    if (typeflag === "K") continue; // GNU long link target: only ever paired with a link entry

    seen++;
    if (seen > lim.maxEntries) {
      builder.truncated = true;
      builder.skip("limit_entries");
      break;
    }
    const kind: RawEntry["kind"] =
      typeflag === "0" || typeflag === "\u0000" ? "file" : typeflag === "5" ? "dir" : typeflag === "2" ? "symlink" : typeflag === "1" ? "hardlink" : "special";
    entries.push({ path: rawPath, kind, dataStart, size });
  }

  /* strip prefix */
  const strip = decideStrip(
    entries.filter((e) => e.kind === "file" || e.kind === "dir"),
    opts.stripComponents ?? "auto"
  );

  /* pass 2: filter and keep */
  for (const e of entries) {
    if (e.kind === "symlink") {
      builder.skip("symlink", e.path);
      continue;
    }
    if (e.kind === "hardlink") {
      builder.skip("hardlink", e.path);
      continue;
    }
    if (e.kind === "special") {
      builder.skip("special_entry", e.path);
      continue;
    }
    const check = checkEntryPath(e.path, lim);
    if (!check.ok) {
      builder.skip(check.reason, e.path);
      continue;
    }
    if (e.kind === "dir") continue;
    const parts = check.path.split("/");
    if (parts.length <= strip) continue; // the stripped directory's own files (none) or a bare top entry
    const rel = parts.slice(strip).join("/");
    builder.add(rel, buf.subarray(e.dataStart, e.dataStart + e.size));
  }

  const snapshot = builder.finish();
  return commit !== undefined ? { ...snapshot, source: { ...snapshot.source, commit } } : snapshot;
}

function decideStrip(entries: { path: string; kind: RawEntry["kind"] }[], mode: number | "auto"): number {
  if (typeof mode === "number") return Math.max(0, Math.floor(mode));
  const tops = new Set<string>();
  let rootFile = false;
  for (const e of entries) {
    const check = checkEntryPath(e.path);
    if (!check.ok) continue; // refused entries must not influence how the rest is read
    const parts = check.path.split("/");
    tops.add(parts[0]);
    if (parts.length === 1 && e.kind === "file") rootFile = true;
  }
  if (tops.size !== 1 || rootFile) return 0;
  const [only] = [...tops];
  return SINGLE_TOP_KEEP.has(only) ? 0 : 1;
}
