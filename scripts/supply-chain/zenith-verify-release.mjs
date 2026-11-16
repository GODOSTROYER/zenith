#!/usr/bin/env node
/**
 * zenith-verify-release: verify a Zenith release bundle OFFLINE (PROD-OPS-09).
 *
 *   node scripts/supply-chain/zenith-verify-release.mjs BUNDLE_DIR --keys PINNED_KEYS.json
 *        [--lock package-lock.json] [--strict] [--now ISO]
 *
 * Checks, with no network and nothing but node: the manifest signature against the PINNED release public keys you
 * supply (never a key from the bundle), the sha256 and size of every listed artifact, that nothing unlisted ships, the
 * CycloneDX SBOM (structure, version, commit, image components, and with --lock exactly the lockfile's npm packages),
 * every OCI image archive (blob hashes recomputed; the image digest read from the archive must be the signed digest),
 * and the SLSA v1 provenance (subjects equal the signed artifact digests, same git commit and repository).
 *
 * PINNED_KEYS.json is the same shape the agents pin: one {"kid","publicKey"} entry or an array of them
 * (`zenith-release keygen` prints one). --strict turns warnings (tag-only base images, unlisted files) into failures.
 *
 * Exit status: 0 verified, 1 not verified, 2 usage error. A verified release is signed by the holder of the pinned key
 * and internally consistent. It is not a statement that the software is free of vulnerabilities (see the triage records)
 * and the provenance is workflow-asserted, not a hosted-builder attestation.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyRelease } from "./release.mjs";

export function main(argv, stdout = process.stdout, stderr = process.stderr) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--strict") flags.strict = true;
    else if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else flags._.push(argv[i]);
  }
  if (flags._.length !== 1 || !flags.keys) {
    stderr.write("usage: zenith-verify-release BUNDLE_DIR --keys PINNED_KEYS.json [--lock package-lock.json] [--strict] [--now ISO]\n");
    return 2;
  }
  let keys, lock;
  try {
    const raw = JSON.parse(fs.readFileSync(flags.keys, "utf8"));
    keys = Array.isArray(raw) ? raw : [raw];
    lock = flags.lock ? fs.readFileSync(flags.lock, "utf8") : undefined;
  } catch (e) {
    stderr.write(`zenith-verify-release: cannot read input: ${e instanceof Error ? e.message : "error"}\n`);
    return 2;
  }
  const now = flags.now ? new Date(flags.now) : new Date();
  if (Number.isNaN(now.getTime())) { stderr.write("--now must be an ISO timestamp\n"); return 2; }
  const result = verifyRelease({ dir: flags._[0], keys, now, strict: flags.strict === true, lock });
  stdout.write(`${JSON.stringify({ verified: result.ok, tag: result.manifest?.tag ?? null, version: result.manifest?.version ?? null, commit: result.manifest?.commit ?? null, artifacts: result.manifest?.artifacts?.length ?? null, errors: result.errors, warnings: result.warnings }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
