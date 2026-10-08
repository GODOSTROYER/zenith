#!/usr/bin/env node
/** Bind a real sanitized verifier result. Never manufactures counts, changes status, or edits the ledger. */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EVIDENCE_FORMAT, EvidenceSchema, readRepositoryFile, sha256, sourceOutcome } from "./status.mjs";

export function main(argv, root = process.cwd()) {
  const value = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  try {
    if (!value("--source") || !value("--out")) throw new Error("--source (repository-relative) and --out are required");
    const bytes = readRepositoryFile(root, value("--source"));
    const outcome = sourceOutcome(JSON.parse(bytes.toString("utf8")));
    if (value("--mode") !== outcome.mode) throw new Error("Requested mode differs from the original run mode");
    if (!outcome.requirements.includes(value("--requirement"))) throw new Error("Original run does not cover the requested requirement");
    const status = outcome.exitCode !== 0 || outcome.failed > 0 || outcome.status === "failed" ? "failed" : outcome.skipped > 0 ? "skipped" : outcome.passed === 0 ? "not_run" : outcome.status && outcome.status !== "passed" ? "not_run" : "passed";
    const receipt = EvidenceSchema.parse({ format: EVIDENCE_FORMAT, requirementId: value("--requirement"), level: value("--level"), mode: value("--mode"), commit: outcome.commit,
      environment: typeof outcome.environment === "string" ? outcome.environment : JSON.stringify(outcome.environment), command: typeof outcome.command === "string" ? outcome.command : JSON.stringify(outcome.command),
      status, passed: outcome.passed, failed: outcome.failed, skipped: outcome.skipped, exitCode: outcome.exitCode, sources: [{ path: value("--source"), sha256: sha256(bytes) }] });
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    writeFileSync(value("--out"), serialized, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status, sha256: sha256(serialized), commit: receipt.commit, level: receipt.level })}\n`);
    return 0;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Evidence refused"}\n`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
