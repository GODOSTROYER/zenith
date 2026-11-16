/**
 * PROD-REL-02: the requirement-to-evidence dossier. Contract level over synthetic ledgers, plus one pass over the real ledger
 * that checks the invariants that must hold for any ledger: nothing is `verified` without every required level recorded,
 * unperformed levels are visible, and the dossier never edits the release status.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDossier, idsCoveredBy, loadDossierInputs, renderMarkdown, runDossierCli, testsNamedIn, type EvidenceFile, type Ledger, type VerifyDoc } from "../../scripts/release/dossier";
import type { AcceptanceReport } from "../../scripts/release/acceptance-orchestrator";

const req = (over: Partial<Ledger["requirements"][number]> & { id: string }): Ledger["requirements"][number] => ({
  title: `${over.id} title`, acceptance: ["It works."], state: "in_progress", dependencies: [], implementationStatus: "in_progress", evidence: [], requiredEvidence: ["contract", "local_engine"], owner: null, testPaths: [], ...over,
});

const ledger: Ledger = {
  releaseStatus: { implementationComplete: false, sandboxVerified: false, pilotReady: false, productionApproved: false },
  baseline: { commit: "37be7340536ccb68ae4bb49294e8ab3799d1f01b" },
  requirements: [
    req({ id: "PROD-TST-01", state: "verified", implementationStatus: "verified_abc", evidence: [{ level: "contract", commit: "a".repeat(40), result: "10 passed", environment: "Node 22 on CI" }, { level: "local_engine", commit: "b".repeat(40), result: "5 passed, 1 skipped", environment: "PostgreSQL 16" }] }),
    req({ id: "PROD-TST-02", state: "in_progress", requiredEvidence: ["contract", "live_sandbox"], evidence: [{ level: "contract", commit: "c".repeat(40), result: "ok" }] }),
    req({ id: "PROD-TST-03", state: "planned", implementationStatus: "not_assessed", requiredEvidence: ["contract", "local_engine", "live_sandbox", "operational_rehearsal"] }),
    req({ id: "PROD-TST-04", state: "in_progress", implementationStatus: "implementation_complete_verification_pending", testPaths: ["tests/release/dossier.test.ts", "tests/gone.test.ts"], evidence: [{ level: "contract", commit: "d".repeat(40), result: "all green, 3 skipped" }] }),
    req({ id: "PROD-TST-05", state: "verified", implementationStatus: "verified_x", requiredEvidence: ["contract", "live_sandbox"], evidence: [{ level: "contract", commit: "e".repeat(40), result: "ok" }] }),
  ],
};

const docs: VerifyDoc[] = [
  { file: "docs/build/production/verify/PROD-TST-01-02.md", text: "# PROD-TST-01 and PROD-TST-02\nRun: `npx vitest run tests/release/scope.test.ts tests/missing/never.test.ts`\n" },
  { file: "docs/build/production/verify/MIXED-NAME.md", text: "# PROD-TST-04, PROD-TST-03: notes\nSee tests/release/checkpoint.test.ts.\n" },
];

const files: EvidenceFile[] = [
  { requirement: "PROD-TST-01", file: "docs/build/production/evidence/PROD-TST-01/run.json", json: { status: "executed", passed: 10, failed: 0, skipped: 0 } },
  { requirement: "PROD-TST-04", file: "docs/build/production/evidence/PROD-TST-04/run.json", json: { status: "executed", passed: 3, failed: 2, skipped: 1 } },
  { requirement: "PROD-TST-04", file: "docs/build/production/evidence/PROD-TST-04/bad.json" },
];

const exists = (rel: string): boolean => existsSync(path.resolve(rel));
const build = () => buildDossier({ ledger, verifyDocs: docs, evidenceFiles: files, exists, now: () => new Date("2026-10-08T00:00:00Z") });
const row = (id: string) => build().rows.find((r) => r.id === id)!;

describe("verify document coverage", () => {
  it("reads covered ids from the file name range and the title block", () => {
    expect(idsCoveredBy(docs[0]!).sort()).toEqual(["PROD-TST-01", "PROD-TST-02"]);
    expect(idsCoveredBy(docs[1]!).sort()).toEqual(["PROD-TST-03", "PROD-TST-04"]);
    expect(idsCoveredBy({ file: "x/PROD-MIX-05.md", text: "# t" })).toEqual(["PROD-MIX-05"]);
    expect(idsCoveredBy({ file: "x/WAVE3-GAPS.md", text: "# gaps\n" })).toEqual([]);
  });
  it("finds test files named in the text", () => {
    expect(testsNamedIn("a tests/a/b.test.ts and tests/c.test.tsx and not tests/readme.md")).toEqual(["tests/a/b.test.ts", "tests/c.test.tsx"]);
  });
});

describe("the dossier rows", () => {
  it("does not verify ledger claims without actual passing evidence files at a coherent commit", () => {
    // These historical fixture entries have no file/hash bindings, and the local entry also includes a skip.
    expect(row("PROD-TST-01").status).not.toBe("verified");
    // The ledger says verified but a required live level has no entry: never verified.
    expect(row("PROD-TST-05").status).not.toBe("verified");
    expect(row("PROD-TST-05").levels).toEqual({ contract: "pending", live_sandbox: "unperformed" });
  });

  it("shows deferred and never-run evidence as unperformed and the rest as pending", () => {
    expect(row("PROD-TST-02").levels).toEqual({ contract: "pending", live_sandbox: "unperformed" });
    expect(row("PROD-TST-03").levels).toEqual({ contract: "pending", local_engine: "pending", live_sandbox: "unperformed", operational_rehearsal: "unperformed" });
    expect(row("PROD-TST-03").status).toBe("not_assessed");
    expect(row("PROD-TST-04").status).toBe("implementation_complete_unverified");
  });

  it("maps requirement to implementation, tests, environment and commit", () => {
    const r = row("PROD-TST-01");
    expect(r.implementation.verifyDocs).toEqual(["docs/build/production/verify/PROD-TST-01-02.md"]);
    expect(r.tests.namedInVerifyDocs).toEqual(["tests/missing/never.test.ts", "tests/release/scope.test.ts"]);
    expect(r.tests.missingOnDisk).toEqual(["tests/missing/never.test.ts"]);
    expect(r.environments).toEqual(["Node 22 on CI", "PostgreSQL 16"]);
    expect(r.commits).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(r.evidenceFiles).toEqual([{ file: "docs/build/production/evidence/PROD-TST-01/run.json", status: "executed: 10 passed, 0 failed, 0 skipped" }]);
  });

  it("flags skips, failures, unreadable evidence, missing tests and missing documents", () => {
    expect(row("PROD-TST-01").flags.join("|")).toContain("evidence mentions skipped tests");
    const r4 = row("PROD-TST-04").flags.join("|");
    expect(r4).toContain("evidence mentions skipped tests");
    expect(r4).toContain("an evidence file reports failures or is unreadable");
    expect(r4).toContain("do not exist on disk");
    expect(row("PROD-TST-05").flags).toContain("no verification document names this requirement");
    expect(row("PROD-TST-02").flags).toContain("live_sandbox evidence unperformed");
  });

  it("counts everything and copies the release status verbatim", () => {
    const d = build();
    expect(d.summary.total).toBe(5);
    expect(d.summary.byStatus.verified).toBe(0);
    expect(d.summary.unperformedLevels).toBe(4);
    expect(d.summary.pendingLevels).toBe(8);
    expect(d.releaseStatus).toEqual(ledger.releaseStatus);
    expect(d.statement).toContain("does not approve a release");
  });

  it("attaches acceptance scenario results as they are", () => {
    const acceptance = { schema: 1, runId: "r1", generatedAt: "2026-10-08T00:00:00Z", sourceCommit: null, statement: "", summary: { total: 1, failed: 0, not_run: 0, incomplete: 0, local_passed: 0, local_passed_live_pending: 1, verified_live: 0 },
      scenarios: [{ id: "s1", title: "S1", requirements: ["PROD-TST-02"], status: "local_passed_live_pending", lanes: [], limits: "" }] } as AcceptanceReport;
    const d = buildDossier({ ledger, verifyDocs: docs, evidenceFiles: files, acceptance, exists });
    expect(d.rows.find((r) => r.id === "PROD-TST-02")!.scenarios).toEqual([{ id: "s1", status: "local_passed_live_pending" }]);
    expect(renderMarkdown(d)).toContain("local_passed_live_pending");
  });
});

describe("markdown", () => {
  it("shows unperformed items as such and never as passed", () => {
    const md = renderMarkdown(build());
    expect(md).toContain("live_sandbox: UNPERFORMED");
    expect(md).toContain("contract: PENDING");
    const table = md.split("\n").filter((l) => l.startsWith("| PROD-TST-"));
    expect(table).toHaveLength(5);
    for (const line of table) expect(line.toLowerCase()).not.toMatch(/\|\s*passed\s*\|/);
    expect(table.find((l) => l.startsWith("| PROD-TST-05"))).not.toContain("| verified |");
    expect(md).toContain("Deployment, upgrade and recovery instructions");
  });
});

describe("the real ledger", () => {
  const inputs = loadDossierInputs(process.cwd());
  const dossier = buildDossier({ ...inputs, exists });

  it("has one row per requirement and never invents a verified row", () => {
    expect(dossier.rows).toHaveLength(inputs.ledger.requirements.length);
    for (const r of dossier.rows) {
      if (r.status === "verified") expect(Object.values(r.levels).every((s) => s === "performed"), r.id).toBe(true);
      for (const [level, state] of Object.entries(r.levels)) if (state === "unperformed") expect(r.status, `${r.id} ${level}`).not.toBe("verified");
    }
  });

  it("documents the requirements this work owns", () => {
    for (const id of ["PROD-MIX-05", "PROD-MIX-06", "PROD-MIX-07", "PROD-REL-01", "PROD-REL-02", "PROD-REL-04"]) {
      const r = dossier.rows.find((x) => x.id === id)!;
      expect(r.implementation.verifyDocs, id).toContain("docs/build/production/verify/MIX-05-07-REL.md");
      expect(r.status, id).not.toBe("verified");
      expect(r.tests.missingOnDisk, id).toEqual([]);
    }
  });

  it("keeps the ledger's release status as it is and lists the operating documents", () => {
    expect(dossier.releaseStatus).toEqual(inputs.ledger.releaseStatus ?? {});
    expect(dossier.instructions.find((i) => i.file === "docs/platform/operations/MIXED-RECOVERY.md")?.present).toBe(true);
    expect(dossier.instructions.find((i) => i.file === "docs/platform/operations/ROLLING-UPGRADES.md")?.present).toBe(true);
  });

  it("the CLI writes markdown and json without touching the ledger", () => {
    const out: string[] = []; const err: string[] = [];
    expect(runDossierCli([], { out: (s) => { out.push(s); }, err: (s) => { err.push(s); } })).toBe(0);
    expect(out.join("")).toContain("# Release evidence dossier");
    expect(err.join("")).toContain("requirements;");
  });
});
