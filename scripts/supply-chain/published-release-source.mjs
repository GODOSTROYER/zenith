#!/usr/bin/env node
/**
 * PROD-OPS-09 live: the release evidence source for one PUBLISHED, signed tag release, verified offline.
 *
 *   gh release download TAG -R OWNER/REPO -p 'zenith-*-bundle.tar' -D DIR && tar -xf DIR/zenith-TAG-bundle.tar -C DIR/bundle
 *   node scripts/supply-chain/published-release-source.mjs --bundle DIR/bundle --tag TAG --repository OWNER/REPO \
 *        --run-url URL --keys PINNED_KEYS.json --lock package-lock.json --out release-source-PROD-OPS-09.json
 *
 * The bundle must verify with --strict against the pinned public keys (never a key from the bundle) and the lockfile, and
 * name the same tag and repository. Only then is a source written (mode live) for scripts/release/evidence-cli.mjs
 * --level live_sandbox --mode live. Exit 0 written, 1 not verified, 2 usage error. No network.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ENVELOPE_FILE, verifyRelease } from "./release.mjs";

export function publishedReleaseSource({ bundle, tag, repository, runUrl, keys, lock, now = new Date() }) {
  const result = verifyRelease({ dir: bundle, keys, lock, strict: true, now });
  const manifest = result.manifest ?? {};
  const errors = [...result.errors];
  if (manifest.tag !== tag) errors.push("the signed manifest names a different tag");
  if (manifest.repository !== repository) errors.push("the signed manifest names a different repository");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl ?? "")) errors.push("--run-url must be the release workflow run URL");
  if (errors.length || !result.ok) return { errors: errors.length ? errors : ["not verified"] };
  const envelope = fs.readFileSync(path.join(bundle, ENVELOPE_FILE));
  const kid = JSON.parse(envelope.toString("utf8")).signatures.map((s) => s.kid).find((k) => keys.some((p) => p.kid === k));
  const artifacts = manifest.artifacts.length;
  return { errors: [], source: {
    schema: "zenith.published-release-source.v1", commit: manifest.commit, mode: "live", requirements: ["PROD-OPS-09"],
    counts: { passed: 1, failed: 0, skipped: 0 }, exitCode: 0, verdict: "passed",
    command: `gh release download ${tag} -R ${repository}; node scripts/supply-chain/published-release-source.mjs (offline, --strict)`,
    environment: `GitHub Actions release.yml run ${runUrl} in the protected release environment; published release ${tag} of ${repository}; signed with pinned key ${kid}`,
    evidence: { manifestSha256: createHash("sha256").update(envelope).digest("hex"), artifacts },
    result: `Published release ${tag} verified offline with --strict: signature by pinned key ${kid}, ${artifacts} artifacts at their signed sha256 and size, nothing unlisted, CycloneDX SBOM exactly the lockfile's npm packages, OCI image digests and SLSA provenance subjects bound by the signed manifest, commit ${String(manifest.commit).slice(0, 8)}.`,
  } };
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) { process.stderr.write("usage: see the file header\n"); return 2; }
    a[argv[i].slice(2)] = argv[i + 1];
  }
  for (const flag of ["bundle", "tag", "repository", "run-url", "keys", "lock", "out"]) if (!a[flag]) { process.stderr.write(`--${flag} is required\n`); return 2; }
  const raw = JSON.parse(fs.readFileSync(a.keys, "utf8"));
  const { errors, source } = publishedReleaseSource({ bundle: a.bundle, tag: a.tag, repository: a.repository, runUrl: a["run-url"], keys: Array.isArray(raw) ? raw : [raw], lock: fs.readFileSync(a.lock, "utf8") });
  if (errors.length) { process.stderr.write(`published release NOT verified:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`); return 1; }
  fs.writeFileSync(a.out, `${JSON.stringify(source, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  process.stdout.write(`published release ${a.tag} verified; source written to ${a.out}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
