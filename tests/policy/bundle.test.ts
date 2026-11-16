/**
 * The committed bundle matches its sources and manifest, without needing `opa`.
 * (`node policy/build.mjs --check` is the stronger check — it rebuilds — and
 * runs where opa is installed; this catches a hand-edited rule or wasm.)
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPA_VERSION, ENTRYPOINT, MANIFEST_SCHEMA, readSources, readTarEntry, sha256, sourceDigest } from "../../policy/build.mjs";

const root = process.cwd();
const dist = path.join(root, "policy", "dist");
const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8")) as {
  schema: number;
  opaVersion: string;
  entrypoint: string;
  wasmSha256: string;
  wasmBytes: number;
  regoSha256: string;
  sources: { name: string; sha256: string }[];
};

describe("committed policy bundle", () => {
  it("has a manifest describing exactly the committed wasm", () => {
    const wasm = readFileSync(path.join(dist, "policy.wasm"));
    expect(manifest.schema).toBe(MANIFEST_SCHEMA);
    expect(manifest.wasmSha256).toBe(sha256(wasm));
    expect(manifest.wasmBytes).toBe(wasm.length);
    expect(manifest.opaVersion).toBe(OPA_VERSION);
    expect(manifest.entrypoint).toBe(ENTRYPOINT);
  });

  it("was built from the Rego sources currently in the tree", () => {
    const sources = readSources();
    expect(manifest.sources).toEqual(sources.map(({ name, sha256: digest }) => ({ name, sha256: digest })));
    expect(manifest.regoSha256).toBe(sourceDigest(sources));
  });

  it("keeps the rego directory flat and separates tests from rules", () => {
    const files = readdirSync(path.join(root, "policy", "rego"), { withFileTypes: true });
    expect(files.every((f) => f.isFile())).toBe(true);
    const sources = readSources().map((s) => s.name);
    expect(sources.some((n) => n.endsWith("_test.rego"))).toBe(false);
    expect(files.filter((f) => f.name.endsWith("_test.rego")).length).toBeGreaterThan(0);
  });

  it("does not embed host paths or test code in the wasm", () => {
    const text = readFileSync(path.join(dist, "policy.wasm")).toString("latin1");
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|policy[\\/]rego/);
    expect(text).not.toContain("fixtures_test");
    expect(text).not.toContain("test_");
  });

  it("hashes sources with LF endings, so a CRLF checkout digests identically", () => {
    const sources = readSources();
    const first = sources[0];
    expect(first.text).not.toContain("\r");
    const crlf = readFileSync(path.join(root, "policy", "rego", first.name), "utf8").replace(/\r?\n/g, "\r\n");
    expect(sha256(crlf.replace(/\r\n/g, "\n"))).toBe(first.sha256);
  });
});

describe("tar reader used by the build", () => {
  function tarEntry(name: string, content: Buffer): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000600\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
    return Buffer.concat([header, content, padding]);
  }

  const archive = (...entries: [string, Buffer][]) => Buffer.concat([...entries.map(([n, c]) => tarEntry(n, c)), Buffer.alloc(1024)]);

  it("extracts a named entry, with or without a leading slash", () => {
    const tar = archive(["/data.json", Buffer.from("{}")], ["/policy.wasm", Buffer.from([0, 97, 115, 109])], ["/.manifest", Buffer.from("x")]);
    expect([...readTarEntry(tar, "/policy.wasm")]).toEqual([0, 97, 115, 109]);
    expect([...readTarEntry(tar, "policy.wasm")]).toEqual([0, 97, 115, 109]);
  });

  it("extracts entries larger than one block", () => {
    const big = Buffer.alloc(1300, 7);
    expect(readTarEntry(archive(["/a", Buffer.from("x")], ["/policy.wasm", big]), "/policy.wasm").equals(big)).toBe(true);
  });

  it("fails clearly when the entry is missing or the archive is truncated", () => {
    expect(() => readTarEntry(archive(["/data.json", Buffer.from("{}")]), "/policy.wasm")).toThrow(/no entry/);
    const truncated = archive(["/policy.wasm", Buffer.alloc(2000, 1)]).subarray(0, 700);
    expect(() => readTarEntry(truncated, "/policy.wasm")).toThrow(/Truncated/);
  });
});
