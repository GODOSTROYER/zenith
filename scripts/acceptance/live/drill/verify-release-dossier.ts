/**
 * PROD-REL-02 and PROD-REL-03 checks over one finished live AWS run (a passing live_sandbox scenario). No AWS, no
 * credentials, no network: everything is re-derived from the run's files and the repository ledger.
 *
 * REL-02: each requirement the run passed has a release source bound to the run's evidence.json. Receipts built from those
 * sources make the dossier, with the run's commit as a candidate scoped to the run's requirements, read live_sandbox
 * performed for exactly those rows, carrying the run's environment. A requirement the run did not pass stays not performed,
 * rows outside the scope are flagged, and one changed source byte undoes the row.
 * REL-03: on the same candidate the release gates stay separate. All false needs nothing; implementationComplete alone asks
 * for no evidence; sandboxVerified is refused for exactly the rows and levels the dossier does not show performed at the
 * candidate; pilotReady needs sandboxVerified; productionApproved is refused for a scoped candidate and without sign-off.
 *
 * On success it writes release-source-PROD-REL-02.json and release-source-PROD-REL-03.json next to evidence.json.
 *   npx tsx scripts/acceptance/live/drill/verify-release-dossier.ts --run-dir DIR
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, UsageError } from "../../args";
import { digest, REHEARSAL_SCENARIOS } from "../plan";
import { releaseSource, type ReleaseSource } from "../evidence";
import { buildDossier, loadDossierInputs, type Ledger } from "../../../release/dossier";
import { EVIDENCE_FORMAT, EvidenceSchema, sourceOutcome, validateReleaseStatus } from "../../../release/status.mjs";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const EXECUTION = new Set(["contract", "local_engine", "local_cluster", "local_linux_amd64", "local_linux_arm64", "remote_ci", "live_sandbox"]);

interface Packet { sha256: string; commit: string; runId: string; scenario: string; provenance: string; cleanupComplete: boolean; scope: string[]; requirements: { id: string; status: string }[] }

/** Failures (empty when every check holds) for the run files already loaded. `sources` maps requirement id to source bytes. */
export function verifyReleaseDossier(evidenceBytes: Buffer, sources: Map<string, Buffer>, root: string): { failures: string[]; packet?: Packet } {
  const failures: string[] = [];
  const { sha256: own, ...rest } = JSON.parse(evidenceBytes.toString("utf8")) as Packet & Record<string, unknown>;
  const packet = { ...rest, sha256: own } as Packet;
  if (typeof own !== "string" || digest(rest) !== own) return { failures: ["evidence.json does not match its own digest"] };
  if (packet.provenance !== "live_sandbox" || packet.cleanupComplete !== true) failures.push("run is not a live_sandbox run with cleanup complete");
  if ((REHEARSAL_SCENARIOS as readonly string[]).includes(packet.scenario)) failures.push("a rehearsal run is not a live_sandbox source");
  const passed = packet.requirements.filter((r) => r.status === "passed" && packet.scope.includes(r.id)).map((r) => r.id);
  const notPassed = packet.scope.filter((id) => !passed.includes(id));
  if (!passed.length) failures.push("the run passed no requirement");

  // REL-02: sources -> receipts -> dossier at the run's commit as the candidate.
  const dir = `live-run/${packet.runId}`;
  const files = new Map<string, Buffer>();
  const inputs = loadDossierInputs(root);
  const ledger = JSON.parse(JSON.stringify(inputs.ledger)) as Ledger;
  ledger.releaseCandidate = { commit: packet.commit, requirements: [...packet.scope] };
  ledger.releaseStatus = { implementationComplete: false, sandboxVerified: false, pilotReady: false, productionApproved: false };
  ledger.releaseSignoffs = [];
  const environments = new Map<string, string>();
  // Only this run's sources count for the scoped rows' live level, so the checks below judge this run alone.
  for (const r of ledger.requirements) if (packet.scope.includes(r.id)) r.evidence = r.evidence.filter((e) => e.level !== "live_sandbox");
  for (const id of passed) {
    const bytes = sources.get(id);
    if (!bytes) { failures.push(`${id}: passed but has no release source`); continue; }
    const source = JSON.parse(bytes.toString("utf8")) as ReleaseSource;
    if (source.evidence?.sha256 !== sha(evidenceBytes) || source.evidence?.packetSha256 !== own || source.commit !== packet.commit) failures.push(`${id}: release source is not bound to this run's evidence`);
    const outcome = sourceOutcome(source as unknown as Record<string, unknown>);
    const sourcePath = `${dir}/release-source-${id}.json`;
    files.set(sourcePath, bytes);
    const receipt = Buffer.from(JSON.stringify(EvidenceSchema.parse({ format: EVIDENCE_FORMAT, requirementId: id, level: "live_sandbox", mode: "live", commit: outcome.commit,
      environment: String(outcome.environment), command: String(outcome.command), status: "passed", passed: outcome.passed, failed: outcome.failed, skipped: outcome.skipped,
      exitCode: outcome.exitCode, sources: [{ path: sourcePath, sha256: sha(bytes) }] })));
    const receiptPath = `${dir}/release-evidence-${id}.json`;
    files.set(receiptPath, receipt);
    environments.set(id, String(outcome.environment));
    ledger.requirements.find((r) => r.id === id)?.evidence.push({ level: "live_sandbox", commit: packet.commit, artifact: receiptPath, sha256: sha(receipt) });
  }
  const read = (over: Map<string, Buffer>) => (relative: string): Buffer => over.get(relative) ?? files.get(relative) ?? inputs.readEvidence(relative);
  const rows = new Map(buildDossier({ ledger, verifyDocs: [], evidenceFiles: [], readEvidence: read(new Map()) }).rows.map((r) => [r.id, r]));
  for (const id of passed) {
    const row = rows.get(id);
    if (row?.levels.live_sandbox !== "performed") failures.push(`${id}: dossier does not read live_sandbox performed`);
    if (!row?.environments.some((e) => environments.get(id)?.replace(/\s+/g, " ").startsWith(e.slice(0, 120)))) failures.push(`${id}: dossier row does not carry the run's environment`);
  }
  for (const id of notPassed) if (rows.get(id)?.levels.live_sandbox === "performed") failures.push(`${id}: not passed by the run but reads performed`);
  const outside = [...rows.values()].filter((r) => !packet.scope.includes(r.id));
  if (outside.some((r) => !r.flags.includes("outside the release candidate's requirement scope"))) failures.push("a row outside the candidate scope is not flagged");
  const first = passed.find((id) => files.has(`${dir}/release-source-${id}.json`));
  if (first) {
    const sourcePath = `${dir}/release-source-${first}.json`;
    const changed = Buffer.from(files.get(sourcePath)!); changed[changed.length - 2] ^= 0x01;
    const tampered = buildDossier({ ledger, verifyDocs: [], evidenceFiles: [], readEvidence: read(new Map([[sourcePath, changed]])) }).rows.find((r) => r.id === first);
    if (tampered?.levels.live_sandbox === "performed") failures.push(`${first}: a changed source byte still reads performed`);
  }

  // REL-03: separate gates on the same candidate.
  const options = { readEvidence: read(new Map()) };
  const gate = (status: NonNullable<Ledger["releaseStatus"]>) => validateReleaseStatus({ ...ledger, releaseStatus: status } as never, options);
  if (gate({ implementationComplete: false, sandboxVerified: false, pilotReady: false, productionApproved: false }).length) failures.push("all-false status is refused");
  if (gate({ implementationComplete: true, sandboxVerified: false, pilotReady: false, productionApproved: false }).some((e) => /evidence/.test(e))) failures.push("implementationComplete alone asked for evidence");
  const expected = new Set(packet.scope.flatMap((id) => Object.entries(rows.get(id)?.levels ?? {}).filter(([level, state]) => EXECUTION.has(level) && state !== "performed").map(([level]) => `${id}: missing passing ${level} evidence at the release candidate`)));
  const sandbox = new Set(gate({ implementationComplete: true, sandboxVerified: true, pilotReady: false, productionApproved: false }).filter((e) => /evidence at the release candidate$/.test(e)));
  if ([...expected].some((e) => !sandbox.has(e)) || [...sandbox].some((e) => !expected.has(e))) failures.push("sandboxVerified refusals differ from the dossier's unperformed execution levels");
  if (!gate({ implementationComplete: true, sandboxVerified: false, pilotReady: true, productionApproved: false }).includes("pilotReady requires sandboxVerified")) failures.push("pilotReady did not require sandboxVerified");
  const production = gate({ implementationComplete: true, sandboxVerified: true, pilotReady: true, productionApproved: true });
  if (!production.includes("productionApproved requires a release candidate covering every requirement")) failures.push("productionApproved accepted a scoped candidate");
  if (!production.some((e) => e.startsWith("productionApproved requires an accountable signed sign-off"))) failures.push("productionApproved accepted no sign-off");
  return { failures, packet };
}

/** The REL-02 and REL-03 release sources for a run the checks passed, bound to the run's evidence bytes. */
export function dossierReleaseSources(evidenceBytes: Buffer, packet: Packet): ReleaseSource[] {
  const { sha256: own, ...rest } = JSON.parse(evidenceBytes.toString("utf8")) as Record<string, unknown>;
  const passed = packet.requirements.filter((r) => r.status === "passed" && packet.scope.includes(r.id)).map((r) => r.id);
  const reasons: Record<string, string> = {
    "PROD-REL-02": `Release sources of run ${packet.runId} (${passed.join(", ")}) built receipts that the dossier, with commit ${packet.commit.slice(0, 8)} as a candidate scoped to the run's requirements, reads live_sandbox performed with the run's environment; requirements the run did not pass stayed not performed, rows outside the scope were flagged, and a changed source byte undid the row.`,
    "PROD-REL-03": `On the same candidate: all-false status needed nothing, implementationComplete alone asked for no evidence, sandboxVerified was refused for exactly the levels the dossier shows unperformed, pilotReady required sandboxVerified, and productionApproved was refused for a scoped candidate and without an accountable sign-off.`,
  };
  return Object.entries(reasons).map(([id, reason]) => {
    const source = releaseSource({ ...rest, sha256: own, requirements: [{ id, status: "passed", reason }] }, id, sha(evidenceBytes));
    if (!source) throw new Error(`no release source for ${id}`);
    return { ...source, command: `${source.command}; dossier and release gates re-derived offline by verify-release-dossier.ts` };
  });
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv, { booleans: [], strings: ["run-dir"] });
  if (args.positional.length) throw new UsageError("Positional arguments are not accepted.");
  const runDir = args.values.get("run-dir");
  if (!runDir) throw new UsageError("--run-dir is required.");
  const evidenceBytes = readFileSync(path.join(runDir, "evidence.json"));
  const scope = (JSON.parse(evidenceBytes.toString("utf8")) as { scope?: string[] }).scope ?? [];
  const sources = new Map(scope.filter((id) => existsSync(path.join(runDir, `release-source-${id}.json`))).map((id) => [id, readFileSync(path.join(runDir, `release-source-${id}.json`))]));
  const { failures, packet } = verifyReleaseDossier(evidenceBytes, sources, process.cwd());
  if (failures.length || !packet) {
    process.stderr.write(`release dossier checks NOT verified (${failures.length} failure(s)):\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
    return 1;
  }
  for (const source of dossierReleaseSources(evidenceBytes, packet)) writeFileSync(path.join(runDir, `release-source-${source.requirements[0]}.json`), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  process.stdout.write(`release dossier checks verified for ${packet.runId}; release sources for PROD-REL-02 and PROD-REL-03 written.\n`);
  return 0;
}

if (/(?:^|[/\\])verify-release-dossier\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof UsageError ? error.message : "release dossier verifier could not read its inputs"}\n`);
    process.exitCode = 2;
  }
}
