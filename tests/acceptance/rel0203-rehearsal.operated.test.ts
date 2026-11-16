/**
 * PROD-REL-02 and PROD-REL-03 operational rehearsal (local): the release dossier and status gates through the operator CLIs.
 *
 * Runbook: docs/build/production/verify/PROD-REL-02.md and PROD-REL-03.md ("Scoped release candidate"). The operator works on a
 * private copy of docs/build/production; the repository ledger is not changed.
 *   1. Declares the candidate: this checkout's commit, scoped to the AWS private beta requirements, every status false.
 *   2. The dossier CLI (`npm run release:dossier`) writes the dossier (Markdown and JSON). It exits 0, names the candidate scope, keeps every
 *      requirement row with its unperformed and pending levels, flags rows outside the scope, and records environments.
 *   3. Sets implementationComplete and sandboxVerified: the CLI refuses exactly the scoped rows and execution levels the dossier
 *      shows not performed at the candidate (or accepts, when there are none).
 *   4. Sets pilotReady: refused for exactly the rows whose rehearsal is not performed (plus 3's refusals).
 *   5. Sets productionApproved: refused for a scoped candidate and for the missing sign-off; `signoff-cli prepare` refuses.
 *   6. Deletes one performed receipt file: that level no longer reads performed.
 *
 * Gated: ZENITH_LOCAL_REL0203_REHEARSAL=1. Runs the real CLIs from the checkout root; no network.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const gated = process.env.ZENITH_LOCAL_REL0203_REHEARSAL === "1";
const root = process.cwd();
const BETA = ["MIX-01", "MIX-02", "MIX-03", "MIX-04", "OPS-01", "OPS-02", "OPS-03", "OPS-04", "OPS-05", "OPS-06", "OPS-07", "OPS-08", "OPS-09", "REL-01", "REL-02", "REL-03", "REL-04"].map((id) => `PROD-${id}`);
const EXECUTION = ["contract", "local_engine", "local_cluster", "local_linux_amd64", "local_linux_arm64", "remote_ci", "live_sandbox"];

interface Row { id: string; levels: Record<string, string>; flags: string[]; environments: string[] }
interface Dossier { releaseCandidate: string; releaseCandidateRequirements: string[]; rows: Row[]; releaseStatusErrors: string[] }

describe.skipIf(!gated)("PROD-REL-02/03 operated rehearsal: dossier and status gates at a scoped candidate", () => {
  it("writes the dossier and refuses each status the evidence does not support", () => {
    const copy = mkdtempSync(path.join(os.tmpdir(), "zenith-rel0203-reh-"));
    try {
      cpSync(path.join(root, "docs/build/production"), path.join(copy, "docs/build/production"), { recursive: true });
      const ledgerFile = path.join(copy, "docs/build/production/ledger.json");
      const repoLedger = readFileSync(path.join(root, "docs/build/production/ledger.json"), "utf8");
      const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
      const setLedger = (status: Record<string, boolean>, over: (l: Record<string, unknown>) => void = () => undefined) => {
        const l = JSON.parse(repoLedger) as Record<string, unknown>;
        l.releaseCandidate = { commit, requirements: BETA };
        l.releaseStatus = { implementationComplete: false, sandboxVerified: false, pilotReady: false, productionApproved: false, ...status };
        over(l);
        writeFileSync(ledgerFile, `${JSON.stringify(l, null, 2)}\n`);
      };
      const dossierCli = () => {
        const json = path.join(copy, "dossier.json");
        const run = spawnSync("node", [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "scripts/release/dossier.ts"), "--out", path.join(copy, "dossier.md"), "--json", json], { cwd: copy, encoding: "utf8" });
        return { code: run.status, stderr: run.stderr, dossier: JSON.parse(readFileSync(json, "utf8")) as Dossier };
      };

      // 1-2. Declare the candidate and write the dossier.
      setLedger({});
      const first = dossierCli();
      expect(first.code, first.stderr).toBe(0);
      const d = first.dossier;
      expect(d.releaseCandidate).toBe(commit);
      expect(d.releaseCandidateRequirements).toEqual(BETA);
      expect(d.rows.length).toBe((JSON.parse(repoLedger) as { requirements: unknown[] }).requirements.length);
      expect(readFileSync(path.join(copy, "dossier.md"), "utf8")).toContain(`scoped to ${BETA.length} requirement(s)`);
      for (const row of d.rows) expect(row.flags.includes("outside the release candidate's requirement scope"), row.id).toBe(!BETA.includes(row.id));
      const scoped = d.rows.filter((r) => BETA.includes(r.id));
      const gaps = (levels: (l: string) => boolean) => scoped.flatMap((r) => Object.entries(r.levels).filter(([l, s]) => levels(l) && s !== "performed").map(([l]) => `${r.id}: missing passing ${l} evidence at the release candidate`)).sort();
      const performed = scoped.flatMap((r) => Object.entries(r.levels).filter(([, s]) => s === "performed").map(([l]) => ({ id: r.id, level: l })));
      for (const r of scoped.filter((r) => Object.values(r.levels).includes("performed"))) expect(r.environments.length, r.id).toBeGreaterThan(0);

      // 3. Sandbox verified: refused for exactly the dossier's gaps.
      setLedger({ implementationComplete: true, sandboxVerified: true });
      const sandbox = dossierCli();
      const evidenceErrors = (errors: string[]) => errors.filter((e) => e.endsWith("evidence at the release candidate")).sort();
      expect(evidenceErrors(sandbox.dossier.releaseStatusErrors)).toEqual(gaps((l) => EXECUTION.includes(l)));
      expect(sandbox.code).toBe(sandbox.dossier.releaseStatusErrors.length ? 1 : 0);

      // 4. Pilot ready: also needs the rehearsals.
      setLedger({ implementationComplete: true, sandboxVerified: true, pilotReady: true });
      const pilot = dossierCli();
      expect(evidenceErrors(pilot.dossier.releaseStatusErrors)).toEqual(gaps((l) => EXECUTION.includes(l) || l === "operational_rehearsal"));
      setLedger({ implementationComplete: true, pilotReady: true });
      expect(dossierCli().dossier.releaseStatusErrors).toContain("pilotReady requires sandboxVerified");

      // 5. Production approved: never for a scoped candidate, never without sign-off.
      setLedger({ implementationComplete: true, sandboxVerified: true, pilotReady: true, productionApproved: true });
      const production = dossierCli();
      expect(production.code).toBe(1);
      expect(production.dossier.releaseStatusErrors).toContain("productionApproved requires a release candidate covering every requirement");
      expect(production.dossier.releaseStatusErrors.some((e) => e.startsWith("productionApproved requires an accountable signed sign-off"))).toBe(true);
      setLedger({});
      const prepare = spawnSync("node", [path.join(root, "scripts/release/signoff-cli.mjs"), "prepare", "--who", "Rehearsal operator", "--out", path.join(copy, "draft.json")], { cwd: copy, encoding: "utf8" });
      expect(prepare.status).toBe(1);
      expect(prepare.stderr).toContain("Production sign-off needs a release candidate covering every requirement");

      // 6. A removed receipt loses its level.
      const target = performed[0];
      if (target) {
        const ledger = JSON.parse(repoLedger) as { requirements: { id: string; evidence: { level: string; artifact?: string; commit?: string }[] }[] };
        const entries = ledger.requirements.find((r) => r.id === target.id)!.evidence.filter((e) => e.level === target.level && e.commit === commit && e.artifact);
        for (const e of entries) rmSync(path.join(copy, e.artifact!), { force: true });
        setLedger({});
        expect(dossierCli().dossier.rows.find((r) => r.id === target.id)!.levels[target.level]).not.toBe("performed");
      }
      expect(readFileSync(path.join(root, "docs/build/production/ledger.json"), "utf8")).toBe(repoLedger);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 10 * 60_000);
});
