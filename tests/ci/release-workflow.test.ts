/**
 * PROD-OPS-09: the release workflow is tag-only, signs only with a configured key, verifies before it publishes, and
 * keeps the same toolchain pins as every other workflow. Parses the YAML (no grepping comments), like release-gates.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface Step { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; "continue-on-error"?: boolean }
interface Job { "runs-on": string; "timeout-minutes": number; environment?: string; permissions?: Record<string, string>; steps: Step[] }
interface Workflow { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> }

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), ".github/workflows", file), "utf8");
const release = load(read("release.yml")) as Workflow;
const ci = load(read("ci.yml")) as Workflow;
const job = release.jobs.release;
const steps = job.steps;
const named = (fragment: string): number => steps.findIndex((s) => (s.name ?? "").includes(fragment));
const SECRET = "secrets.ZENITH_RELEASE_SIGNING_SEED";
// steps that receive the seed itself (the key probe only sees `SECRET != ''`, a boolean)
const seedSteps = steps.filter((s) => Object.values(s.env ?? {}).some((v) => v.includes(SECRET) && !/!=\s*''/.test(v)));
const code = read("release.yml").split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");

describe("release workflow trigger and permissions", () => {
  it("runs only for version tags: never a branch push, pull request, schedule or manual dispatch", () => {
    expect(Object.keys(release.on)).toEqual(["push"]);
    const push = release.on.push as Record<string, unknown>;
    expect(Object.keys(push)).toEqual(["tags"]);
    for (const pattern of push.tags as string[]) expect(pattern).toMatch(/^v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+(-\*)?$/);
    expect(code).not.toMatch(/pull_request|workflow_dispatch|schedule:|branches:/);
  });

  it("starts read-only; only the one release job may write contents, and it uses the protected environment", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(Object.keys(release.jobs)).toEqual(["release"]);
    expect(job.permissions).toEqual({ contents: "write" });
    expect(job.environment).toBe("release");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(45);
    expect(code).not.toMatch(/id-token|configure-aws-credentials|pull_request_target/);
  });
});

describe("toolchain pins match every other workflow", () => {
  const pinOf = (workflow: Workflow, action: string): Set<string> =>
    new Set(Object.values(workflow.jobs).flatMap((j) => j.steps).filter((s) => s.uses?.startsWith(`${action}@`)).map((s) => s.uses!));

  it("uses only actions CI already uses, at the same full commit, with a version comment", () => {
    for (const s of steps.filter((one) => one.uses)) {
      const action = s.uses!.split("@")[0];
      expect(pinOf(ci, action).has(s.uses!), `${s.uses} must be the pin ci.yml uses`).toBe(true);
    }
    for (const line of code.split(/\r?\n/).filter((l) => /^\s*(-\s+)?uses:/.test(l)))
      expect(line).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+){0,2}\s*$/);
  });

  it("checks out without keeping the token, pins Node exactly before running it, and never downloads or pipes code", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    const setupNode = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
    const firstNode = steps.findIndex((s) => /(^|[\s;&|(])(npm|npx|node|tsx)(\s|$)/.test(s.run ?? ""));
    expect(setupNode).toBeGreaterThanOrEqual(0);
    expect(setupNode).toBeLessThan(firstNode);
    expect(String(steps[setupNode].with?.["node-version"])).toBe("22.23.3");
    expect(steps.find((s) => s.uses?.startsWith("actions/setup-go@"))?.with?.["go-version"]).toBe("1.27.1");
    expect(code).not.toMatch(/\bcurl\b|\bwget\b|\|\s*(ba|z|da)?sh\b|npm ci|npm install/);
    expect(steps.some((s) => s["continue-on-error"])).toBe(false);
  });
});

describe("release steps and their order", () => {
  it("checks the tag, runs the dependency gates, builds, generates the SBOM and checks triage, in that order", () => {
    const order = ["Tag is a semantic version", "Lockfile pins only", "Known dependency findings", "Build Go binaries", "Build container images", "Generate the CycloneDX SBOM", "Vulnerability triage records"].map(named);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(steps[named("Lockfile pins only")].run).toBe("node scripts/ci/lockfile-integrity.mjs");
    expect(steps[named("Known dependency findings")].run).toBe("node scripts/ci/security-audit.mjs");
  });

  it("signs and writes provenance only when the key is present, then verifies offline before it publishes", () => {
    const key = named("Is the release signing key available");
    const sign = named("Provenance, verification manifest and release signature");
    const verify = named("Verify the release bundle offline");
    const publish = named("Publish the signed release");
    expect(key).toBeLessThan(sign);
    expect(sign).toBeLessThan(verify);
    expect(verify).toBeLessThan(publish);
    for (const i of [sign, verify, publish]) expect(steps[i].if).toBe("steps.key.outputs.present == 'true'");
    expect(steps[verify].run).toContain("zenith-verify-release.mjs release --keys");
    expect(steps[verify].run).toContain("--lock package-lock.json");
    expect(steps[sign].run).toContain("release.mjs provenance");
    expect(steps[sign].run).toContain("release.mjs sign");
    // the verifier is handed the PINNED public keys from a repository variable, never a key from the bundle
    expect(steps[verify].env?.PINNED).toBe("${{ vars.ZENITH_RELEASE_PUBLIC_KEYS }}");
    expect(named("Label an unsigned candidate")).toBeGreaterThan(0);
    expect(steps[named("Label an unsigned candidate")].if).toBe("steps.key.outputs.present != 'true'");
  });

  it("exposes the signing seed only to the two signing steps; the key probe sees a boolean, never the seed", () => {
    const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes(SECRET));
    expect(holders.map((s) => s.name)).toEqual(["Is the release signing key available", "Sign the runner and zenithd update manifests", "Provenance, verification manifest and release signature"]);
    expect(seedSteps.map((s) => s.name)).toEqual(["Sign the runner and zenithd update manifests", "Provenance, verification manifest and release signature"]);
    expect(steps[named("Is the release signing key available")].env?.SEED_PRESENT).toBe("${{ secrets.ZENITH_RELEASE_SIGNING_SEED != '' }}");
    expect(code.match(/secrets\./g)?.length).toBe(3);
    expect(code).not.toContain("secrets.GITHUB_TOKEN");
    // the secret is only ever an env value of a step, never inside a script body, `with:` input or condition
    for (const s of steps) {
      expect(s.run ?? "", `${s.name}: run`).not.toContain("secrets.");
      expect(JSON.stringify(s.with ?? {}), `${s.name}: with`).not.toContain("secrets.");
      expect(s.if ?? "", `${s.name}: if`).not.toContain("secrets.");
    }
  });

  it("writes the seed with umask 077 into a fresh mktemp file, installs the EXIT trap first, and never leaks it", () => {
    expect(seedSteps).toHaveLength(2);
    for (const s of seedSteps) {
      const run = s.run ?? "";
      const at = (needle: string): number => run.indexOf(needle);
      const umask = at("umask 077");
      const mk = at('seed_file="$(mktemp "$RUNNER_TEMP/release-seed.XXXXXXXX")"');
      const trap = at(`trap 'rm -f "$seed_file"' EXIT`);
      const write = at(`printf '%s\\n' "$SEED" > "$seed_file"`);
      expect(umask, `${s.name}: umask`).toBeGreaterThanOrEqual(0);
      expect(mk, `${s.name}: mktemp`).toBeGreaterThan(umask);
      expect(trap, `${s.name}: EXIT trap`).toBeGreaterThan(mk);
      expect(write, `${s.name}: the write comes after the trap`).toBeGreaterThan(trap);
      expect(run.match(/mktemp/g)).toHaveLength(1);
      expect(run).toContain("trap 'exit 1' HUP INT TERM");
      expect(run).toMatch(/^\s*set -euo pipefail/m);
      // $SEED appears exactly once, as the stdin of a redirect into the seed file: never an echo, a command argument or a log line
      expect(run.match(/\$\{?SEED\b/g)).toHaveLength(1);
      expect(run).not.toMatch(/set -x|xtrace|\becho\b[^\n]*SEED|::add-mask|GITHUB_ENV|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY/);
      // the seed path, never the seed, is what the signers receive
      expect(run).not.toMatch(/--(key|seed)[ =]"?\$SEED/);
      expect(run).toContain('--key "$seed_file"');
      // the old fixed path is gone: a failed step could otherwise leave it behind
      expect(run).not.toContain("$RUNNER_TEMP/release-seed\"");
    }
    // nothing else in the workflow can persist the secret for later steps
    for (const s of steps.filter((one) => !seedSteps.includes(one) && one.name !== "Is the release signing key available"))
      expect(s.run ?? "", `${s.name}`).not.toContain("SEED");
    expect(steps[named("Is the release signing key available")].run).not.toContain('"$SEED"');
  });

  it("removes any leftover seed in an always() step that runs after every signing and publishing step", () => {
    const cleanup = named("Remove any leftover signing seed");
    expect(cleanup).toBe(steps.length - 1);
    expect(steps[cleanup].if).toBe("always()");
    expect(steps[cleanup].env).toBeUndefined();
    expect(steps[cleanup].run).toContain("release-seed.*");
    expect(steps[cleanup].run).toContain('"$RUNNER_TEMP"');
    expect(steps[cleanup].run).toContain("rm -f");
    for (const s of seedSteps) expect(steps.indexOf(s)).toBeLessThan(cleanup);
    expect(named("Publish the signed release")).toBeLessThan(cleanup);
  });

  it("signs the updater manifests with the built tool under the one flat layout, before the release manifest binds them", () => {
    const upd = steps[named("Sign the runner and zenithd update manifests")];
    expect(upd.if).toBe("steps.key.outputs.present == 'true'");
    expect(named("Sign the runner and zenithd update manifests")).toBeLessThan(named("Provenance, verification manifest and release signature"));
    expect(upd.run).toContain("go/dist/tools/zenith-release sign");
    expect(upd.run).toContain('where=(--base-url "${BASE_URL%/}/${TAG}")');
    expect(upd.run).toContain('where=(--repository "$REPOSITORY" --tag "$TAG")');
    expect(upd.run).toContain("--stage-dir release-assets");
    expect(upd.run).toContain('--out "release/updater/${component}.json"');
    expect(upd.run).toContain('cp "release/updater/${component}.json" "release-assets/updater-${component}.json"');
    expect(upd.env?.BASE_URL).toBe("${{ vars.ZENITH_UPDATE_BASE_URL }}");
  });

  it("verifies the updater manifests against the pinned keys and the staged assets before anything is published", () => {
    const verify = steps[named("Verify the release bundle offline")];
    expect(verify.run).toContain("go/dist/tools/zenith-release verify");
    expect(verify.run).toContain('--keys "$RUNNER_TEMP/pinned-keys.json"');
    expect(verify.run).toContain("--assets release-assets");
    expect(verify.run).toContain('--component "$component" --channel "$channel"');
    expect(verify.run).toContain("for component in zenith-runner zenithd");
    expect(verify.run).toContain('cmp "release/updater/${component}.json" "release-assets/updater-${component}.json"');
    expect(verify.env?.PINNED).toBe("${{ vars.ZENITH_RELEASE_PUBLIC_KEYS }}");
  });

  it("publishes a release only through the verified path and never pushes an image to a registry", () => {
    const publish = steps[named("Publish the signed release")].run ?? "";
    expect(publish).toContain("gh release create");
    expect(code).not.toMatch(/docker push|docker login|--push|type=registry/);
    expect(code).toContain("type=oci,dest=");
    // draft first, upload, compare the asset list, and only then make it public
    const order = ["gh release create", "--draft", "gh release upload", "--clobber", "[ \"$actual\" = \"$expected\" ]", "gh release edit \"$TAG\" --draft=false"].map((n) => publish.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // --clobber is allowed only on the upload to the draft this very run created
    expect(code.match(/--clobber/g)).toHaveLength(1);
    expect(publish).toMatch(/gh release upload "\$TAG" "\$\{assets\[@\]\}" --clobber/);
  });
});

describe("one update layout, end to end", () => {
  const root = process.cwd();
  const text = (p: string): string => fs.readFileSync(path.join(root, p), "utf8");
  const components = ["zenith-runner", "zenithd"];
  const platforms = ["linux-amd64", "linux-arm64"];
  const flat = components.flatMap((c) => platforms.map((p) => `${c}-${p}`));

  it("builds exactly the components and platforms the workflow signs, with the flat names the Go tool signs into URLs", () => {
    const build = text("go/build.sh");
    expect(build).toContain('TARGETS="${TARGETS:-linux/amd64 linux/arm64}"');
    expect(build).toContain("for cmd in zenith-runner zenithd; do");
    const layout = text("go/internal/release/layout.go");
    expect(layout).toContain('return component + "-" + goos + "-" + goarch');
    expect(layout).toContain('return "updater-" + component + ".json"');
    expect(layout).toContain('"/releases/download/"');
    const main = text("go/cmd/zenith-release/main.go");
    expect(main).toContain("release.ArtifactURL(base, *component, goos, goarch)");
    // the workflow signs both components and stages flat assets in one place that is also what publishing uploads
    const upd = steps[named("Sign the runner and zenithd update manifests")].run ?? "";
    expect(upd).toContain("for component in zenith-runner zenithd; do");
    expect(steps[named("Publish the signed release")].run).toContain("for f in release-assets/*; do assets+=(\"$f\"); done");
    // sign --stage-dir writes `<component>-<os>-<arch>` and its .sha256, the names the manifest URLs end in
    expect(flat).toEqual(["zenith-runner-linux-amd64", "zenith-runner-linux-arm64", "zenithd-linux-amd64", "zenithd-linux-arm64"]);
  });

  it("documents the same layout everywhere and the old nested layout nowhere", () => {
    const files = ["docs/platform/RUNNER-UPDATES.md", "docs/platform/operations/SUPPLY-CHAIN.md", "deploy/zenithd/config.example.yaml", "go/build.sh", ".github/workflows/release.yml", "go/cmd/zenith-release/main.go"];
    for (const f of files) {
      const body = text(f);
      expect(body, f).not.toMatch(/<version>\/<os>-<arch>\/<component>|<component>\/<version>\//);
    }
    for (const f of ["docs/platform/RUNNER-UPDATES.md", "docs/platform/operations/SUPPLY-CHAIN.md"]) {
      expect(text(f), f).toContain("<component>-<os>-<arch>");
      expect(text(f), f).toContain("updater-<component>.json");
    }
    expect(text("deploy/zenithd/config.example.yaml")).toContain("releases/latest/download/updater-zenithd.json");
    expect(text("docs/platform/RUNNER-UPDATES.md")).toContain("releases/download/<tag>/");
  });
});
