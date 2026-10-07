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

  it("exposes the signing seed only to the steps that sign, and removes it afterwards", () => {
    const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes("ZENITH_RELEASE_SIGNING_SEED"));
    expect(holders.map((s) => s.name)).toEqual(["Is the release signing key available", "Sign the runner and zenithd update manifests", "Provenance, verification manifest and release signature"]);
    for (const s of holders.slice(1)) {
      expect(s.run).toContain("umask 077");
      expect(s.run).toContain('rm -f "$seed_file"');
      expect(s.run).not.toMatch(/echo[^\n]*\$SEED|set -x/);
    }
    expect(code.match(/secrets\./g)?.length).toBe(3);
    expect(code).not.toContain("secrets.GITHUB_TOKEN");
    // the update-manifest step is the MACH-04 signer and only runs when an update host is configured
    expect(steps[named("Sign the runner and zenithd update manifests")].run).toContain("cmd/zenith-release sign");
    expect(steps[named("Sign the runner and zenithd update manifests")].if).toContain("vars.ZENITH_UPDATE_BASE_URL != ''");
  });

  it("publishes a release only through the verified path and never pushes an image to a registry", () => {
    expect(steps[named("Publish the signed release")].run).toContain("gh release create");
    expect(code).not.toMatch(/docker push|docker login|--push|type=registry/);
    expect(code).toContain("type=oci,dest=");
  });
});
