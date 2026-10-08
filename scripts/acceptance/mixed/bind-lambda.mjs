/** Bind actual local package digest and immutable upload metadata into the Lambda manifest template. No cloud I/O. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const [packageDir, bindingFile, output] = process.argv.slice(2);
if (!packageDir || !bindingFile || !output) throw new Error("Usage: bind-lambda.mjs PACKAGE_DIR BINDING_JSON OUTPUT_JSON");
const metadata = JSON.parse(readFileSync(`${packageDir}/artifact.json`, "utf8"));
if (createHash("sha256").update(readFileSync(`${packageDir}/enricher.zip`)).digest("hex") !== metadata.sha256) throw new Error("Package changed after source binding.");
// Re-derive source binding from the exact ZIP entries, not from caller-authored metadata.
const entries = execFileSync("unzip", ["-Z1", `${packageDir}/enricher.zip`], { encoding: "utf8" }).trim().split("\n").sort();
const files = ["enricher/handler.mjs", "spec.json"];
if (JSON.stringify(entries) !== JSON.stringify(files)) throw new Error("Package entries differ from the reviewed source set.");
const sourceHash = createHash("sha256");
for (const file of files) {
  const bytes = execFileSync("unzip", ["-p", `${packageDir}/enricher.zip`, file]);
  const reviewed = readFileSync(new URL(`../../../fixtures/mixed-app/${file}`, import.meta.url));
  if (!bytes.equals(reviewed)) throw new Error("Package differs from the checked-out source; repackage and review.");
  sourceHash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
}
if (sourceHash.digest("hex") !== metadata.sourceDigest) throw new Error("Source digest is not bound to the package entries.");
const binding = JSON.parse(readFileSync(bindingFile, "utf8"));
if (!binding.bucket || !binding.key || !binding.version || binding.version === "null" || !/^arn:aws[^:]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+:[1-9][0-9]*$/.test(binding.functionArn ?? "")) throw new Error("Bind an immutable S3 version and published function version ARN.");
const m = JSON.parse(readFileSync(new URL("../../../fixtures/mixed-app/zenith.app.json", import.meta.url), "utf8"));
if (binding.functionArn.split(":")[3] !== m.functions[0].region) throw new Error("Published function region differs from the manifest placement.");
if (binding.sha256 !== metadata.sha256 || binding.sourceDigest !== metadata.sourceDigest) throw new Error("Upload binding differs from the reviewed package/source digests.");
m.functions[0].source = { type: "s3", bucket: binding.bucket, key: binding.key, version: binding.version, sha256: metadata.sha256, sourceDigest: metadata.sourceDigest };
for (const env of m.services[0].env) {
  if (env.key === "ENRICHER_LAMBDA_SHA256") env.value = metadata.sha256;
  if (env.key === "ENRICHER_LAMBDA_ARN") env.value = binding.functionArn;
}
writeFileSync(output, JSON.stringify(m, null, 2) + "\n");
