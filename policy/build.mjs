#!/usr/bin/env node
/**
 * Build (or verify) the compiled policy bundle — ADR-0008.
 *
 *   node policy/build.mjs            test, compile, write policy/dist/{policy.wasm,manifest.json}
 *   node policy/build.mjs --check    rebuild into a temp dir and fail if the committed
 *                                    dist files differ (the CI gate)
 *
 * Steps, in order, each of which must succeed:
 *   1. `opa version` must report exactly OPA_VERSION. The compiled wasm embeds the
 *      OPA runtime, so a different OPA is a different artifact.
 *   2. `opa check --strict policy/rego` (lint) and `opa test policy/rego`.
 *   3. `opa build -t wasm -e zenith/decision/result` over the non-test sources.
 *   4. `/policy.wasm` is extracted from the bundle (node:zlib + a minimal tar reader;
 *      no dependencies) and written with a manifest.
 *
 * Reproducibility. The wasm embeds the file names OPA was given, so the build
 * runs in a fresh temp directory containing LF-normalised copies of the sources
 * under bare file names (`lib.rego`, ...). That removes the two things that made
 * the bytes host-dependent: path separators (`policy\rego\x.rego` vs
 * `policy/rego/x.rego`) and CRLF checkouts. Two consequences:
 *   - `policy/rego` must stay flat (no sub-directories); the build enforces it.
 *   - The manifest carries no timestamp.
 * Verified: repeated builds on the machine that produced the committed files are
 * byte-identical, including from different working directories. NOT verified: a
 * build on another OS/architecture. If `--check` ever fails in CI while the
 * source digest is unchanged, compare `opaVersion` and `regoSha256` first — that
 * would mean OPA's wasm output is not host-independent and the gate needs the
 * committed bundle to be produced in CI's environment.
 *
 * Manifest (`policy/dist/manifest.json`):
 *   opaVersion   the pinned OPA that compiled it
 *   entrypoint   the single wasm entrypoint
 *   wasmSha256   sha256 of policy.wasm — the `policyVersion` on every decision
 *   regoSha256   sha256 over the sorted `<name> <sha256(LF-normalised source)>`
 *                lines of the non-test sources; changes iff a rule changes
 *   sources      the per-file digests behind regoSha256
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const OPA_VERSION = "1.19.1";
export const ENTRYPOINT = "zenith/decision/result";
export const MANIFEST_SCHEMA = 1;

const here = dirname(fileURLToPath(import.meta.url));
export const REGO_DIR = join(here, "rego");
export const DIST_DIR = join(here, "dist");

/** @param {string | Uint8Array} bytes */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** CRLF -> LF so a Windows checkout with autocrlf hashes and compiles like Linux. */
function normalizeSource(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The non-test Rego sources, sorted by name, LF-normalised.
 * @param {string} [dir]
 * @returns {{ name: string, text: string, sha256: string }[]}
 */
export function readSources(dir = REGO_DIR) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const sub = entries.find((e) => e.isDirectory());
  if (sub) throw new Error(`policy/rego must be flat; found directory "${sub.name}" (file names are embedded in the wasm).`);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".rego") && !e.name.endsWith("_test.rego"))
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const text = normalizeSource(readFileSync(join(dir, name), "utf8"));
      return { name, text, sha256: sha256(text) };
    });
}

/** sha256 over the sorted `<name> <sha256>` lines. */
export function sourceDigest(sources) {
  return sha256(sources.map((s) => `${s.name} ${s.sha256}\n`).join(""));
}

/** Environment handed to opa: an allowlist, never process.env wholesale. */
function opaEnv() {
  const allow = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG"];
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = /** @type {string} */ (process.env[key]);
  return env;
}

/**
 * Run the pinned opa binary.
 * @param {string[]} args
 * @param {string} [cwd]
 */
function opa(args, cwd) {
  const bin = process.env.ZENITH_OPA_BIN || "opa";
  try {
    return execFileSync(bin, args, { cwd, env: opaEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (error) {
    const e = /** @type {{ stdout?: string, stderr?: string, message?: string }} */ (error);
    throw new Error(`opa ${args.join(" ")} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}${e.stdout || e.stderr ? "" : (e.message ?? "")}`);
  }
}

export function assertOpaVersion() {
  const out = opa(["version"]);
  const match = /^Version:\s*(\S+)/m.exec(out);
  const found = match ? match[1] : "unknown";
  if (found !== OPA_VERSION) {
    throw new Error(`OPA ${OPA_VERSION} is required to build the policy bundle; found ${found}. Install the pinned version (ZENITH_OPA_BIN overrides the binary).`);
  }
}

/**
 * Minimal ustar reader: the entry `name` (with or without a leading slash).
 * @param {Uint8Array} tar
 * @param {string} name
 * @returns {Buffer}
 */
export function readTarEntry(tar, name) {
  const buf = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  const want = name.replace(/^\/+/, "");
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const path = [field(345, 155), field(0, 100)].filter(Boolean).join("/").replace(/^\/+/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isFinite(size)) throw new Error("Malformed tar header.");
    const type = field(156, 1);
    const start = offset + 512;
    if (path === want && (type === "0" || type === "")) {
      if (start + size > buf.length) throw new Error("Truncated tar entry.");
      return Buffer.from(buf.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Bundle has no entry "${name}".`);
}

/**
 * Compile the sources in a scratch directory and return the wasm plus manifest.
 * @param {ReturnType<typeof readSources>} sources
 */
export function compile(sources) {
  const scratch = mkdtempSync(join(tmpdir(), "zenith-policy-"));
  try {
    for (const s of sources) writeFileSync(join(scratch, s.name), s.text);
    const bundle = join(scratch, "bundle.tar.gz");
    opa(["build", "-t", "wasm", "-e", ENTRYPOINT, ...sources.map((s) => s.name), "-o", "bundle.tar.gz"], scratch);
    const wasm = readTarEntry(gunzipSync(readFileSync(bundle)), "/policy.wasm");
    const manifest = {
      schema: MANIFEST_SCHEMA,
      opaVersion: OPA_VERSION,
      entrypoint: ENTRYPOINT,
      wasmSha256: sha256(wasm),
      wasmBytes: wasm.length,
      regoSha256: sourceDigest(sources),
      sources: sources.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    };
    return { wasm, manifestText: `${JSON.stringify(manifest, null, 2)}\n`, manifest };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Lint and unit-test the Rego; throws on the first failure. */
export function verifyRego() {
  assertOpaVersion();
  opa(["check", "--strict", REGO_DIR]);
  const out = opa(["test", REGO_DIR]);
  return out.trim().split(/\r?\n/).slice(-2).join(" ");
}

/** Build; returns what was produced without touching disk. */
export function build() {
  const summary = verifyRego();
  return { summary, ...compile(readSources()) };
}

function readCommitted() {
  const wasmPath = join(DIST_DIR, "policy.wasm");
  const manifestPath = join(DIST_DIR, "manifest.json");
  return {
    wasm: existsSync(wasmPath) ? readFileSync(wasmPath) : null,
    manifestText: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
  };
}

/** @param {string[]} argv */
export function main(argv) {
  const check = argv.includes("--check");
  const unknown = argv.filter((a) => a !== "--check");
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: node policy/build.mjs [--check]`);
    return 2;
  }

  const { summary, wasm, manifestText, manifest } = build();
  console.log(`opa ${OPA_VERSION}: ${summary}`);

  if (!check) {
    mkdirSync(DIST_DIR, { recursive: true });
    writeFileSync(join(DIST_DIR, "policy.wasm"), wasm);
    writeFileSync(join(DIST_DIR, "manifest.json"), manifestText);
    console.log(`wrote policy/dist/policy.wasm (${wasm.length} bytes, sha256 ${manifest.wasmSha256})`);
    return 0;
  }

  const committed = readCommitted();
  const problems = [];
  if (!committed.wasm) problems.push("policy/dist/policy.wasm is missing");
  else if (!committed.wasm.equals(wasm)) problems.push(`policy/dist/policy.wasm differs from a fresh build (committed ${sha256(committed.wasm)}, rebuilt ${manifest.wasmSha256})`);
  if (committed.manifestText === null) problems.push("policy/dist/manifest.json is missing");
  else if (committed.manifestText !== manifestText) problems.push("policy/dist/manifest.json differs from a fresh build");
  if (problems.length) {
    console.error(`Policy bundle is stale:\n  - ${problems.join("\n  - ")}\nRun \`node policy/build.mjs\` and commit policy/dist.`);
    return 1;
  }
  console.log(`policy/dist matches a fresh build (sha256 ${manifest.wasmSha256})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
