/** Offline operator review: hashes the exact node runtime files, then validates the tenant profile. No credentials are read. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readBuildProfiles, buildProfileDigest, buildTenantKey } from "../../../src/lib/providers/kubernetes/build";
const [profileFile, seccompFile, appArmorFile, runtimeFile, outputFile] = process.argv.slice(2);
if (!profileFile || !seccompFile || !appArmorFile || !runtimeFile || !outputFile) throw new Error("Usage: review-profile.ts profile.json seccomp.json apparmor runtimeclass.json output.json");
const raw = JSON.parse(readFileSync(profileFile, "utf8"));
const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
JSON.parse(readFileSync(seccompFile, "utf8"));
if (runtime.kind !== "RuntimeClass" || runtime.metadata?.name !== raw.config.runtimeClass || !runtime.handler) throw new Error("RuntimeClass must match the tenant build profile.");
raw.config.nodeIsolation.profileDigest = createHash("sha256").update(JSON.stringify([seccompFile, appArmorFile, runtimeFile].map((file, i) => [i, createHash("sha256").update(readFileSync(file)).digest("hex")]))).digest("hex");
const profile = readBuildProfiles({ ZENITH_ISOLATED_BUILD_PROFILES: JSON.stringify([raw]) })[0];
writeFileSync(outputFile, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(JSON.stringify({ tenant: buildTenantKey(profile), runtimeProfileDigest: profile.config.nodeIsolation.profileDigest, reviewedBuildProfileDigest: buildProfileDigest(profile) }) + "\n");
