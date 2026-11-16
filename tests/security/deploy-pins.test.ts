/** Resolver contract tests use generated digest bytes, never registry calls or claimed image evidence. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_FILES, CILIUM_FILE, IMAGES_FILE, RELEASE_FILES, ciliumPin, dockerBases, inventory, isPinned, main, pendingPins, resolveImage, resolvePins } from "../../scripts/deploy/pin-digests.mjs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-deploy-pins-")); directories.push(root);
  for (const file of [...BASE_FILES, ...Object.values(RELEASE_FILES), IMAGES_FILE, CILIUM_FILE]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const base = file === "docker/runner.Dockerfile" ? "ARG GO_VERSION=1.27\nARG ALPINE_VERSION=3.22\nFROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build\nFROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS tofu\nFROM gcr.io/distroless/static-debian12:nonroot\n" : file === "docker/zenithd.Dockerfile" ? "ARG GO_VERSION=1.27\nFROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build\nFROM gcr.io/distroless/static-debian12:nonroot\n" : `FROM node:22@${hash("already pinned fixture")}\n`;
    const content = file === CILIUM_FILE ? "CILIUM_CHART_VERSION=\nCILIUM_CHART_SHA256=\nCILIUM_CHART_URL=\n" : file === IMAGES_FILE ? "ZENITH_PROMETHEUS_IMAGE=prom/prometheus:v3.2.1\nZENITH_GRAFANA_IMAGE=grafana/grafana:11.6.0\nZENITH_OTEL_IMAGE=otel/opentelemetry-collector-contrib:0.123.0\n" : Object.values(RELEASE_FILES).includes(file) ? `image: registry.invalid/test@sha256:${"0".repeat(64)}\n` : base;
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

describe("J11 deterministic pin resolver (offline contracts)", () => {
  it("expands global ARGs, preserves stage references and does not assume caller overrides are pinned", () => {
    expect(dockerBases('ARG BASE=node:22\nFROM --platform=$BUILDPLATFORM ${BASE} AS build\nFROM build AS test\nFROM scratch\n')).toEqual([{ token: "${BASE}", ref: "node:22" }]);
    expect(dockerBases("FROM ${MISSING}\n")[0].ref).toContain("missing ARG");
  });
  it.each(["alpine:3.22", `alpine@${hash("alpine")}`])("uses only the resolver's exact digest for %s", ref => {
    const calls: [string, string[]][] = [];
    const result = resolveImage(ref, "crane", (binary: string, args: string[]) => { calls.push([binary, args]); return hash("resolved index"); });
    expect(result).toBe(`${ref.split("@")[0]}@${hash("resolved index")}`);
    expect(calls).toEqual([["crane", ["digest", ref.split("@")[0]]]]);
  });
  it("reads the buildx manifest digest without parsing human diagnostics", () => {
    expect(resolveImage("alpine:3.22", "buildx", (_binary: string, args: string[]) => { expect(args).toEqual(["buildx", "imagetools", "inspect", "alpine:3.22", "--format", "{{json .Manifest}}"]); return JSON.stringify({ digest: hash("index") }); })).toBe(`alpine:3.22@${hash("index")}`);
  });
  it.each(["", "sha256:short", `sha256:${"0".repeat(64)}`, "diagnostic\nsha256:" + "a".repeat(64)])("rejects invalid/placeholder/multiline output %s", output => {
    expect(() => resolveImage("alpine:3.22", "crane", () => output)).toThrow(/invalid|placeholder/);
  });
  it("cannot resolve missing ARGs, placeholders or option-shaped image input", () => {
    for (const ref of ["<missing ARG>", "registry.invalid/zenith/api", "--help", "alpine:3.22;echo", "alpine\n:3.22"]) expect(() => resolveImage(ref, "crane", () => hash("fixture"))).toThrow();
  });
  it("does not rewrite any source when a later registry lookup fails", () => {
    const root = scratch(), before = new Map(BASE_FILES.map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]));
    let calls = 0;
    expect(() => resolvePins(root, { scope: "bases" }, () => { if (++calls === 2) throw new Error("unavailable registry"); return hash("fixture"); })).toThrow("unavailable");
    for (const [file, content] of before) expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(content);
  });
  it("pins every owned base including ARG defaults and keeps platform/stage text intact", () => {
    const root = scratch();
    resolvePins(root, { scope: "bases" }, (_binary: string, args: string[]) => hash(args.join(" ")));
    expect(inventory(root).filter(item => item.scope === "bases").every(item => isPinned(item.ref))).toBe(true);
    expect(fs.readFileSync(path.join(root, "docker/runner.Dockerfile"), "utf8")).toContain("FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:");
    expect(pendingPins(root).map(item => item.scope)).toEqual(["release", "release", "release", "cilium"]);
  });
  it("requires all release inputs before writing and pins each manifest to its own real source", () => {
    const root = scratch(), file = path.join(root, RELEASE_FILES.api), before = fs.readFileSync(file, "utf8");
    expect(() => resolvePins(root, { scope: "release", images: { api: "localhost:5007/zenith/api:j11" } }, () => hash("api"))).toThrow(/worker/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const images = Object.fromEntries(Object.keys(RELEASE_FILES).map(key => [key, `localhost:5007/zenith/${key}:j11`]));
    resolvePins(root, { scope: "release", images }, (_binary: string, args: string[]) => { expect(args).toContain("--insecure"); return hash(args.at(-1)!); });
    for (const item of inventory(root).filter(item => item.scope === "release")) expect(item.ref).toBe(`${images[item.key!]}@${hash(images[item.key!])}`);
  });
  it("hashes actual chart archive bytes, validates chart identity and removes owned download scratch", () => {
    const root = scratch(), bytes = Buffer.from("offline contract archive, not a Helm artifact");
    let archive = "";
    resolvePins(root, { scope: "cilium", ciliumVersion: "1.2.3" }, (binary: string, args: string[]) => {
      expect(binary).toBe("helm");
      if (args[0] === "pull") { archive = path.join(args.at(-1)!, "cilium-1.2.3.tgz"); fs.writeFileSync(archive, bytes); return ""; }
      return "name: cilium\nversion: 1.2.3\n";
    });
    expect(ciliumPin(root)).toMatchObject({ pinned: true, version: "1.2.3", sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(fs.existsSync(archive)).toBe(false);
  });
  it("refuses a wrong chart version without rewriting the empty pin", () => {
    const root = scratch(), before = fs.readFileSync(path.join(root, CILIUM_FILE), "utf8");
    expect(() => resolvePins(root, { scope: "cilium", ciliumVersion: "1.2.3" }, (_binary: string, args: string[]) => { if (args[0] === "pull") fs.writeFileSync(path.join(args.at(-1)!, "cilium-1.2.3.tgz"), "fixture"); return "name: cilium\nversion: 9.9.9\n"; })).toThrow("identity");
    expect(fs.readFileSync(path.join(root, CILIUM_FILE), "utf8")).toBe(before);
  });
  it("CLI refuses any network resolution without the verifier opt-in", () => {
    const prior = process.env.ZENITH_RESOLVE_DEPLOY_PINS; delete process.env.ZENITH_RESOLVE_DEPLOY_PINS;
    try { expect(main(["--resolve", "--scope", "bases"])).toBe(1); } finally { if (prior === undefined) delete process.env.ZENITH_RESOLVE_DEPLOY_PINS; else process.env.ZENITH_RESOLVE_DEPLOY_PINS = prior; }
  });
  it("reports the unresolved builder boundary and rejects zero-digest deployment pins", () => {
    const pending = pendingPins();
    // This is a TODO inventory, not an image-availability assertion. A real resolver run empties it.
    const allowedPendingFiles = new Set(["docker/runner.Dockerfile", "docker/zenithd.Dockerfile", ...Object.values(RELEASE_FILES), IMAGES_FILE, CILIUM_FILE]);
    expect(pending.every(item => allowedPendingFiles.has(item.file))).toBe(true);
    expect(isPinned(`registry.invalid/api@sha256:${"0".repeat(64)}`)).toBe(false);
  });
});
