/**
 * PROD-REL-04 operational rehearsal (local): scope permission and resumable execution, on the release acceptance orchestrator.
 *
 * Runbook: docs/build/production/LIVE-ACCEPTANCE.md, "Budget, cleanup and evidence limits" (after an interruption, resume the
 * exact approved source from the recorded command; no unattended-work claim) and docs/build/production/verify/PROD-REL-04.md.
 *
 * The operator works on a private copy of the owner-approved scope manifest. Nothing is approved here: the copy carries the
 * owner's digest-bound approval, and an edit makes it stale.
 *   1. `permissions-cli check` accepts the copy.
 *   2. `run --only install,release-governance` is started in its own process group and SIGKILLed while its second lane runs.
 *   3. The checkpoint shows the first lane done, the second in progress, `unattendedClaims: false`, no report, and one next
 *      command: the exact resume command.
 *   4. The operator runs that command verbatim. The finished lane is not repeated, the interrupted one runs again, both
 *      scenarios pass, and no next command is left.
 *   5. A live run (`--only mixed-recovery --include-live`) under the approved copy defers its live lane (harness gates not set); it
 *      never runs it.
 *   6. The operator raises a budget in the copy. `permissions-cli check` refuses it, and that run's recorded resume command is
 *      refused (scope changed) before any lane runs.
 * No cloud is reached, no approval is written and the repository manifest is not changed.
 *
 * Gated: ZENITH_LOCAL_REL04_REHEARSAL=1. Runs the real CLIs from the checkout root; vitest lanes run one at a time.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Checkpoint } from "../../scripts/release/checkpoint";
import { SCOPE_MANIFEST_RELATIVE } from "../../scripts/release/scope";

const gated = process.env.ZENITH_LOCAL_REL04_REHEARSAL === "1";
const root = process.cwd();
const diag = (label: string, value: unknown) => { if (process.env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write(`rel04-${label} ${JSON.stringify(value).slice(0, 900)}\n`); };

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
function sh(command: string, env: NodeJS.ProcessEnv, onStart?: (pid: number) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout = (stdout + c.toString()).slice(-20_000); });
    child.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-20_000); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    onStart?.(child.pid!);
  });
}
const read = (file: string): Checkpoint => JSON.parse(readFileSync(file, "utf8")) as Checkpoint;
const step = (cp: Checkpoint, id: string) => cp.steps.find((s) => s.id === id)!;

describe.skipIf(!gated)("PROD-REL-04 operated rehearsal: approved scope, crash, exact resume, scope change refused", () => {
  it("resumes a killed run from its recorded command without repeating finished work, and refuses a changed scope", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-rel04-reh-"));
    const scope = path.join(dir, "scope.json");
    copyFileSync(path.join(root, SCOPE_MANIFEST_RELATIVE), scope);
    const repoManifest = readFileSync(path.join(root, SCOPE_MANIFEST_RELATIVE), "utf8");
    const env = { ...process.env, ZENITH_LIVE_SCOPE_FILE: scope };
    const out = path.join(dir, "out");

    // 1. The copy carries the owner's approval.
    const check = await sh("npx tsx scripts/release/permissions-cli.ts check", env);
    diag("check", check);
    expect(check.code).toBe(0);

    // 2. Start the run and kill its whole process group once the first lane is done and the second is running.
    const runId = "rel04-reh-1";
    const file = path.join(out, runId, "checkpoint.json");
    const [first, second] = ["install.installer-contract", "release-governance.release-tooling"];
    let killed = false;
    const killedRun = await sh(`npx tsx scripts/release/acceptance-orchestrator.ts run --only install,release-governance --out '${out}' --run-id ${runId}`, env, (pid) => {
      const poll = setInterval(() => {
        try {
          const cp = read(file);
          if (step(cp, first).status === "done" && step(cp, second).status === "in_progress") { clearInterval(poll); killed = true; process.kill(-pid, "SIGKILL"); }
        } catch { /* not written yet */ }
      }, 100);
    });
    diag("killed", { code: killedRun.code, signal: killedRun.signal });
    expect(killed).toBe(true);

    // 3. What the operator finds after the crash.
    const atKill = read(file);
    diag("at-kill", atKill);
    expect(atKill.unattendedClaims).toBe(false);
    expect(step(atKill, first)).toMatchObject({ status: "done", attempts: 1 });
    expect(step(atKill, second)).toMatchObject({ status: "in_progress", attempts: 1 });
    expect(existsSync(path.join(out, runId, "acceptance-report.json"))).toBe(false);
    const resume = `npx tsx scripts/release/acceptance-orchestrator.ts run --only install,release-governance --out '${out}' --run-id ${runId}`;
    expect(atKill.nextCommands).toEqual([resume]);

    // 4. Run the recorded command verbatim.
    const resumed = await sh(atKill.nextCommands[0]!, env);
    diag("resumed", { code: resumed.code, stdout: resumed.stdout, stderr: resumed.stderr.slice(-800) });
    expect(resumed.code).toBe(0);
    const after = read(file);
    expect(step(after, first)).toMatchObject({ status: "done", attempts: 1, evidenceDigest: step(atKill, first).evidenceDigest });
    expect(step(after, second)).toMatchObject({ status: "done", attempts: 2 });
    expect(after.unattendedClaims).toBe(false);
    expect(after.nextCommands).toEqual([]);
    const report = JSON.parse(readFileSync(path.join(out, runId, "acceptance-report.json"), "utf8")) as { scenarios: { id: string; status: string }[] };
    expect(report.scenarios.map((s) => [s.id, s.status])).toEqual([["install", "local_passed"], ["release-governance", "local_passed"]]);

    // 5. Live work under the approved copy: the live lane is deferred on its own gates and never runs.
    const liveId = "rel04-reh-live";
    const live = await sh(`npx tsx scripts/release/acceptance-orchestrator.ts run --only mixed-recovery --include-live --out '${out}' --run-id ${liveId}`, env);
    diag("live", { code: live.code, stdout: live.stdout });
    expect(live.code).toBe(0);
    const liveReport = JSON.parse(readFileSync(path.join(out, liveId, "acceptance-report.json"), "utf8")) as { scenarios: { status: string; lanes: { kind: string; status: string; detail: string }[] }[] };
    const liveLane = liveReport.scenarios[0]!.lanes.find((l) => l.kind === "live_sandbox")!;
    expect(liveReport.scenarios[0]!.status).toBe("local_passed_live_pending");
    expect(liveLane.status).toBe("deferred");
    expect(liveLane.detail).toMatch(/gate\(s\) not set/);
    const liveCp = read(path.join(out, liveId, "checkpoint.json"));
    expect(liveCp.nextCommands[0]).toBe(`npx tsx scripts/release/acceptance-orchestrator.ts run --only mixed-recovery --out '${out}' --run-id ${liveId} --include-live`);

    // 6. The operator raises a budget: the owner's approval no longer covers the copy, and the run cannot resume under it.
    const manifest = JSON.parse(readFileSync(scope, "utf8")) as { budgets: { totalUsd: number } };
    manifest.budgets.totalUsd += 1;
    writeFileSync(scope, `${JSON.stringify(manifest, null, 2)}\n`);
    const stale = await sh("npx tsx scripts/release/permissions-cli.ts check", env);
    diag("stale", stale);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/^REFUSED \(/);
    const refused = await sh(liveCp.nextCommands[0]!, env);
    diag("refused", refused);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("The scope manifest changed since this run started");
    expect(read(path.join(out, liveId, "checkpoint.json")).steps).toEqual(liveCp.steps);

    expect(readFileSync(path.join(root, SCOPE_MANIFEST_RELATIVE), "utf8")).toBe(repoManifest);
  }, 20 * 60_000);
});
