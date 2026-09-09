/**
 * The supported-source gate: everything a submission must satisfy before any
 * part of the platform touches it again.
 *
 * Two intakes, one contract. A tarball is read by `scanTar`; a directory is
 * walked with `lstat` so a symbolic link is refused rather than followed. Both
 * produce the same `SourceFile[]`, and both then meet the same checks from
 * `contracts/source-v1.ts`: the two required root files, an optional
 * metadata-only `package.json`, the allowed root entries, the allowed
 * extensions under `src/` and `public/`, and the always-rejected patterns.
 *
 * Every refusal is collected and raised once, so a builder fixes the whole
 * list in a single pass instead of discovering it one upload at a time.
 *
 * Nothing here executes submitted code; the only thing that ever runs is the
 * platform's own recipe, and it never reads a submitted config or script.
 *
 * Workstream W2 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_DEPENDENCIES,
  ALLOWED_EXTENSIONS,
  ALLOWED_ROOT_DIRS,
  ALLOWED_ROOT_FILES,
  HostedError,
  REJECTED_PATTERNS,
  SOURCE_LIMITS,
  SourceManifest,
  SourcePackageJson,
  type SourceFile,
  type ValidatedSource,
} from "@/lib/hosted/contracts";
import { byPath, sha256, treeDigest } from "@/lib/hosted/digest";
import { SOURCE_FIX, safeEntryPath, scanTar, type TarScan } from "./tar";

/** What `validateSource` accepts: an uploaded archive, or a directory on this host. */
export type SourceInput = { kind: "tarball"; bytes: Buffer } | { kind: "directory"; path: string };

/**
 * Walk a directory into the same shape a tarball produces, without ever
 * following a link.
 *
 * `readdirSync(withFileTypes)` reports the entry's own type (it does not
 * resolve links), and each entry is `lstat`ed before it is read, so a symlink
 * pointing at `/etc/shadow` is a refusal rather than a file in the source.
 */
export function scanDirectory(root: string): TarScan {
  const reasons: string[] = [];
  const files: SourceFile[] = [];
  const dirs: string[] = [];
  let totalBytes = 0;
  let stopped = false;

  const walk = (absolute: string, relative: string): void => {
    if (stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      reasons.push(`${relative || "."}: the directory could not be read. Check the path and its permissions.`);
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (stopped) return;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absolute, entry.name);
      const stat = fs.lstatSync(childAbsolute, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        reasons.push(`${childRelative}: a symbolic link is not accepted. Submit the file's own bytes instead.`);
        continue;
      }
      if (stat.isDirectory()) {
        const safe = safeEntryPath(childRelative, "directory");
        if (!safe.ok) {
          reasons.push(safe.reason);
          continue;
        }
        dirs.push(safe.path);
        walk(childAbsolute, safe.path);
        continue;
      }
      if (!stat.isFile()) {
        reasons.push(`${childRelative}: only regular files and directories are accepted.`);
        continue;
      }
      const safe = safeEntryPath(childRelative, "file");
      if (!safe.ok) {
        reasons.push(safe.reason);
        continue;
      }
      if (stat.size > SOURCE_LIMITS.maxFileBytes) {
        reasons.push(
          `${safe.path}: the file is ${stat.size} bytes; the per-file limit is ${SOURCE_LIMITS.maxFileBytes}. Remove or shrink it.`
        );
        continue;
      }
      if (files.length + 1 > SOURCE_LIMITS.maxFiles) {
        reasons.push(
          `The source tree holds more than ${SOURCE_LIMITS.maxFiles} files. Remove what the app does not need and submit again.`
        );
        stopped = true;
        return;
      }
      totalBytes += stat.size;
      if (totalBytes > SOURCE_LIMITS.maxTotalBytes) {
        reasons.push(
          `The source tree is larger than ${SOURCE_LIMITS.maxTotalBytes} bytes. Remove what the app does not need and submit again.`
        );
        stopped = true;
        return;
      }
      files.push({ path: safe.path, bytes: fs.readFileSync(childAbsolute) });
    }
  };

  const rootStat = fs.statSync(root, { throwIfNoEntry: false });
  if (!rootStat || !rootStat.isDirectory()) {
    reasons.push(`${root}: this is not a readable directory. Point the submission at the source root.`);
    return { files, dirs, reasons };
  }
  walk(root, "");
  return { files, dirs, reasons };
}

const extensionOf = (p: string): string => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

/**
 * The pinned source identity.
 *
 * `sourceDigest(files)` = SHA-256, hex, of the concatenation, over every file
 * sorted byte-wise by path, of:
 *
 *     <path> + "\0" + <sha256-hex of that file's bytes> + "\n"
 *
 * Only paths and content decide it: entry order, timestamps, permissions and
 * the archive framing do not. Two submissions with the same digest are the
 * same tree, whatever produced them.
 */
export function sourceDigest(files: SourceFile[]): string {
  return treeDigest(files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })));
}

function checkPackageJson(raw: Buffer, reasons: string[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    reasons.push("package.json: the file is not valid JSON. Fix the syntax or remove the file.");
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    reasons.push("package.json: the file must hold a JSON object. Fix it or remove the file.");
    return;
  }
  const record = parsed as Record<string, unknown>;

  // Named before the schema runs, because these are the three ways a submission
  // tries to make the platform execute something it wrote.
  if ("scripts" in record)
    reasons.push(
      'package.json: "scripts" is not accepted — the platform builds with its own pinned recipe and never runs a submitted script. Remove the field.'
    );
  if ("devDependencies" in record)
    reasons.push(
      'package.json: "devDependencies" is not accepted — the build toolchain is the platform recipe. Remove the field.'
    );
  for (const key of Object.keys(record)) {
    if (["name", "version", "private", "type", "dependencies", "scripts", "devDependencies"].includes(key)) continue;
    reasons.push(`package.json: "${key}" is not part of the supported source contract. Remove the field.`);
  }

  const dependencies = record.dependencies;
  if (dependencies !== undefined) {
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      reasons.push('package.json: "dependencies" must be an object of name to version. Fix it or remove the field.');
    } else {
      for (const name of Object.keys(dependencies as Record<string, unknown>)) {
        if (!ALLOWED_DEPENDENCIES.has(name))
          reasons.push(
            `package.json: dependency "${name}" is not available — the recipe provides ${[...ALLOWED_DEPENDENCIES].join(" and ")} only, and nothing is installed from a submission. Remove it.`
          );
      }
    }
  }

  const result = SourcePackageJson.safeParse(record);
  if (!result.success) {
    for (const issue of result.error.issues) {
      // Unknown keys are already named one by one above, with the reason they
      // are refused; the schema's single "unrecognized keys" issue would only
      // repeat them less usefully.
      if (issue.code === "unrecognized_keys") continue;
      const at = issue.path.length > 0 ? issue.path.join(".") : "the object";
      reasons.push(`package.json: ${at} — ${issue.message}`);
    }
  }
}

function checkManifest(raw: Buffer, reasons: string[]): SourceManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    reasons.push("zenith.app.json: the file is not valid JSON. Fix the syntax.");
    return undefined;
  }
  const result = SourceManifest.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const at = issue.path.length > 0 ? issue.path.join(".") : "the object";
      reasons.push(`zenith.app.json: ${at} — ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

/**
 * Accept a submission or refuse it with every reason at once.
 *
 * On success the result carries the parsed manifest, the files in byte-wise
 * path order, the pinned `digest` (see `sourceDigest`) and `totalBytes`.
 * On failure it throws one `HostedError("unsupported_source")` whose
 * `details.reasons` is the complete list.
 */
export function validateSource(input: SourceInput): ValidatedSource {
  const scan = input.kind === "tarball" ? scanTar(input.bytes) : scanDirectory(input.path);
  const reasons = [...scan.reasons];
  const files = [...scan.files].sort(byPath);
  const byName = new Map(files.map((f) => [f.path, f]));

  for (const entry of [...files.map((f) => f.path), ...scan.dirs]) {
    for (const pattern of REJECTED_PATTERNS) {
      if (pattern.test(entry)) {
        reasons.push(
          `${entry}: this path is never part of a supported submission (matched ${String(pattern)}). Remove it — the platform supplies the build configuration, the lockfile and the dependencies.`
        );
        break;
      }
    }
  }

  for (const entry of files) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) {
      if (!ALLOWED_ROOT_FILES.has(entry.path))
        reasons.push(
          `${entry.path}: only ${[...ALLOWED_ROOT_FILES].join(", ")} may sit at the source root. Move it under src/ or public/, or remove it.`
        );
      continue;
    }
    const top = entry.path.slice(0, slash);
    if (!ALLOWED_ROOT_DIRS.has(top)) {
      reasons.push(
        `${entry.path}: "${top}/" is not a supported root directory. Only ${[...ALLOWED_ROOT_DIRS].join("/ and ")}/ are read.`
      );
      continue;
    }
    const ext = extensionOf(entry.path);
    if (!ALLOWED_EXTENSIONS.has(ext))
      reasons.push(
        `${entry.path}: the "${ext || "(none)"}" extension is not supported under ${top}/. Supported: ${[...ALLOWED_EXTENSIONS].join(" ")}.`
      );
  }

  for (const dir of scan.dirs) {
    const top = dir.includes("/") ? dir.slice(0, dir.indexOf("/")) : dir;
    if (!ALLOWED_ROOT_DIRS.has(top))
      reasons.push(
        `${dir}: "${top}/" is not a supported root directory. Only ${[...ALLOWED_ROOT_DIRS].join("/ and ")}/ are read.`
      );
  }

  const indexHtml = byName.get("index.html");
  if (!indexHtml) reasons.push("index.html is missing from the source root. Add the entry document.");

  const manifestFile = byName.get("zenith.app.json");
  let manifest: SourceManifest | undefined;
  if (!manifestFile)
    reasons.push(
      'zenith.app.json is missing from the source root. Add it with {"contract":1,"schema":1,"name":"<app name>"}.'
    );
  else manifest = checkManifest(manifestFile.bytes, reasons);

  const packageFile = byName.get("package.json");
  if (packageFile) checkPackageJson(packageFile.bytes, reasons);

  if (reasons.length > 0 || !manifest)
    throw new HostedError("unsupported_source", "This source is not a supported v1 submission.", {
      fix: SOURCE_FIX,
      details: { reasons: dedupe(reasons) },
    });

  return {
    kind: input.kind,
    manifest,
    files,
    digest: sourceDigest(files),
    totalBytes: files.reduce((sum, f) => sum + f.bytes.length, 0),
  };
}

const dedupe = (reasons: string[]): string[] => [...new Set(reasons)];
