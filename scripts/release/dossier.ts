/**
 * Requirement-to-evidence release dossier (PROD-REL-02).
 *
 *   npx tsx scripts/release/dossier.ts [--out DOSSIER.md] [--json DOSSIER.json] [--acceptance <acceptance-report.json>]
 *
 * Reads `docs/build/production/ledger.json`, `docs/build/production/evidence/**` and the verification documents under
 * `docs/build/production/verify/`, and emits one row per requirement:
 *
 *   requirement -> implementation (verify docs) -> tests (declared, named in the verify docs, present on disk)
 *               -> environment -> commit(s) -> evidence by required level
 *
 * Honesty rules, enforced here and by `tests/release/dossier.test.ts`:
 *  - evidence is only what the ledger records or the evidence directory holds; nothing is inferred;
 *  - a required evidence level with no recorded entry is `unperformed` (live_sandbox, operational_rehearsal,
 *    production_signoff: deferred or never run) or `pending` (everything else); it is never shown as passed;
 *  - the word "passed" never appears as a requirement status: a row is `verified` only when the ledger says so AND every
 *    required level has an entry; otherwise it reads implementation-complete-unverified, in progress, planned or
 *    not assessed;
 *  - skips and failures mentioned by an evidence entry or counted in an evidence file are flagged on the row;
 *  - the ledger's `releaseStatus` flags are copied verbatim and this tool never changes them.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AcceptanceReport } from "./acceptance-orchestrator";

export const DEFERRED_LEVELS: readonly string[] = ["live_sandbox", "operational_rehearsal", "production_signoff"];

interface LedgerEvidence { level: string; commit?: string; command?: string; environment?: string; logs?: string; artifact?: string; runId?: number; url?: string; result?: string }
interface LedgerRequirement {
  id: string; title: string; acceptance: string[]; state: string; dependencies: string[]; implementationStatus: string; evidence: LedgerEvidence[]; requiredEvidence: string[]; owner: string | null; testPaths: string[];
}
export interface Ledger { requirements: LedgerRequirement[]; releaseStatus?: Record<string, boolean>; evidenceLevels?: string[]; baseline?: { commit?: string } }

export interface VerifyDoc { file: string; text: string }
export interface EvidenceFile { requirement: string; file: string; json?: Record<string, unknown> }

export type RowStatus = "verified" | "implementation_complete_unverified" | "in_progress" | "planned" | "not_assessed";
export type LevelState = "performed" | "pending" | "unperformed";

export interface DossierRow {
  id: string;
  title: string;
  acceptance: string[];
  ledgerState: string;
  implementationStatus: string;
  status: RowStatus;
  implementation: { verifyDocs: string[] };
  tests: { declared: string[]; namedInVerifyDocs: string[]; missingOnDisk: string[] };
  environments: string[];
  commits: string[];
  evidence: { level: string; commit: string | null; where: string | null; summary: string }[];
  levels: Record<string, LevelState>;
  evidenceFiles: { file: string; status: string }[];
  scenarios: { id: string; status: string }[];
  flags: string[];
}

export interface Dossier {
  schema: 1;
  generatedAt: string;
  ledgerBaseline: string | null;
  releaseStatus: Record<string, boolean>;
  rows: DossierRow[];
  summary: { total: number; byStatus: Record<RowStatus, number>; unperformedLevels: number; pendingLevels: number; flagged: number };
  instructions: { topic: string; file: string; present: boolean }[];
  acceptance: { runId: string; generatedAt: string; sourceCommit: string | null; summary: AcceptanceReport["summary"] } | null;
  statement: string;
}

const STATEMENT = "This dossier lists what is recorded, not what is true. Unperformed and pending items are shown as such. It does not approve a release and does not change the ledger's release status.";

const INSTRUCTIONS: readonly { topic: string; file: string }[] = [
  { topic: "Deployment", file: "docs/platform/INSTALLATION.md" },
  { topic: "Deployment (operations)", file: "docs/platform/operations/DEPLOYING.md" },
  { topic: "Upgrade and rollback", file: "docs/platform/operations/ROLLING-UPGRADES.md" },
  { topic: "Recovery", file: "docs/platform/operations/RECOVERY.md" },
  { topic: "Mixed-cloud recovery", file: "docs/platform/operations/MIXED-RECOVERY.md" },
  { topic: "Mixed-cloud partitions", file: "docs/platform/operations/MIXED-PARTITIONS.md" },
  { topic: "Teardown", file: "docs/platform/operations/TEARDOWN.md" },
  { topic: "Key custody and rotation", file: "docs/platform/operations/KEY-CUSTODY.md" },
  { topic: "Cost", file: "docs/platform/operations/COST.md" },
];

const ID = /PROD-[A-Z]+-\d{2}/g;

/** Requirement ids a verify document covers: its file name (`PROD-MIX-03-04.md`) and the ids in its title block. */
export function idsCoveredBy(doc: VerifyDoc): string[] {
  const ids = new Set<string>();
  const base = path.basename(doc.file, ".md");
  const range = /^PROD-([A-Z]+)-(\d{2})(?:-(\d{2}))?(?:-[A-Z]+)?$/.exec(base);
  if (range) {
    const from = Number(range[2]); const to = range[3] ? Number(range[3]) : from;
    if (to >= from && to - from < 20) for (let n = from; n <= to; n++) ids.add(`PROD-${range[1]}-${String(n).padStart(2, "0")}`);
  }
  const head = doc.text.split("\n").filter((line) => line.startsWith("#")).slice(0, 3).join("\n");
  for (const match of head.matchAll(ID)) ids.add(match[0]);
  return [...ids];
}

const TEST_PATH = /\b(tests\/[A-Za-z0-9_./-]+\.test\.tsx?)\b/g;

export function testsNamedIn(text: string): string[] {
  return [...new Set([...text.matchAll(TEST_PATH)].map((m) => m[1]!))].sort();
}

function rowStatus(req: LedgerRequirement, levels: Record<string, LevelState>): RowStatus {
  const allPerformed = req.requiredEvidence.length > 0 && req.requiredEvidence.every((l) => levels[l] === "performed");
  if (req.state === "verified" && allPerformed) return "verified";
  if (/^implementation_complete/.test(req.implementationStatus)) return "implementation_complete_unverified";
  if (req.state === "planned" || req.implementationStatus === "not_assessed") return req.implementationStatus === "not_assessed" ? "not_assessed" : "planned";
  return "in_progress";
}

const excerpt = (text: string | undefined, n = 220): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function buildDossier(input: { ledger: Ledger; verifyDocs: readonly VerifyDoc[]; evidenceFiles: readonly EvidenceFile[]; acceptance?: AcceptanceReport; exists?: (relative: string) => boolean; now?: () => Date }): Dossier {
  const exists = input.exists ?? (() => true);
  const docsById = new Map<string, VerifyDoc[]>();
  for (const doc of input.verifyDocs) for (const id of idsCoveredBy(doc)) docsById.set(id, [...(docsById.get(id) ?? []), doc]);
  const rows: DossierRow[] = input.ledger.requirements.map((req) => {
    const docs = docsById.get(req.id) ?? [];
    const named = [...new Set(docs.flatMap((d) => testsNamedIn(d.text)))].sort();
    const declared = [...req.testPaths].sort();
    const levels: Record<string, LevelState> = {};
    for (const level of req.requiredEvidence) levels[level] = req.evidence.some((e) => e.level === level) ? "performed" : DEFERRED_LEVELS.includes(level) ? "unperformed" : "pending";
    const files = input.evidenceFiles.filter((f) => f.requirement === req.id).map((f) => {
      const j = f.json;
      const failed = typeof j?.failed === "number" ? j.failed : 0;
      const skipped = typeof j?.skipped === "number" ? j.skipped : 0;
      const status = j ? `${String(j.status ?? "recorded")}${typeof j.passed === "number" ? `: ${j.passed} passed, ${failed} failed, ${skipped} skipped` : ""}` : "unreadable";
      return { file: f.file, status };
    });
    const flags: string[] = [];
    if (!docs.length) flags.push("no verification document names this requirement");
    const missing = [...new Set([...declared, ...named])].filter((t) => !exists(t));
    if (missing.length) flags.push(`${missing.length} named test file(s) do not exist on disk`);
    if (req.evidence.some((e) => /skip/i.test(e.result ?? ""))) flags.push("evidence mentions skipped tests");
    if (input.evidenceFiles.some((f) => f.requirement === req.id && ((typeof f.json?.failed === "number" && f.json.failed > 0) || f.json === undefined))) flags.push("an evidence file reports failures or is unreadable");
    for (const [level, state] of Object.entries(levels)) if (state === "unperformed") flags.push(`${level} evidence unperformed`);
    const scenarios = (input.acceptance?.scenarios ?? []).filter((s) => s.requirements.includes(req.id)).map((s) => ({ id: s.id, status: s.status }));
    return {
      id: req.id, title: req.title, acceptance: req.acceptance, ledgerState: req.state, implementationStatus: req.implementationStatus, status: rowStatus(req, levels),
      implementation: { verifyDocs: docs.map((d) => d.file).sort() }, tests: { declared, namedInVerifyDocs: named, missingOnDisk: missing.sort() },
      environments: [...new Set(req.evidence.map((e) => e.environment).filter((e): e is string => !!e).map((e) => excerpt(e, 160)))],
      commits: [...new Set(req.evidence.map((e) => e.commit).filter((c): c is string => !!c))],
      evidence: req.evidence.map((e) => ({ level: e.level, commit: e.commit ?? null, where: e.logs ?? e.artifact ?? e.url ?? null, summary: excerpt(e.result) })),
      levels, evidenceFiles: files, scenarios, flags,
    };
  });
  const byStatus: Record<RowStatus, number> = { verified: 0, implementation_complete_unverified: 0, in_progress: 0, planned: 0, not_assessed: 0 };
  let unperformed = 0; let pending = 0;
  for (const r of rows) {
    byStatus[r.status] += 1;
    for (const state of Object.values(r.levels)) { if (state === "unperformed") unperformed += 1; if (state === "pending") pending += 1; }
  }
  return {
    schema: 1, generatedAt: (input.now ?? (() => new Date()))().toISOString(), ledgerBaseline: input.ledger.baseline?.commit ?? null,
    releaseStatus: { ...(input.ledger.releaseStatus ?? {}) }, rows,
    summary: { total: rows.length, byStatus, unperformedLevels: unperformed, pendingLevels: pending, flagged: rows.filter((r) => r.flags.length > 0).length },
    instructions: INSTRUCTIONS.map((i) => ({ ...i, present: exists(i.file) })),
    acceptance: input.acceptance ? { runId: input.acceptance.runId, generatedAt: input.acceptance.generatedAt, sourceCommit: input.acceptance.sourceCommit, summary: input.acceptance.summary } : null,
    statement: STATEMENT,
  };
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (sha: string): string => sha.slice(0, 8);

export function renderMarkdown(d: Dossier): string {
  const out: string[] = ["# Release evidence dossier", "", d.statement, "",
    `Generated ${d.generatedAt}. Ledger baseline ${d.ledgerBaseline ? short(d.ledgerBaseline) : "unknown"}.`, "",
    "## Release status (copied from the ledger, not changed here)", "", ...Object.entries(d.releaseStatus).map(([k, v]) => `- ${k}: ${v}`), "",
    "## Summary", "", `- Requirements: ${d.summary.total}`, ...Object.entries(d.summary.byStatus).map(([k, v]) => `- ${k}: ${v}`),
    `- Required evidence levels unperformed (deferred or never run): ${d.summary.unperformedLevels}`, `- Required evidence levels pending: ${d.summary.pendingLevels}`, `- Rows with flags: ${d.summary.flagged}`, ""];
  if (d.acceptance) out.push("## Acceptance orchestrator run", "", `Run ${d.acceptance.runId} at ${d.acceptance.generatedAt}${d.acceptance.sourceCommit ? ` on ${short(d.acceptance.sourceCommit)}` : ""}: ${JSON.stringify(d.acceptance.summary)}`, "");
  out.push("## Requirement to evidence", "", "| Requirement | Status | Implementation | Tests | Environment | Commit(s) | Evidence by required level |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of d.rows) {
    const levels = Object.entries(r.levels).map(([level, state]) => `${level}: ${state.toUpperCase()}`).join("; ") || "no evidence level required";
    out.push(`| ${cell(`${r.id} ${r.title}`)} | ${r.status} | ${cell(r.implementation.verifyDocs.join(", ") || "none named")} | ${r.tests.declared.length} declared, ${r.tests.namedInVerifyDocs.length} named in docs${r.tests.missingOnDisk.length ? `, ${r.tests.missingOnDisk.length} MISSING` : ""} | ${cell(r.environments.join(" / ") || "none recorded")} | ${cell(r.commits.map(short).join(", ") || "none")} | ${cell(levels)} |`);
  }
  out.push("", "## Per requirement detail", "");
  for (const r of d.rows) {
    out.push(`### ${r.id} ${r.title}`, "", `Status ${r.status}; ledger state ${r.ledgerState}; implementation status \`${r.implementationStatus}\`.`, "", ...r.acceptance.map((a) => `Acceptance: ${a}`), "");
    if (r.evidence.length) out.push("Recorded evidence:", ...r.evidence.map((e) => `- ${e.level}${e.commit ? ` at ${short(e.commit)}` : ""}${e.where ? ` (${e.where})` : ""}: ${e.summary}`), "");
    if (r.evidenceFiles.length) out.push("Evidence files:", ...r.evidenceFiles.map((f) => `- ${f.file}: ${f.status}`), "");
    if (r.scenarios.length) out.push("Acceptance scenarios:", ...r.scenarios.map((s) => `- ${s.id}: ${s.status}`), "");
    if (r.flags.length) out.push("Flags:", ...r.flags.map((f) => `- ${f}`), "");
  }
  out.push("## Deployment, upgrade and recovery instructions", "", ...d.instructions.map((i) => `- ${i.topic}: ${i.present ? i.file : `${i.file} (MISSING)`}`), "");
  return `${out.join("\n")}\n`;
}

/* ------------------------------- file loading ------------------------------ */

function walk(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, accept) : accept(entry.name) ? [full] : [];
  });
}

export function loadDossierInputs(root: string): { ledger: Ledger; verifyDocs: VerifyDoc[]; evidenceFiles: EvidenceFile[] } {
  const base = path.join(root, "docs/build/production");
  const ledger = JSON.parse(readFileSync(path.join(base, "ledger.json"), "utf8")) as Ledger;
  const verifyDocs = walk(path.join(base, "verify"), (n) => n.endsWith(".md")).sort().map((file) => ({ file: path.relative(root, file).replaceAll("\\", "/"), text: readFileSync(file, "utf8") }));
  const evidenceRoot = path.join(base, "evidence");
  const evidenceFiles = walk(evidenceRoot, (n) => n.endsWith(".json")).sort().filter((f) => statSync(f).size < 5_000_000).map((file) => {
    const rel = path.relative(evidenceRoot, file).replaceAll("\\", "/");
    let json: Record<string, unknown> | undefined;
    try { json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { json = undefined; }
    return { requirement: rel.split("/")[0]!, file: path.relative(root, file).replaceAll("\\", "/"), ...(json ? { json } : {}) };
  });
  return { ledger, verifyDocs, evidenceFiles };
}

export function runDossierCli(argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } }, root: string = process.cwd()): number {
  const value = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const inputs = loadDossierInputs(root);
    const acceptanceFile = value("--acceptance");
    const acceptance = acceptanceFile ? (JSON.parse(readFileSync(acceptanceFile, "utf8")) as AcceptanceReport) : undefined;
    const dossier = buildDossier({ ...inputs, ...(acceptance ? { acceptance } : {}), exists: (rel) => existsSync(path.join(root, rel)) });
    const md = renderMarkdown(dossier);
    const outFile = value("--out");
    if (outFile) writeFileSync(outFile, md); else io.out(md);
    const jsonFile = value("--json");
    if (jsonFile) writeFileSync(jsonFile, `${JSON.stringify(dossier, null, 2)}\n`);
    io.err(`${dossier.summary.total} requirements; ${dossier.summary.byStatus.verified} verified; ${dossier.summary.unperformedLevels} unperformed and ${dossier.summary.pendingLevels} pending evidence level(s); ${dossier.summary.flagged} row(s) flagged.\n`);
    return 0;
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : "unexpected error"}\n`);
    return 2;
  }
}

if (process.argv[1] && /(?:^|[/\\])dossier\.(?:ts|mts|js|mjs)$/.test(process.argv[1])) process.exitCode = runDossierCli(process.argv.slice(2));
