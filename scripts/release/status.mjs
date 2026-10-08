/** REL-02/03: offline evidence and accountable release approval. No cloud calls or credential custody. */
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { privateKeyFromSeed } from "../supply-chain/release.mjs";

const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Requirement = z.string().regex(/^PROD-[A-Z]+-\d{2}$/);
const Levels = z.enum(["contract", "local_engine", "local_cluster", "local_linux_amd64", "local_linux_arm64", "remote_ci", "live_sandbox", "operational_rehearsal"]);
const Text = z.string().trim().min(1).max(2000);
const Relative = z.string().refine((s) => /^[A-Za-z0-9_./-]+$/.test(s) && !s.startsWith("/") && !s.split("/").some((p) => !p || p === "." || p === ".."), "repository-relative path required");
export const EVIDENCE_FORMAT = "zenith.release-evidence.v1";
export const SIGNOFF_FORMAT = "zenith.release-signoff.v1";
export const EvidenceSchema = z.object({
  format: z.literal(EVIDENCE_FORMAT), requirementId: Requirement, level: Levels, commit: Commit,
  environment: Text, command: Text, mode: z.enum(["contract", "local", "live", "remote_ci"]),
  status: z.enum(["passed", "failed", "skipped", "not_run"]),
  passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  exitCode: z.number().int(),
  // References to the original sanitized engine report/runbook receipt, not placeholders or prose assertions.
  sources: z.array(z.object({ path: Relative, sha256: Hash }).strict()).min(1).max(200),
}).strict();
export const SignoffSchema = z.object({
  format: z.literal(SIGNOFF_FORMAT), who: Text, when: z.string().datetime({ offset: true }), commit: Commit,
  scope: z.object({ status: z.literal("productionApproved"), requirements: z.array(Requirement).min(1) }).strict(),
  ledgerSha256: Hash,
  evidence: z.array(z.object({ requirementId: Requirement, level: Levels, path: Relative, sha256: Hash }).strict()).min(1),
  signature: z.object({ algorithm: z.literal("Ed25519"), kid: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), value: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict(),
}).strict();
const KeySchema = z.object({ kid: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), identity: Text }).strict();
const LIVE_REHEARSALS = new Set(["PROD-MIX-05", "PROD-MIX-06", "PROD-MIX-07", "PROD-MAN-02", "PROD-MAN-03"]);
const MAX_BYTES = 5_000_000;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Read bounded regular files inside the repository, including containment after symlink resolution. */
export function readRepositoryFile(root, relative) {
  Relative.parse(relative);
  const base = realpathSync(root);
  const target = path.resolve(base, relative);
  const info = lstatSync(target);
  const resolved = realpathSync(target);
  const suffix = path.relative(base, resolved);
  if (!info.isFile() || info.size > MAX_BYTES || suffix.startsWith(`..${path.sep}`) || suffix === ".." || path.isAbsolute(suffix)) throw new Error("Evidence must be a bounded repository file");
  return readFileSync(target);
}

/** Bind the contract and evidence inventory, excluding the approval records and flags they authorize. */
export function releaseSnapshotDigest(ledger) {
  const snapshot = Object.fromEntries(Object.entries(ledger).filter(([key]) => key !== "releaseSignoffs" && key !== "releaseStatus"));
  return sha256(canonical(snapshot));
}

/** Existing sanitized lane reports and verifier count receipts; prose and raw unbound Vitest output are insufficient. */
export function sourceOutcome(source) {
  const counts = source.counts ?? source.summary;
  const commit = source.commit ?? source.sourceCommit ?? source.provenance?.commit;
  const exitCode = source.rootExecutionExitCode ?? source.exitCode ?? source.execution?.exitCode;
  const countSchema = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() });
  const parsed = countSchema.parse(counts);
  Commit.parse(commit);
  const mode = z.enum(["contract", "local", "live", "remote_ci"]).parse(source.mode);
  const environment = source.environment ?? source.provenance?.environment;
  const requirements = z.array(Requirement).min(1).parse(source.requirements);
  if (!Number.isInteger(exitCode) || !environment || !source.command) throw new Error("Original evidence lacks execution/environment/command binding");
  Text.parse(typeof environment === "string" ? environment : canonical(environment));
  Text.parse(typeof source.command === "string" ? source.command : canonical(source.command));
  return { ...parsed, commit, exitCode, mode, requirements, command: source.command, environment, status: source.verdict ?? source.status };
}

export function inspectEvidence(requirementId, evidence, options = {}) {
  const file = evidence.artifact ?? evidence.logs;
  const read = options.readEvidence ?? ((relative) => readRepositoryFile(options.root, relative));
  const result = { valid: false, recorded: false, file: typeof file === "string" ? file : null, sha256: null, receipt: null, errors: [] };
  try {
    Relative.parse(file);
    const bytes = read(file);
    if (bytes.length > MAX_BYTES) throw new Error("Evidence is oversized");
    result.recorded = true;
    result.sha256 = sha256(bytes);
    const receipt = EvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
    result.receipt = receipt;
    if (evidence.sha256 !== result.sha256) result.errors.push("missing or mismatched evidence hash");
    if (receipt.requirementId !== requirementId || receipt.level !== evidence.level || receipt.commit !== evidence.commit) result.errors.push("evidence identity/level/commit mismatch");
    if (options.commit !== undefined && receipt.commit !== options.commit) result.errors.push("evidence is from a different release candidate");
    if (receipt.status !== "passed" || receipt.passed === 0 || receipt.failed !== 0 || receipt.skipped !== 0 || receipt.exitCode !== 0) result.errors.push("evidence failed, skipped, unperformed or empty");
    if (receipt.level === "contract" && receipt.mode !== "contract") result.errors.push("contract evidence mode mismatch");
    if (receipt.level === "live_sandbox" && receipt.mode !== "live") result.errors.push("sandbox evidence must be live");
    if (receipt.level === "remote_ci" && receipt.mode !== "remote_ci") result.errors.push("CI evidence must be remote");
    if (receipt.level.startsWith("local_") && receipt.mode !== "local") result.errors.push("engine evidence must be local");
    if (receipt.level === "operational_rehearsal" && (!['local', 'live'].includes(receipt.mode) || (LIVE_REHEARSALS.has(requirementId) && receipt.mode !== "live"))) result.errors.push("rehearsal environment does not satisfy this requirement");
    if (receipt.sources.some((source) => source.path === file)) result.errors.push("evidence cannot cite itself");
    let sourcePassed = 0;
    for (const source of receipt.sources) {
      const bytes = read(source.path);
      if (bytes.length > MAX_BYTES || sha256(bytes) !== source.sha256) throw new Error("original evidence source hash mismatch");
      const outcome = sourceOutcome(JSON.parse(bytes.toString("utf8")));
      if (!outcome.requirements.includes(requirementId)) result.errors.push("original evidence does not cover this requirement");
      sourcePassed += outcome.passed;
      if (outcome.mode !== receipt.mode) result.errors.push("original evidence mode mismatch");
      const text = (v) => typeof v === "string" ? v : JSON.stringify(v);
      if (receipt.sources.length === 1 && (text(outcome.environment) !== receipt.environment || text(outcome.command) !== receipt.command)) result.errors.push("original environment/command binding mismatch");
      if (outcome.commit !== receipt.commit || outcome.exitCode !== 0 || outcome.passed === 0 || outcome.failed !== 0 || outcome.skipped !== 0 || (outcome.status && outcome.status !== "passed")) result.errors.push("original evidence is not a passing run on the candidate");
    }
    if (sourcePassed !== receipt.passed) result.errors.push("receipt count differs from original evidence");
    result.valid = result.errors.length === 0;
  } catch {
    result.errors.push(result.recorded ? "unreadable or unsupported evidence receipt/source" : "missing or unsafe evidence file reference");
  }
  return result;
}

export function selectReleaseEvidence(ledger, options = {}, includeRehearsals = true) {
  const commit = ledger.releaseCandidate?.commit;
  const errors = [];
  const refs = [];
  if (!Commit.safeParse(commit).success) errors.push("releaseCandidate.commit must be a full release candidate SHA");
  for (const req of ledger.requirements) {
    const levels = req.requiredEvidence.filter((level) => level !== "production_signoff" && (includeRehearsals || level !== "operational_rehearsal"));
    if (new Set(req.requiredEvidence).size !== req.requiredEvidence.length || req.requiredEvidence.some((l) => l !== "production_signoff" && !Levels.safeParse(l).success)) errors.push(`${req.id}: invalid required evidence inventory`);
    if (levels.length === 0) errors.push(`${req.id}: no required execution evidence`);
    for (const level of levels) {
      const found = req.evidence.filter((e) => e.level === level).map((e) => inspectEvidence(req.id, e, { ...options, commit })).find((e) => e.valid);
      if (!found) errors.push(`${req.id}: missing passing ${level} evidence at the release candidate`);
      else refs.push({ requirementId: req.id, level, path: found.file, sha256: found.sha256 });
    }
  }
  return { errors, refs: refs.sort((a, b) => canonical(a).localeCompare(canonical(b))) };
}

function signoffBody(record) {
  return Buffer.from(`${SIGNOFF_FORMAT}\n${canonical(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "signature")))}`);
}

/** Caller must be an accountable human with a private seed; this helper makes no approval decision. */
export function signSignoff(body, seed, kid) {
  const record = { ...body, signature: { algorithm: "Ed25519", kid, value: sign(null, signoffBody(body), privateKeyFromSeed(seed)).toString("base64url") } };
  return SignoffSchema.parse(record);
}

export function verifySignoff(record, ledger, refs, keys, now = new Date()) {
  try {
    const parsed = SignoffSchema.parse(record);
    const trusted = z.array(KeySchema).min(1).parse(keys);
    if (new Set(trusted.map((k) => k.kid)).size !== trusted.length) return false;
    const key = trusted.find((k) => k.kid === parsed.signature.kid && k.identity === parsed.who);
    if (!key || parsed.commit !== ledger.releaseCandidate?.commit || Date.parse(parsed.when) > now.getTime() || !Number.isFinite(now.getTime())) return false;
    const scope = [...parsed.scope.requirements].sort();
    if (new Set(scope).size !== scope.length || canonical(scope) !== canonical(ledger.requirements.map((r) => r.id).sort())) return false;
    if (parsed.ledgerSha256 !== releaseSnapshotDigest(ledger) || canonical([...parsed.evidence].sort((a, b) => canonical(a).localeCompare(canonical(b)))) !== canonical(refs)) return false;
    // Same raw Ed25519 public key format as OPS-09, pinned outside the ledger/record.
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.publicKey, "base64url")]), format: "der", type: "spki" });
    return verify(null, signoffBody(parsed), publicKey, Buffer.from(parsed.signature.value, "base64url"));
  } catch { return false; }
}

export function validateReleaseStatus(ledger, options = {}) {
  const errors = [];
  const status = ledger.releaseStatus ?? {};
  const names = ["implementationComplete", "sandboxVerified", "pilotReady", "productionApproved"];
  for (const name of names) if (typeof status[name] !== "boolean") errors.push(`releaseStatus.${name} must be boolean`);
  if (!Array.isArray(ledger.requirements) || ledger.requirements.length === 0) return ["release requires a nonempty requirement inventory"];
  if (status.implementationComplete && ledger.requirements.some((r) => !/^(complete$|implementation_complete(?:_|$)|verified(?:_|$)|local_verified(?:_|$))/.test(r.implementationStatus))) errors.push("implementationComplete requires every implementation to be complete");
  for (let i = 1; i < names.length; i++) if (status[names[i]] && !status[names[i - 1]]) errors.push(`${names[i]} requires ${names[i - 1]}`);
  if (status.sandboxVerified || status.pilotReady || status.productionApproved) {
    const selection = selectReleaseEvidence(ledger, options, status.pilotReady || status.productionApproved);
    errors.push(...selection.errors);
    if (status.productionApproved) {
      const records = ledger.releaseSignoffs ?? [];
      const read = options.readEvidence ?? ((relative) => readRepositoryFile(options.root, relative));
      const valid = records.some((file) => {
        try { return verifySignoff(JSON.parse(read(file).toString("utf8")), ledger, selection.refs, options.keys ?? [], options.now); }
        catch { return false; }
      });
      if (!valid) errors.push("productionApproved requires an accountable signed sign-off, complete scope and externally pinned identity/key");
    }
  }
  return errors;
}
