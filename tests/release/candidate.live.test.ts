/** File-only acceptance of REAL RC evidence. Does not run clouds or manufacture sign-off. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectReleaseEvidence, validateReleaseStatus, type SignoffKey } from "../../scripts/release/status.mjs";
import { buildDossier, loadDossierInputs, renderMarkdown } from "../../scripts/release/dossier";

const candidateEnabled = process.env.ZENITH_VERIFY_RELEASE_CANDIDATE === "1";
const signoffEnabled = process.env.ZENITH_VERIFY_PRODUCTION_SIGNOFF === "1";
if (!candidateEnabled) console.info("RC evidence acceptance not run: needs ZENITH_VERIFY_RELEASE_CANDIDATE=1 and coherent real recorded candidate evidence.");
if (!signoffEnabled) console.info("Production sign-off acceptance not run: needs ZENITH_VERIFY_PRODUCTION_SIGNOFF=1, an accountable real sign-off and ZENITH_RELEASE_SIGNOFF_KEYS_FILE.");

describe.skipIf(!candidateEnabled)("real release candidate evidence", () => {
  it("every requirement has its execution levels and real source files at the same candidate", () => {
    const inputs = loadDossierInputs(process.cwd());
    const selection = selectReleaseEvidence(inputs.ledger, { readEvidence: inputs.readEvidence });
    expect(selection.errors).toEqual([]);
    expect(selection.refs.length).toBeGreaterThan(0);
  });
  it("the dossier maps all candidate requirements, evidence files and operating instructions", () => {
    const inputs = loadDossierInputs(process.cwd());
    const dossier = buildDossier({ ...inputs, exists: (file) => { try { readFileSync(file); return true; } catch { return false; } } });
    expect(dossier.rows).toHaveLength(inputs.ledger.requirements.length);
    for (const row of dossier.rows) {
      expect(row.implementation.verifyDocs.length, row.id).toBeGreaterThan(0);
      expect(row.tests.declared.length + row.tests.namedInVerifyDocs.length, row.id).toBeGreaterThan(0);
      expect(row.tests.missingOnDisk, row.id).toEqual([]);
      for (const [level, status] of Object.entries(row.levels)) if (level !== "production_signoff") expect(status, `${row.id} ${level}`).toBe("performed");
    }
    for (const topic of ["Deployment", "Upgrade and rollback", "Recovery"]) expect(dossier.instructions.find((i) => i.topic === topic)?.present, topic).toBe(true);
    expect(renderMarkdown(dossier)).toContain("Deployment, upgrade and recovery instructions");
  });
});

describe.skipIf(!signoffEnabled)("real accountable production sign-off", () => {
  it("approves only with actual evidence, an external identity/key pin and a real signature", () => {
    const inputs = loadDossierInputs(process.cwd());
    const file = process.env.ZENITH_RELEASE_SIGNOFF_KEYS_FILE;
    expect(file, "Pinned identity/key file must be supplied by the accountable owner").toBeTruthy();
    const keys = JSON.parse(readFileSync(file!, "utf8")) as SignoffKey[];
    expect(inputs.ledger.releaseSignoffs?.length).toBeGreaterThan(0);
    const requested = { ...inputs.ledger, releaseStatus: { implementationComplete: true, sandboxVerified: true, pilotReady: true, productionApproved: true } };
    expect(validateReleaseStatus(requested, { readEvidence: inputs.readEvidence, keys })).toEqual([]);
  });
});
