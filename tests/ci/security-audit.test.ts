import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ARGS, assessAudit, runSecurityAudit } from "../../scripts/ci/security-audit.mjs";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnMock }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-security-audit-"));
fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/example": { version: "1.0.0" } } }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

function report(vulnerabilities: Record<string, unknown> = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(vulnerabilities).length };
  for (const finding of Object.values(vulnerabilities)) counts[(finding as { severity: "high" }).severity]++;
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts, dependencies: { total: 2 } } };
}
const direct = (severity = "high") => ({
  name: "example", severity, isDirect: false, nodes: ["node_modules/example"],
  via: [{ url: "https://github.com/advisories/GHSA-abcd-2345-ghjk" }],
});
function child(stdout: string, status: number | null = 0, extra = {}) {
  spawnMock.mockReturnValue({ stdout, stderr: "", status, signal: null, ...extra });
}

describe("mandatory dependency audit", () => {
  it("clears only a complete zero-finding report with a successful exit", () => {
    expect(assessAudit(report(), 0).ok).toBe(true);
    for (const status of [1, 2, null]) expect(assessAudit(report(), status).ok).toBe(false);
  });

  it.each(["info", "low", "moderate", "high", "critical"])("blocks %s findings even if npm's configured exit threshold reports success", (severity) => {
    const result = assessAudit(report({ example: direct(severity) }), 0);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([{ package: "example", advisoryIds: ["GHSA-abcd-2345-ghjk"] }]);
  });

  it("resolves and deduplicates advisory IDs through transitive meta-vulnerabilities", () => {
    const result = assessAudit(report({
      example: direct(), parent: { name: "parent", severity: "high", isDirect: true, nodes: ["node_modules/parent"], via: ["example", "example"] },
    }), 1);
    expect(result.ok).toBe(false);
    expect(result.findings[1]).toEqual({ package: "parent", advisoryIds: ["GHSA-abcd-2345-ghjk"] });
  });

  it.each([
    null, {}, { error: { summary: "private-registry-detail" } },
    { ...report(), auditReportVersion: 1 },
    { ...report(), metadata: { vulnerabilities: { total: 0 } } },
    { ...report(), metadata: { vulnerabilities: report().metadata.vulnerabilities, dependencies: { total: 0 } } },
    { ...report({ example: direct() }), metadata: report().metadata },
    report({ example: { ...direct(), via: ["missing"] } }),
    report({ example: { ...direct(), via: ["example"] } }),
    report({ example: { ...direct(), via: [{ url: "https://untrusted.test/GHSA-abcd-2345-ghjk" }] } }),
    report({ example: { ...direct(), nodes: [] } }),
    report({ example: { ...direct(), via: [] } }),
  ])("fails closed on an incomplete or malformed report (%#)", (input) => {
    const result = assessAudit(input, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("private-registry-detail");
  });

  it("runs a locked audit including production, dev, optional and peer packages without installing or fixing", () => {
    vi.stubEnv("npm_execpath", "/trusted/npm-cli.js");
    child(JSON.stringify(report()));
    expect(runSecurityAudit(root).ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, ["/trusted/npm-cli.js", ...AUDIT_ARGS], expect.objectContaining({ cwd: root, timeout: 90_000 }));
    expect(AUDIT_ARGS).toEqual(expect.arrayContaining(["--package-lock-only", "--include=dev", "--include=optional", "--include=peer", "--registry=https://registry.npmjs.org"]));
    expect(AUDIT_ARGS.join(" ")).not.toMatch(/fix|force|omit|only=prod/);
  });

  it.each([
    ["invalid-json-private-marker", 0, {}],
    [JSON.stringify(report()), null, { signal: "SIGTERM" }],
    [JSON.stringify(report()), 0, { error: new Error("private-error-marker") }],
    [JSON.stringify(report()), 2, {}],
  ])("blocks registry, spawn, timeout and parse failures (%#)", (stdout, status, extra) => {
    child(stdout as string, status as number | null, extra as object);
    const result = runSecurityAudit(root);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toMatch(/private-(marker|error-marker)/);
  });

  it("refuses an absent lock without contacting the registry", () => {
    expect(runSecurityAudit(path.join(root, "absent")).ok).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
