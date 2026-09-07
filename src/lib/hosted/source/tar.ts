/**
 * A bounded ustar/GNU tar reader for untrusted submissions.
 *
 * This is the first code that touches bytes a stranger uploaded, so it is
 * deliberately small, dependency-free and pessimistic: it decodes headers by
 * hand, verifies the header checksum, refuses every entry type that is not a
 * plain file or a directory, and stops the moment a limit in `SOURCE_LIMITS`
 * is crossed. Nothing here writes to disk and nothing here executes.
 *
 * Rejections are collected rather than thrown one at a time, so a builder sees
 * every problem in one answer (`unsupported_source` with `details.reasons`).
 *
 * Workstream W2 (hosted R3).
 */
import zlib from "node:zlib";
import { HostedError, SOURCE_LIMITS, type SourceFile } from "@/lib/hosted/contracts";

/** Fix sentence repeated by every intake refusal, so the builder reads one instruction. */
export const SOURCE_FIX =
  "Fix every listed entry and submit the source again. Supported source contract v1 is a React + Vite frontend: index.html, zenith.app.json, an optional metadata-only package.json, and files under src/ and public/.";

const BLOCK = 512;

/** Windows refuses these basenames outright; a submission must not force a materialize failure. */
const RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** A path that survived validation, with the depth the limits were checked against. */
export type SafePath = { ok: true; path: string; depth: number } | { ok: false; reason: string };

/**
 * Decode one submitted path into a forward-slash relative path, or say why not.
 *
 * The checks are the ones that turn an archive entry into a file outside the
 * source root: absolute paths, `..` segments, backslashes (a separator on the
 * host this runs on), NUL and control characters, over-long paths and
 * over-deep trees. `.` segments and a trailing slash are normalised away.
 */
export function safeEntryPath(raw: string, kind: "file" | "directory" = "file"): SafePath {
  const what = kind === "directory" ? "directory" : "file";
  const shown = JSON.stringify(raw);
  if (raw.length === 0) return { ok: false, reason: "An archive entry has an empty path. Remove it." };
  if (raw.includes("\u0000"))
    return { ok: false, reason: `${shown}: a path may not contain a NUL byte. Rename the ${what}.` };
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f)
      return { ok: false, reason: `${shown}: a path may not contain control characters. Rename the ${what}.` };
  }
  if (raw.includes("\\"))
    return {
      ok: false,
      reason: `${shown}: a path may not contain a backslash. Use forward slashes relative to the source root.`,
    };
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw))
    return {
      ok: false,
      reason: `${shown}: an absolute path is not accepted. Submit paths relative to the source root.`,
    };

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..")
      return {
        ok: false,
        reason: `${shown}: a path may not contain a ".." segment. Submit paths relative to the source root.`,
      };
    const stem = (segment.split(".")[0] ?? "").toLowerCase();
    if (RESERVED_BASENAMES.has(stem))
      return {
        ok: false,
        reason: `${shown}: "${segment}" is a reserved device name on Windows hosts. Rename the ${what}.`,
      };
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, reason: `${shown}: the path names no ${what}. Remove the entry.` };

  const joined = segments.join("/");
  if (joined.length > SOURCE_LIMITS.maxPathLength)
    return {
      ok: false,
      reason: `${shown}: the path is ${joined.length} characters; the limit is ${SOURCE_LIMITS.maxPathLength}. Shorten it.`,
    };
  if (segments.length > SOURCE_LIMITS.maxDepth)
    return {
      ok: false,
      reason: `${joined}: the tree is ${segments.length} levels deep; the limit is ${SOURCE_LIMITS.maxDepth}. Flatten it.`,
    };
  return { ok: true, path: joined, depth: segments.length };
}

/** What one pass over an archive found: the usable files, the directories, and every refusal. */
export interface TarScan {
  files: SourceFile[];
  /** directory entries, kept so the contract checks can refuse an unsupported root directory */
  dirs: string[];
  reasons: string[];
}

const cstr = (buf: Buffer, offset: number, length: number): string => {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
};

/** Octal header field, or null when it is empty, malformed, or GNU base-256. */
function readOctal(buf: Buffer, offset: number, length: number): number | null {
  const first = buf[offset] ?? 0;
  if ((first & 0x80) !== 0) return null; // GNU base-256 only carries values this intake refuses anyway
  const text = buf
    .subarray(offset, offset + length)
    .toString("latin1")
    .replace(/\u0000/g, " ")
    .trim();
  if (text === "") return null;
  if (!/^[0-7]+$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function headerChecksumOk(header: Buffer): boolean {
  const stored = readOctal(header, 148, 8);
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const raw = i >= 148 && i < 156 ? 0x20 : header[i] ?? 0;
    unsigned += raw;
    signed += raw > 127 ? raw - 256 : raw;
  }
  return stored === unsigned || stored === signed;
}

const isAllZero = (buf: Buffer): boolean => {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
};

/**
 * Parse a pax extended header body. Only `path` and `size` are understood; any
 * other keyword is a refusal rather than something silently ignored, so a
 * record this reader does not model can never change how the entry behind it
 * is read.
 */
function parsePax(data: Buffer, reasons: string[]): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) {
      reasons.push("A pax extended header record has no length field. Re-create the archive with GNU tar or bsdtar.");
      return out;
    }
    const length = Number.parseInt(data.subarray(offset, space).toString("latin1"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) {
      reasons.push("A pax extended header record has an unusable length. Re-create the archive with GNU tar or bsdtar.");
      return out;
    }
    const record = data
      .subarray(space + 1, offset + length)
      .toString("utf8")
      .replace(/\n$/, "");
    const eq = record.indexOf("=");
    const key = eq === -1 ? record : record.slice(0, eq);
    const value = eq === -1 ? "" : record.slice(eq + 1);
    if (key === "path") out.path = value;
    else if (key === "size") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) out.size = parsed;
    } else {
      reasons.push(
        `A pax extended header carries "${key}", which this intake does not model. Re-create the archive without extended attributes.`
      );
    }
    offset += length;
  }
  return out;
}

function gunzip(bytes: Buffer, reasons: string[]): Buffer | null {
  try {
    return zlib.gunzipSync(bytes, { maxOutputLength: SOURCE_LIMITS.maxDecompressedBytes });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE")
      reasons.push(
        `The archive expands past the ${SOURCE_LIMITS.maxDecompressedBytes} byte decompression ceiling. Submit a source tree under ${SOURCE_LIMITS.maxTotalBytes} bytes.`
      );
    else reasons.push("The upload is not a readable gzip stream. Submit a tar or tar.gz archive.");
    return null;
  }
}

/**
 * Read every entry of an optionally gzipped tar buffer, collecting refusals.
 *
 * Entry-level refusals (a symlink, an over-sized file) do not stop the scan, so
 * the caller reports them together with the contract problems it finds in the
 * files that were readable. Structural damage (a bad checksum, a truncated
 * archive) stops the scan, because nothing after it can be trusted.
 */
export function scanTar(input: Buffer): TarScan {
  const reasons: string[] = [];
  const files: SourceFile[] = [];
  const dirs: string[] = [];

  if (input.length === 0) {
    reasons.push("The upload is empty. Submit a tar or tar.gz archive of the source root.");
    return { files, dirs, reasons };
  }

  const gzipped = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b;
  const buf = gzipped ? gunzip(input, reasons) : input;
  if (!buf) return { files, dirs, reasons };
  if (!gzipped && buf.length > SOURCE_LIMITS.maxDecompressedBytes) {
    reasons.push(
      `The archive is ${buf.length} bytes; the ceiling is ${SOURCE_LIMITS.maxDecompressedBytes}. Submit a smaller source tree.`
    );
    return { files, dirs, reasons };
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  let offset = 0;
  let pendingPath: string | undefined;
  let pendingSize: number | undefined;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isAllZero(header)) {
      const next = buf.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (next.length < BLOCK || isAllZero(next)) break; // end-of-archive marker
      reasons.push("The archive has a zero block in the middle of its entries. Re-create it with GNU tar or bsdtar.");
      break;
    }
    if (!headerChecksumOk(header)) {
      reasons.push("An archive header failed its checksum. Re-create the archive with GNU tar or bsdtar.");
      break;
    }

    const declared = readOctal(header, 124, 12);
    const size = pendingSize ?? declared;
    if (size === null || size === undefined) {
      reasons.push(
        "An archive header has a size field this intake cannot read. Re-create the archive with GNU tar or bsdtar."
      );
      break;
    }
    const dataLength = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + BLOCK + dataLength > buf.length) {
      reasons.push("The archive is truncated: an entry claims more bytes than the upload holds. Upload the whole file.");
      break;
    }
    const data = buf.subarray(offset + BLOCK, offset + BLOCK + size);
    const typeflag = String.fromCharCode(header[156] ?? 0);

    const magic = header.subarray(257, 262).toString("latin1");
    const prefix = magic === "ustar" ? cstr(header, 345, 155) : "";
    const named = cstr(header, 0, 100);
    const rawPath = pendingPath ?? (prefix ? `${prefix}/${named}` : named);
    pendingPath = undefined;
    pendingSize = undefined;
    offset += BLOCK + dataLength;

    if (typeflag === "x" || typeflag === "X") {
      const pax = parsePax(data, reasons);
      pendingPath = pax.path;
      pendingSize = pax.size;
      continue;
    }
    if (typeflag === "g") {
      reasons.push(
        "The archive carries a pax global header, which this intake does not model. Re-create it with GNU tar or bsdtar."
      );
      continue;
    }
    if (typeflag === "L") {
      pendingPath = data.toString("utf8").replace(/\u0000+$/, "");
      continue;
    }
    if (typeflag === "K") {
      reasons.push(`${JSON.stringify(rawPath)}: link entries are not accepted. Submit regular files only.`);
      continue;
    }
    if (typeflag === "1" || typeflag === "2") {
      const kind = typeflag === "1" ? "hard link" : "symbolic link";
      reasons.push(`${JSON.stringify(rawPath)}: a ${kind} is not accepted. Submit the file's own bytes instead.`);
      continue;
    }
    if (typeflag === "3" || typeflag === "4" || typeflag === "6" || typeflag === "7") {
      reasons.push(
        `${JSON.stringify(rawPath)}: device, FIFO and contiguous entries are not accepted. Submit regular files only.`
      );
      continue;
    }
    if (typeflag === "5") {
      const safe = safeEntryPath(rawPath, "directory");
      if (!safe.ok) reasons.push(safe.reason);
      else if (!dirs.includes(safe.path)) dirs.push(safe.path);
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\u0000") {
      reasons.push(
        `${JSON.stringify(rawPath)}: tar entry type "${typeflag}" is not accepted. Submit regular files and directories only.`
      );
      continue;
    }

    const safe = safeEntryPath(rawPath, "file");
    if (!safe.ok) {
      reasons.push(safe.reason);
      continue;
    }
    if (seen.has(safe.path)) {
      reasons.push(`${safe.path}: the archive holds this path twice. Submit one entry per path.`);
      continue;
    }
    if (size > SOURCE_LIMITS.maxFileBytes) {
      reasons.push(
        `${safe.path}: the file is ${size} bytes; the per-file limit is ${SOURCE_LIMITS.maxFileBytes}. Remove or shrink it.`
      );
      continue;
    }
    if (files.length + 1 > SOURCE_LIMITS.maxFiles) {
      reasons.push(
        `The archive holds more than ${SOURCE_LIMITS.maxFiles} files. Remove what the app does not need and submit again.`
      );
      break;
    }
    totalBytes += size;
    if (totalBytes > SOURCE_LIMITS.maxTotalBytes) {
      reasons.push(
        `The source tree is larger than ${SOURCE_LIMITS.maxTotalBytes} bytes. Remove what the app does not need and submit again.`
      );
      break;
    }
    seen.add(safe.path);
    files.push({ path: safe.path, bytes: Buffer.from(data) });
  }

  return { files, dirs, reasons };
}

/**
 * Every regular file in the archive, or one `unsupported_source` listing every
 * reason the archive was refused.
 */
export function readTar(input: Buffer): SourceFile[] {
  const scan = scanTar(input);
  if (scan.reasons.length > 0)
    throw new HostedError("unsupported_source", "This archive is not a supported source submission.", {
      fix: SOURCE_FIX,
      details: { reasons: scan.reasons },
    });
  return scan.files;
}
