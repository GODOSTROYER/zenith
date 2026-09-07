/**
 * Just enough tar writer to build the archives these tests submit — a real
 * one from the fixture directory, and a hostile one with a traversal entry.
 *
 * Copied down from `tests/hosted/source/tar-writer.ts` (W2) rather than
 * imported, so a change to that suite's helper cannot quietly change what this
 * one submits. Real ustar headers with real checksums: the reader verifies
 * them, so a fake would be rejected for the wrong reason.
 *
 * Not a test file — vitest only collects `*.test.ts`.
 *
 * Workstream W7 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BLOCK = 512;
const NUL = String.fromCharCode(0);

export interface TarEntry {
  path: string;
  bytes?: Buffer;
  type?: "file" | "dir";
}

const writeString = (block: Buffer, value: string, offset: number, length: number): void => {
  Buffer.from(value, "utf8").copy(block, offset, 0, Math.min(Buffer.byteLength(value), length - 1));
};

const writeOctal = (block: Buffer, value: number, offset: number, length: number): void => {
  block.write(value.toString(8).padStart(length - 1, "0").slice(-(length - 1)), offset, "latin1");
  block.write(NUL, offset + length - 1, "latin1");
};

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  writeString(block, entry.path, 0, 100);
  writeOctal(block, 0o644, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, size, 124, 12);
  writeOctal(block, 0, 136, 12);
  block.write("        ", 148, "latin1");
  block.write(entry.type === "dir" ? "5" : "0", 156, "latin1");
  block.write("ustar", 257, "latin1");
  block.write(NUL, 262, "latin1");
  block.write("00", 263, "latin1");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i] ?? 0;
  block.write(sum.toString(8).padStart(6, "0"), 148, "latin1");
  block.write(NUL, 154, "latin1");
  block.write(" ", 155, "latin1");
  return block;
}

const pad = (bytes: Buffer): Buffer => {
  const remainder = bytes.length % BLOCK;
  return remainder === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(BLOCK - remainder, 0)]);
};

/** Build a tar buffer with the two trailing zero blocks a reader expects. */
export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const payload = entry.type === "dir" ? Buffer.alloc(0) : (entry.bytes ?? Buffer.alloc(0));
    parts.push(header(entry, payload.length));
    if (payload.length > 0) parts.push(pad(payload));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

export const gzip = (bytes: Buffer): Buffer => zlib.gzipSync(bytes);

/** Read a directory tree into tar entries, so a fixture becomes an archive. */
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
