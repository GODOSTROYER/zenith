/** Mandatory dependency gate. All unresolved findings block; no exceptions are granted. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AUDIT_ARGS = [
  "audit", "--json", "--package-lock-only", "--include=dev", "--include=optional", "--include=peer",
  "--ignore-scripts", "--audit-level=low", "--registry=https://registry.npmjs.org",
  "--fetch-retries=1", "--fetch-timeout=30000",
];
const severities = ["info", "low", "moderate", "high", "critical"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const advisoryUrl = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/;

/** Validate npm's complete report before interpreting zero findings as clearance. */
export function assessAudit(report, status) {
  try {
    if (!record(report) || report.error || report.auditReportVersion !== 2 || !record(report.vulnerabilities)) {
      throw new Error("Invalid npm audit report or registry failure.");
    }
    const entries = Object.entries(report.vulnerabilities);
    const counts = report.metadata?.vulnerabilities;
    if (!record(counts) || !severities.every((key) => count(counts[key])) ||
        !count(counts.total) || counts.total !== entries.length ||
        severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total ||
        !count(report.metadata?.dependencies?.total) || report.metadata.dependencies.total === 0) {
      throw new Error("Incomplete or inconsistent npm audit counts.");
    }
    const idsByPackage = new Map();
    for (const [name, finding] of entries) {
      if (!packageName.test(name) || !record(finding) || finding.name !== name ||
          !severities.includes(finding.severity) || typeof finding.isDirect !== "boolean" ||
          !Array.isArray(finding.nodes) || finding.nodes.length === 0 ||
          !finding.nodes.every((node) => typeof node === "string" && node.length > 0) ||
          !Array.isArray(finding.via) || finding.via.length === 0) {
        throw new Error("Malformed vulnerability entry.");
      }
      if (entries.filter(([, item]) => item.severity === finding.severity).length !== counts[finding.severity]) {
        throw new Error("Inconsistent npm audit severity counts.");
      }
    }
    const advisoryIds = (name, visiting = new Set()) => {
      if (idsByPackage.has(name)) return idsByPackage.get(name);
      if (visiting.has(name) || !Object.hasOwn(report.vulnerabilities, name)) {
        throw new Error("Unresolvable npm audit dependency advisory.");
      }
      visiting.add(name);
      const ids = new Set();
      for (const via of report.vulnerabilities[name].via) {
        if (typeof via === "string") {
          for (const id of advisoryIds(via, visiting)) ids.add(id);
        } else {
          const match = record(via) && typeof via.url === "string" && advisoryUrl.exec(via.url);
          if (!match) throw new Error("Missing canonical advisory identifier.");
          ids.add(match[1]);
        }
      }
      visiting.delete(name);
      idsByPackage.set(name, ids);
      return ids;
    };
    const findings = entries.map(([name]) => ({ package: name, advisoryIds: [...advisoryIds(name)].sort() }));
    if (status !== 0 && status !== 1) throw new Error("npm audit did not complete successfully.");
    if (status === 1 && findings.length === 0) throw new Error("npm audit exited with an error despite reporting no findings.");
    return {
      ok: findings.length === 0,
      reason: findings.length ? `${findings.length} unresolved dependency findings block release.` : "No known dependency findings in the complete locked audit.",
      findings,
    };
  } catch (error) {
    return { ok: false, reason: error.message, findings: [] };
  }
}

export function runSecurityAudit(root = process.cwd()) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    if (![2, 3].includes(lock.lockfileVersion) || !record(lock.packages) || !lock.packages[""] || Object.keys(lock.packages).length < 2) {
      throw new Error("invalid lock");
    }
  } catch {
    return { ok: false, reason: "A complete committed package-lock.json is required.", findings: [] };
  }
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...AUDIT_ARGS], { cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 16 * 1024 * 1024 })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", AUDIT_ARGS, {
        cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
        shell: process.platform === "win32",
      });
  if (result.error || result.signal || result.status === null) {
    return { ok: false, reason: "npm audit unavailable, timed out or was interrupted.", findings: [] };
  }
  try { return assessAudit(JSON.parse(result.stdout), result.status); }
  catch { return { ok: false, reason: "npm audit returned malformed JSON.", findings: [] }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = runSecurityAudit();
  // Never print the raw registry response: errors may contain private details.
  const emit = result.ok ? console.log : console.error;
  emit(result.reason);
  for (const finding of result.findings) emit(`${finding.package}: ${finding.advisoryIds.join(", ")}`);
  process.exitCode = result.ok ? 0 : 1;
}
