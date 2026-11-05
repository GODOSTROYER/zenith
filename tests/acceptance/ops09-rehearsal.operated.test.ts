/**
 * PROD-OPS-09 operational rehearsal (local): the release runbook with a local ephemeral signing key.
 *
 * Runbook: docs/platform/operations/SUPPLY-CHAIN.md ("Releasing", "Verifying a release (offline)") and the OPS-09 row of
 * docs/build/production/LIVE-ACCEPTANCE.md ("Local ephemeral signing key is rehearsal only").
 *   1. The operator generates a release key with `zenith-release keygen` (a throwaway key in a private temp directory).
 *   2. The build, SBOM, triage, signing and self-verify steps of .github/workflows/release.yml run verbatim, read from the
 *      workflow file, with the workflow's expressions filled in for a local prerelease tag. Nothing is uploaded or published.
 *   3. The operator verifies the bundle offline against the pinned public key, and each updater manifest with the Go verifier.
 *   4. Refusals: a key that is not pinned and a changed binary byte are not verified. `--strict` (no tag-only base image) verifies.
 * Not covered: the tamper-evident audit export (needs an operated stack and a browser session), registry pushes (none ship),
 * and the real signing key (live level, owner decision).
 *
 * Gated: ZENITH_LOCAL_OPS09_REHEARSAL=1. Needs Go (the workflow's go1.27.1 is fetched with GOTOOLCHAIN), Docker with buildx,
 * and network for the dependency audit. Writes release/ and go/dist in the checkout and removes them at the end.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const gated = process.env.ZENITH_LOCAL_OPS09_REHEARSAL === "1";
const root = process.cwd();
const TAG = "v0.0.0-rehearsal.1";
const REPOSITORY = "saivedant169/zenith";
const KID = "rehearsal-ephemeral";

interface Step { name?: string; run?: string; env?: Record<string, string>; if?: string }
const steps = (): Step[] => (yaml.load(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")) as { jobs: Record<string, { steps: Step[] }> }).jobs.release!.steps;

describe.skipIf(!gated)("PROD-OPS-09 operated rehearsal: release runbook with an ephemeral key", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "zenith-ops09-reh-"));
  const created = ["release", "go/dist"].filter((p) => !existsSync(path.join(root, p)));
  afterAll(() => {
    for (const p of created) rmSync(path.join(root, p), { recursive: true, force: true });
    spawnSync("docker", ["buildx", "rm", "zenith-release"], { stdio: "ignore" });
    rmSync(temp, { recursive: true, force: true });
  });

  it("builds, signs and self-verifies the release from the workflow's own steps, then refuses tampering", () => {
    expect(created, "release/ and go/dist must not exist before the rehearsal").toEqual(["release", "go/dist"]);
    const goEnv = { ...process.env, GOTOOLCHAIN: process.env.ZENITH_REHEARSAL_GOTOOLCHAIN ?? "go1.27.1" };

    // 1. Ephemeral key: the seed file stays in the private temp directory; only the public entry is read.
    const seedFile = path.join(temp, "seed.txt");
    const keygen = (kid: string, out: string) => JSON.parse(execFileSync("go", ["run", "./cmd/zenith-release", "keygen", "--kid", kid, "--private-out", out], { cwd: path.join(root, "go"), env: goEnv, encoding: "utf8" })) as { kid: string; publicKey: string };
    const pinned = keygen(KID, seedFile);
    expect(statSync(seedFile).mode & 0o077).toBe(0);
    const seed = readFileSync(seedFile, "utf8").trim();

    // 2. The workflow's steps, verbatim, with its expressions filled in.
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const output = path.join(temp, "github-output");
    writeFileSync(output, "");
    const expressions: Record<string, string> = {
      "github.ref_name": TAG, "github.ref": `refs/tags/${TAG}`, "github.repository": REPOSITORY, "github.server_url": "https://github.com",
      "github.run_id": "local-rehearsal", "github.run_number": "1", "github.token": "",
      "secrets.ZENITH_RELEASE_SIGNING_SEED": seed, "vars.ZENITH_RELEASE_KEY_ID": KID, "vars.ZENITH_RELEASE_PUBLIC_KEYS": JSON.stringify([pinned]),
      "vars.ZENITH_UPDATE_BASE_URL": "https://updates.rehearsal.invalid/zenith",
    };
    const fill = (value: string) => value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
      if (!(expr in expressions)) throw new Error(`unfilled workflow expression: ${expr}`);
      return expressions[expr]!;
    });
    const run = (name: string) => {
      const step = steps().find((s) => s.name === name);
      expect(step?.run, name).toBeTruthy();
      const env = { ...goEnv, ...Object.fromEntries(Object.entries(step!.env ?? {}).map(([k, v]) => [k, fill(String(v))])), GOTOOLCHAIN: goEnv.GOTOOLCHAIN,
        GITHUB_SHA: commit, RUNNER_TEMP: temp, GITHUB_OUTPUT: output };
      const result = spawnSync("bash", ["-c", step!.run!], { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      expect(result.status, `${name}\n${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.replaceAll(seed, "[seed]").slice(-3000)}`).toBe(0);
      return result.stdout;
    };
    for (const name of [
      "Lockfile pins only registry tarballs with integrity hashes",
      "Known dependency findings block release",
      "Build Go binaries",
      "Build container images as OCI archives",
      "Generate the CycloneDX SBOM",
      "Vulnerability triage records match the SBOM and none has expired",
      "Is the release signing key available",
    ]) run(name);
    expect(readFileSync(output, "utf8")).toContain("present=true");
    run("Sign the runner and zenithd update manifests");
    run("Provenance, verification manifest and release signature");
    run("Verify the release bundle offline against the pinned public keys");
    const release = path.join(root, "release");
    for (const file of ["release-manifest.json", "sbom.cdx.json", "provenance.intoto.json", "updater/zenithd.json", "updater/zenith-runner.json", "images/zenith.oci.tar"]) expect(existsSync(path.join(release, file)), file).toBe(true);
    expect(JSON.stringify(readFileSync(path.join(release, "release-manifest.json"), "utf8"))).not.toContain(seed);

    // 3. The operator's own offline checks, from the runbook.
    const keys = path.join(temp, "pinned-keys.json");
    writeFileSync(keys, JSON.stringify([pinned]));
    const verify = (dir: string, keyFile: string, ...extra: string[]) => spawnSync("node", ["scripts/supply-chain/zenith-verify-release.mjs", dir, "--keys", keyFile, "--lock", "package-lock.json", ...extra], { cwd: root, encoding: "utf8" });
    expect(verify(release, keys).status).toBe(0);
    const goVerify = (component: string, publicKey: string) => spawnSync("go", ["run", "./cmd/zenith-release", "verify", "--manifest", path.join(release, "updater", `${component}.json`), "--kid", KID, "--public-key", publicKey], { cwd: path.join(root, "go"), env: goEnv, encoding: "utf8" });
    for (const component of ["zenithd", "zenith-runner"]) expect(goVerify(component, pinned.publicKey).status, component).toBe(0);

    // 4. Refusals.
    const other = keygen("rehearsal-not-pinned", path.join(temp, "other-seed.txt"));
    const otherKeys = path.join(temp, "other-keys.json");
    writeFileSync(otherKeys, JSON.stringify([{ ...other, kid: KID }]));
    expect(verify(release, otherKeys).status).toBe(1);
    expect(goVerify("zenithd", other.publicKey).status).not.toBe(0);
    const tampered = path.join(temp, "tampered");
    cpSync(release, tampered, { recursive: true });
    const binary = path.join(tampered, "go/linux-amd64/zenithd");
    const bytes = readFileSync(binary);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(binary, bytes);
    const changed = verify(tampered, keys);
    expect(changed.status).toBe(1);
    expect(changed.stdout + changed.stderr).toContain("zenithd");
    // Every release base image is digest-pinned in source, so the strict check (which fails on a tag-only base) passes.
    expect(verify(release, keys, "--strict").status).toBe(0);
  }, 150 * 60_000);
});
