/**
 * Non-root build context for ACR Tasks (PROD-LIFE-04).
 *
 * ACR Tasks builds an uploaded archive whose ROOT is the context, so a subdirectory build uploads an archive built
 * ONLY from the validated `contextDir`. The input is the canonical repository archive C3 produced and whose bytes the
 * build port already verified against the recorded digest; LIFE-08's `contextDigest` (repository, approved commit,
 * directory tree, Dockerfile blob) was admitted upstream by `admitBuildContext` for the same commit, so this
 * derivation only narrows bytes that digest already covers. Nothing outside `contextDir` is uploaded except, when the
 * Dockerfile lives outside it (a repository-root Dockerfile with a subdirectory context, as on AWS and GCP), that one
 * file, placed at `.zenith/Dockerfile`.
 *
 * Only the canonical format (regular files and directories, ustar with optional PAX `path`) is accepted; links,
 * devices, traversal and duplicates fail closed. Output is deterministic (sorted paths, fixed gzip header).
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { StepFailedError } from "@/lib/execution/errors";

const BLOCK = 512;
const MAX_UNPACKED = 512 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
export const OUTSIDE_DOCKERFILE = ".zenith/Dockerfile";

interface Entry { path: string; directory: boolean; mode: number; data: Buffer }

const refuse = (message: string): never => { throw new StepFailedError(message); };
const text = (b: Buffer, o: number, l: number): string => { const s = b.subarray(o, o + l); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString("utf8"); };
function octal(b: Buffer, o: number, l: number): number {
  const v = b.subarray(o, o + l).toString("latin1").replace(/\0/g, " ").trim();
  if (!/^[0-7]+$/.test(v)) return refuse("Source archive has an invalid numeric header.");
  return Number.parseInt(v, 8);
}
function cleanPath(raw: string): string {
  if (!raw || raw.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(raw)) return refuse("Source archive has an unsafe path.");
  const parts = raw.split("/");
  if (parts.includes("..")) return refuse("Source archive has a traversal path.");
  return parts.filter((p) => p && p !== ".").join("/") || refuse("Source archive has an empty path.");
}

function parse(archive: Uint8Array): Map<string, Entry> {
  let tar: Buffer;
  try { tar = gunzipSync(Buffer.from(archive), { maxOutputLength: MAX_UNPACKED }); } catch { return refuse("Source archive is unreadable or too large to derive a build context."); }
  const entries = new Map<string, Entry>();
  let offset = 0, pendingPath: string | undefined, terminated = false;
  while (offset + BLOCK <= tar.length) {
    const head = tar.subarray(offset, offset + BLOCK);
    if (head.every((x) => x === 0)) { terminated = !pendingPath; break; }
    if (entries.size > MAX_ENTRIES) refuse("Source archive exceeds its entry bound.");
    const sum = head.reduce((s, x, i) => s + (i >= 148 && i < 156 ? 32 : x), 0);
    if (sum !== octal(head, 148, 8)) refuse("Source archive header checksum is invalid.");
    const type = String.fromCharCode(head[156]);
    const size = octal(head, 124, 12);
    const end = offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (end > tar.length) refuse("Source archive is truncated.");
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset = end;
    if (type === "x") {
      const m = /^\d+ path=(.*)\n$/s.exec(data.toString("utf8"));
      if (!m || pendingPath !== undefined) return refuse("Source archive has unsupported extended headers.");
      pendingPath = m[1];
      continue;
    }
    if (!["0", "\0", "5"].includes(type)) return refuse("Source archives cannot contain links, devices or special entries.");
    const prefix = text(head, 345, 155);
    const path = cleanPath(pendingPath ?? [prefix, text(head, 0, 100)].filter(Boolean).join("/"));
    pendingPath = undefined;
    if (entries.has(path)) refuse("Source archive has duplicate paths.");
    entries.set(path, { path, directory: type === "5", mode: type === "5" || (octal(head, 100, 8) & 0o111) ? 0o755 : 0o644, data });
  }
  if (!terminated) refuse("Source archive has an invalid end marker.");
  return entries;
}

function header(path: string, mode: number, size: number, type: string): Buffer {
  const out = Buffer.alloc(BLOCK);
  out.write(path, 0, 100, "utf8"); // callers pass names that fit; long names use the PAX path
  for (const [at, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, 0]]) out.write(value.toString(8).padStart(width - 1, "0") + "\0", at, width, "ascii");
  out.fill(32, 148, 156); out.write(type, 156, 1, "ascii"); out.write("ustar\0", 257, "ascii"); out.write("00", 263, "ascii");
  out.write(out.reduce((s, x) => s + x, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return out;
}

function pack(entries: Entry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const add = (head: Buffer, data: Buffer) => chunks.push(head, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  entries.forEach((e, i) => {
    const type = e.directory ? "5" : "0";
    if (Buffer.byteLength(e.path) > 100) {
      const record = ` path=${e.path}\n`;
      let length = Buffer.byteLength(record) + 1;
      while (String(length).length + Buffer.byteLength(record) !== length) length = String(length).length + Buffer.byteLength(record);
      const extended = Buffer.from(`${length}${record}`);
      add(header(`PaxHeaders/${i}`, 0o644, extended.length, "x"), extended);
      add(header(`entry/${i}`, e.mode, e.data.length, type), e.data);
    } else add(header(e.path, e.mode, e.data.length, type), e.data);
  });
  chunks.push(Buffer.alloc(2 * BLOCK));
  const out = gzipSync(Buffer.concat(chunks), { level: 9 });
  out.fill(0, 4, 8); out[9] = 255; // fixed mtime and OS byte: same inputs, same bytes
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Archive whose root is `contextDir` of `archive`, plus the Dockerfile path inside it. `contextDir` must already be
 * normalized by `contextDirOf`; "." returns the input unchanged. The Dockerfile path is repository-root relative.
 */
export function contextArchive(archive: Uint8Array, contextDir: string, dockerfile = "Dockerfile"): { archive: Uint8Array; dockerfilePath: string } {
  if (contextDir === ".") return { archive, dockerfilePath: dockerfile };
  if (!/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,200}$/.test(contextDir) || contextDir.endsWith("/") || contextDir.includes("//")) refuse("Azure build context directory is not a normalized relative path.");
  const all = parse(archive);
  const root = all.get(contextDir);
  if (root && !root.directory) refuse("The build context is not a directory of the source archive.");
  const prefix = `${contextDir}/`;
  const picked: Entry[] = [];
  for (const e of all.values()) if (e.path.startsWith(prefix)) picked.push({ ...e, path: e.path.slice(prefix.length) });
  if (!picked.some((e) => !e.directory)) refuse("The build context directory has no files in the approved source archive.");
  let dockerfilePath: string;
  if (dockerfile.startsWith(prefix)) dockerfilePath = dockerfile.slice(prefix.length);
  else {
    const outside = all.get(cleanPath(dockerfile));
    if (!outside || outside.directory) return refuse("The Dockerfile of a subdirectory build was not found in the approved source archive.");
    if (picked.some((e) => e.path === ".zenith" || e.path.startsWith(".zenith/"))) refuse("The build context already uses the reserved .zenith directory.");
    picked.push({ path: ".zenith", directory: true, mode: 0o755, data: Buffer.alloc(0) }, { ...outside, path: OUTSIDE_DOCKERFILE });
    dockerfilePath = OUTSIDE_DOCKERFILE;
  }
  const file = picked.find((e) => e.path === dockerfilePath);
  if (!file || file.directory) refuse("The Dockerfile is not a file of the build context.");
  picked.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { archive: pack(picked), dockerfilePath };
}
