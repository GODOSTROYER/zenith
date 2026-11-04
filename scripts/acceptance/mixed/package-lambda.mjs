import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const fixture = fileURLToPath(new URL("../../../fixtures/mixed-app/", import.meta.url));
const out = path.resolve(process.argv[2] ?? ".data/mixed-lambda");
mkdirSync(out, { recursive: true });
const stage = mkdtempSync(path.join(tmpdir(), "zenith-lambda-"));
const files = ["enricher/handler.mjs", "spec.json"];
const hash = createHash("sha256");
try {
  for (const file of files) {
    const bytes = readFileSync(path.join(fixture, file));
    hash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
    mkdirSync(path.dirname(path.join(stage, file)), { recursive: true }); cpSync(path.join(fixture, file), path.join(stage, file));
  }
  const zip = path.join(out, "enricher.zip");
  // zip needs a fresh output: refuse an existing package to avoid stale extra entries.
  try { readFileSync(zip); throw new Error("Output package already exists; use a fresh output directory."); } catch (e) { if (e.code !== "ENOENT") throw e; }
  execFileSync("zip", ["-X", zip, ...files], { cwd: stage, stdio: "pipe" });
  const metadata = { sourceDigest: hash.digest("hex"), sha256: createHash("sha256").update(readFileSync(zip)).digest("hex") };
  writeFileSync(path.join(out, "artifact.json"), JSON.stringify(metadata, null, 2) + "\n");
  process.stdout.write(JSON.stringify(metadata) + "\n");
} finally { rmSync(stage, { recursive: true, force: true }); }
