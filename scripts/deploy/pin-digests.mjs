#!/usr/bin/env node
/** J11: network resolution is explicit; offline inventory never fabricates a pin. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BASE_FILES = ["Dockerfile", "docker/worker.Dockerfile", "docker/runner.Dockerfile", "docker/zenithd.Dockerfile", "docker/recipe/Dockerfile", "deploy/self-hosted/migrations.Dockerfile", "fixtures/acceptance-app/Dockerfile"];
export const RELEASE_FILES = { api: "deploy/k8s/zenith-api.yaml", worker: "deploy/k8s/zenith-execution-worker.yaml", migrate: "deploy/k8s/platform-migrate-job.yaml" };
export const IMAGES_FILE = "deploy/observability/images.env";
export const CILIUM_FILE = "deploy/zenith-managed/cilium.env";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REF = /^[a-z0-9][a-z0-9./:_-]*(?:@sha256:[a-f0-9]{64})?$/;
export function validDigest(value) { return DIGEST.test(value) && value !== `sha256:${"0".repeat(64)}`; }
export function isPinned(value) { return REF.test(value) && !value.includes("registry.invalid") && validDigest(value.split("@")[1] ?? ""); }

/** Resolve global ARG defaults and external FROMs, preserving platform flags and stage names. */
export function dockerBases(source) {
  const defaults = new Map();
  const stages = new Set(["scratch"]);
  const refs = [];
  let beforeFirstFrom = true;
  for (const line of source.split(/\r?\n/)) {
    const arg = /^ARG\s+(\w+)=(\S+)/i.exec(line);
    if (beforeFirstFrom && arg) defaults.set(arg[1], arg[2]);
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!from) continue;
    beforeFirstFrom = false;
    const token = from[1];
    const ref = token.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced, plain) => defaults.get(braced ?? plain) ?? "<missing ARG>");
    if (!stages.has(ref.toLowerCase())) refs.push({ token, ref });
    if (from[2]) stages.add(from[2].toLowerCase());
  }
  return refs;
}

export function envValues(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
}

/** @param {string} root */
export function inventory(root = process.cwd()) {
  const refs = [];
  for (const file of BASE_FILES) for (const item of dockerBases(fs.readFileSync(path.join(root, file), "utf8"))) refs.push({ file, scope: "bases", ...item });
  for (const [key, file] of Object.entries(RELEASE_FILES)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const found = [...source.matchAll(/^\s*image:\s*(\S+)\s*$/gm)];
    if (found.length !== 1) throw new Error(`Expected one release image in ${file}`);
    refs.push({ file, scope: "release", key, token: found[0][1], ref: found[0][1] });
  }
  for (const [key, ref] of Object.entries(envValues(fs.readFileSync(path.join(root, IMAGES_FILE), "utf8")))) refs.push({ file: IMAGES_FILE, scope: "bases", key, token: ref, ref });
  return refs;
}

export function ciliumPin(root = process.cwd()) {
  const values = envValues(fs.readFileSync(path.join(root, CILIUM_FILE), "utf8"));
  const version = values.CILIUM_CHART_VERSION ?? "";
  const sha256 = values.CILIUM_CHART_SHA256 ?? "";
  const url = `https://helm.cilium.io/cilium-${version}.tgz`;
  return { version, sha256, url, pinned: /^\d+\.\d+\.\d+$/.test(version) && validDigest(`sha256:${sha256}`) && values.CILIUM_CHART_URL === url };
}

export function pendingPins(root = process.cwd()) {
  const pending = inventory(root).filter(item => !isPinned(item.ref));
  if (!ciliumPin(root).pinned) pending.push({ file: CILIUM_FILE, scope: "cilium", token: "", ref: "Cilium chart version and archive SHA-256 unresolved" });
  return pending;
}

function execute(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, shell: false });
  if (result.status !== 0 || result.error) throw new Error(`Pin resolution failed: ${binary}; no files rewritten`);
  return result.stdout.trim();
}

export function resolveImage(ref, resolver = "crane", run = execute) {
  if (!REF.test(ref) || ref.includes("registry.invalid") || ref.endsWith(`@sha256:${"0".repeat(64)}`)) throw new Error("A real source image reference is required");
  const source = ref.split("@")[0];
  let digest;
  if (resolver === "crane") digest = run("crane", ["digest", ...(/^(?:localhost|127\.0\.0\.1):\d+\//.test(source) ? ["--insecure"] : []), source]);
  else if (resolver === "buildx") digest = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", source, "--format", "{{json .Manifest}}"])).digest;
  else throw new Error("Resolver must be crane or buildx");
  if (typeof digest !== "string" || !validDigest(digest)) throw new Error("Resolver returned an invalid or placeholder digest; no files rewritten");
  return `${source}@${digest}`;
}

/**
 * All resolution finishes before any file changes. Rechecks source bytes before writing.
 * @param {string} root
 * @param {{ scope?: string, resolver?: string, images?: Record<string, string>, ciliumVersion?: string }} options
 */
export function resolvePins(root, { scope = "all", resolver = "crane", images = {}, ciliumVersion }, run = execute) {
  if (!["all", "bases", "release", "cilium"].includes(scope)) throw new Error("Unknown pin scope");
  const originals = new Map();
  const replacements = new Map();
  const resolved = new Map();
  for (const item of inventory(root).filter(item => scope === "all" || item.scope === scope)) {
    if (isPinned(item.ref) && !(item.scope === "release" && images[item.key])) continue;
    const source = item.scope === "release" ? images[item.key] : item.ref;
    if (!source) throw new Error(`Supply --image ${item.key}=<locally built registry reference>; no files rewritten`);
    if (!resolved.has(source)) resolved.set(source, resolveImage(source, resolver, run));
    if (!originals.has(item.file)) originals.set(item.file, fs.readFileSync(path.join(root, item.file), "utf8"));
    if (!originals.get(item.file).includes(item.token)) throw new Error("Pin source changed before resolution; no files rewritten");
    let content = replacements.get(item.file) ?? originals.get(item.file);
    // Replace only the FROM token, image field, or exact env assignment, never comments.
    content = content.split(/(?<=\n)/).map(line => {
      if (item.file === IMAGES_FILE && line.startsWith(`${item.key}=`)) return line.replace(item.token, resolved.get(source));
      if (item.scope === "release" && /^\s*image:/.test(line)) return line.replace(item.token, resolved.get(source));
      if (/^FROM\s/i.test(line) && dockerBases(`ARG UNUSED=x\n${line}`).some(base => base.token === item.token)) return line.replace(item.token, resolved.get(source));
      return line;
    }).join("");
    replacements.set(item.file, content);
  }
  if ((scope === "all" || scope === "cilium") && !ciliumPin(root).pinned) {
    if (!/^\d+\.\d+\.\d+$/.test(ciliumVersion ?? "")) throw new Error("Supply an exact --cilium-version; no files rewritten");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-cilium-pin-"));
    try {
      run("helm", ["pull", "cilium", "--repo", "https://helm.cilium.io", "--version", ciliumVersion, "--destination", scratch]);
      const archive = path.join(scratch, `cilium-${ciliumVersion}.tgz`);
      const chart = run("helm", ["show", "chart", archive]);
      if (!new RegExp(`^version: ["']?${ciliumVersion.replaceAll(".", "\\.")}["']?\\s*$`, "m").test(chart) || !/^name: cilium\s*$/m.test(chart)) throw new Error("Downloaded Cilium chart identity differs; no files rewritten");
      const hash = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
      originals.set(CILIUM_FILE, fs.readFileSync(path.join(root, CILIUM_FILE), "utf8"));
      replacements.set(CILIUM_FILE, `# Resolved from the exact Helm archive; review and commit this pin.\nCILIUM_CHART_VERSION=${ciliumVersion}\nCILIUM_CHART_SHA256=${hash}\nCILIUM_CHART_URL=https://helm.cilium.io/cilium-${ciliumVersion}.tgz\n`);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  for (const [file, before] of originals) if (fs.readFileSync(path.join(root, file), "utf8") !== before) throw new Error("Pin source changed during resolution; no files rewritten");
  for (const [file, content] of replacements) fs.writeFileSync(path.join(root, file), content);
  return [...replacements.keys()];
}

export function main(args) {
  try {
    const [mode, ...rest] = args;
    const options = { images: {} };
    while (rest.length) {
      const flag = rest.shift(), value = rest.shift();
      if (!value) throw new Error("Missing option value");
      if (flag === "--scope") options.scope = value;
      else if (flag === "--resolver") options.resolver = value;
      else if (flag === "--cilium-version") options.ciliumVersion = value;
      else if (flag === "--image") { const [key, ...ref] = value.split("="); if (!Object.hasOwn(RELEASE_FILES, key) || options.images[key] || !ref.length) throw new Error("Invalid release image option"); options.images[key] = ref.join("="); }
      else throw new Error("Unknown option");
    }
    if (mode === "--resolve") {
      if (process.env.ZENITH_RESOLVE_DEPLOY_PINS !== "1") throw new Error("Network resolution requires ZENITH_RESOLVE_DEPLOY_PINS=1 on the verifier");
      console.log(JSON.stringify({ rewritten: resolvePins(process.cwd(), options) }));
      return 0;
    }
    if (rest.length || args.length !== 1 || !["--check", "--todo"].includes(mode)) throw new Error("Use --todo, --check, or --resolve [--scope bases|release|cilium|all] [--resolver crane|buildx] [--image api|worker|migrate=REF] [--cilium-version X.Y.Z]");
    const pending = pendingPins();
    if (mode === "--todo") {
      for (const item of pending) {
        console.log(`${item.file}: ${item.ref}`);
        if (item.scope === "bases") console.log(`  crane digest ${item.ref}\n  docker buildx imagetools inspect ${item.ref} --format '{{json .Manifest}}'`);
      }
      console.log("Cilium: helm pull cilium --repo https://helm.cilium.io --version \"$CILIUM_VERSION\" --destination \"$PIN_DIR\"; shasum -a 256 \"$PIN_DIR/cilium-$CILIUM_VERSION.tgz\"");
      return 0;
    }
    console.log(JSON.stringify({ pending }));
    return pending.length === 0 ? 0 : 1;
  } catch (error) { console.error(error.message); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
