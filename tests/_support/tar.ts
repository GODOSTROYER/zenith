/**
 * A tar writer for tests, so hostile archives are generated rather than
 * committed as opaque binaries.
 *
 * It writes real ustar headers with real checksums (the reader verifies them),
 * and it can deliberately produce the shapes a hostile submitter would: a
 * symlink entry, a hard link, a device node, a `..` path, an absolute path, a
 * truncated stream, a corrupt checksum, a pax record the platform does not
 * model, a GNU long name.
 *
 * Workstream W2 (hosted R3) — test support only; nothing here ships.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BLOCK = 512;
const NUL = String.fromCharCode(0);

/** Tar type flags this writer can emit, by the name a test wants to read. */
export const TYPE_FLAGS = {
  file: "0",
  dir: "5",
  hardlink: "1",
  symlink: "2",
  chardev: "3",
  blockdev: "4",
  fifo: "6",
  contiguous: "7",
  pax: "x",
  paxGlobal: "g",
  gnuLongName: "L",
  gnuLongLink: "K",
} as const;

export type TarEntryType = keyof typeof TYPE_FLAGS;

export interface TarEntry {
  path: string;
  /** file content; ignored for directories and links */
  bytes?: Buffer;
  type?: TarEntryType;
  linkname?: string;
  /** override the size header without changing the payload (truncation tests) */
  declaredSize?: number;
  /** corrupt the header checksum on purpose */
  corruptChecksum?: boolean;
  /** write the name into the ustar `prefix` field instead of `name` */
  prefix?: string;
}

const writeString = (block: Buffer, value: string, offset: number, length: number): void => {
  const buf = Buffer.from(value, "utf8");
  buf.copy(block, offset, 0, Math.min(buf.length, length - 1));
};

const writeOctal = (block: Buffer, value: number, offset: number, length: number): void => {
  const text = value.toString(8).padStart(length - 1, "0");
  block.write(text.slice(-(length - 1)), offset, "latin1");
  block.write(NUL, offset + length - 1, "latin1");
};

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  writeString(block, entry.path, 0, 100);
  writeOctal(block, 0o644, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, entry.declaredSize ?? size, 124, 12);
  writeOctal(block, 0, 136, 12);
  block.write("        ", 148, "latin1"); // checksum placeholder: eight spaces
  block.write(TYPE_FLAGS[entry.type ?? "file"], 156, "latin1");
  if (entry.linkname) writeString(block, entry.linkname, 157, 100);
  block.write("ustar", 257, "latin1");
  block.write(NUL, 262, "latin1");
  block.write("00", 263, "latin1");
  if (entry.prefix) writeString(block, entry.prefix, 345, 155);

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i] ?? 0;
  if (entry.corruptChecksum) sum += 1;
  block.write(sum.toString(8).padStart(6, "0"), 148, "latin1");
  block.write(NUL, 154, "latin1");
  block.write(" ", 155, "latin1");
  return block;
}

const pad = (bytes: Buffer): Buffer => {
  const remainder = bytes.length % BLOCK;
  return remainder === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(BLOCK - remainder, 0)]);
};

/**
 * Build a tar buffer. `terminate: false` omits the two trailing zero blocks so
 * a test can check what the reader does with an archive that just stops.
 */
export function writeTar(entries: TarEntry[], opts: { terminate?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const payload =
      entry.type === "dir" || entry.type === "symlink" || entry.type === "hardlink" ? Buffer.alloc(0) : entry.bytes ?? Buffer.alloc(0);
    parts.push(header(entry, payload.length));
    if (payload.length > 0) parts.push(pad(payload));
  }
  if (opts.terminate !== false) parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** One pax extended header record, `"<len> <key>=<value>\n"`, length included. */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  for (;;) {
    const candidate = `${length}${body}`;
    if (candidate.length === length) return Buffer.from(candidate, "utf8");
    length = candidate.length;
  }
}

export const gzip = (bytes: Buffer): Buffer => zlib.gzipSync(bytes);

/** Read a directory tree into tar entries, so the fixture becomes an archive. */
export function entriesFromDirectory(root: string, relative = ""): TarEntry[] {
  const out: TarEntry[] = [];
  for (const dirent of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      out.push({ path: `${child}/`, type: "dir" });
      out.push(...entriesFromDirectory(root, child));
    } else if (dirent.isFile()) {
      out.push({ path: child, bytes: fs.readFileSync(path.join(root, child.split("/").join(path.sep))) });
    }
  }
  return out;
}
