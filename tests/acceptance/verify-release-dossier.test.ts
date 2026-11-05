/** PROD-REL-02/03: the offline dossier and release-gate checks over a real committed live run (PROD-MIX-01, run 41617473729). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dossierReleaseSources, verifyReleaseDossier } from "../../scripts/acceptance/live/drill/verify-release-dossier";
import { sourceOutcome } from "../../scripts/release/status.mjs";

const RUN = "docs/build/production/evidence/PROD-MIX-01/2026-11-03-live-aws-41617473729";
const REHEARSAL = "docs/build/production/evidence/PROD-MIX-01/2026-11-04-operational-rehearsal-live-aws-41835860881";
const evidence = readFileSync(`${RUN}/evidence.json`);
const sources = () => new Map([["PROD-MIX-01", readFileSync(`${RUN}/release-source-PROD-MIX-01.json`)]]);

describe("verify-release-dossier over a real live run", () => {
  it("re-derives the dossier row and the separate release gates, then writes live REL-02 and REL-03 sources", () => {
    const { failures, packet } = verifyReleaseDossier(evidence, sources(), process.cwd());
    expect(failures).toEqual([]);
    const written = dossierReleaseSources(evidence, packet!);
    expect(written.map((s) => [s.requirements, s.mode, s.commit])).toEqual([[["PROD-REL-02"], "live", packet!.commit], [["PROD-REL-03"], "live", packet!.commit]]);
    for (const s of written) expect(sourceOutcome(s as never)).toMatchObject({ passed: 1, failed: 0, skipped: 0, exitCode: 0, mode: "live" });
  });
  it("refuses a changed evidence byte, a missing or foreign source, and a rehearsal run", () => {
    const changed = Buffer.from(evidence); changed[changed.indexOf("mix-01")] = 0x4e;
    expect(verifyReleaseDossier(changed, sources(), process.cwd()).failures).toEqual(["evidence.json does not match its own digest"]);
    expect(verifyReleaseDossier(evidence, new Map(), process.cwd()).failures).toContain("PROD-MIX-01: passed but has no release source");
    const foreign = new Map([["PROD-MIX-01", readFileSync(`${REHEARSAL}/release-source-PROD-MIX-01.json`)]]);
    expect(verifyReleaseDossier(evidence, foreign, process.cwd()).failures).toContain("PROD-MIX-01: release source is not bound to this run's evidence");
    const rehearsal = readFileSync(`${REHEARSAL}/evidence.json`);
    expect(verifyReleaseDossier(rehearsal, new Map(), process.cwd()).failures).toContain("a rehearsal run is not a live_sandbox source");
  });
});
