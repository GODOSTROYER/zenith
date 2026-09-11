/**
 * Clean-host restore, with revocation reconciliation.
 *
 * The failure this file exists to prevent: restoring last night's snapshot
 * quietly re-admits everyone who was removed today. A backup is a photograph
 * of an access-control decision, and photographs go stale. So a restore is not
 * finished when the bytes are on disk — it is finished when every revocation
 * that postdates those bytes has either been re-applied or been declared
 * unprovable, and the grants it could not prove have been closed (G23).
 *
 * The order, and why each step is where it is:
 *
 *  1. **Refuse a non-empty directory. Always.** Not "unless --force": a
 *     restore into a live data directory is a second writer against a SQLite
 *     file that already has one, and the operator asking for it is usually
 *     asking for something else. An in-place restore over live data is an
 *     explicit, separate, operator-approved procedure (RUNBOOK-DEPLOY §6).
 *  2. **Open and verify before writing anything.** Unseal (which authenticates
 *     the whole container) and unpack (which re-hashes every file in it). A
 *     bundle that fails either check never reaches the disk.
 *  3. **Write, then reconcile, then close every session.** Sessions are
 *     terminated last and unconditionally — including on a perfectly
 *     reconciled restore — because a session in a restored snapshot was issued
 *     by a host that no longer exists.
 *  4. **Write the report.** `RESTORE-REPORT.json` in the restored directory,
 *     with the counts an operator has to check before reopening anything.
 *
 * **The restored authority is opened on its own connection**, not through
 * `openAuthority()`. The process-wide authority is a single held connection
 * (one per process, on `globalThis`), and swapping it for the restore target
 * would leave a running control service pointed at a directory it is not
 * serving. A private `DatabaseSync` over the restored file touches nothing
 * else and is closed before this function returns. It is also the one place
 * that is deliberately synchronous: `createRepos()` over a private
 * `DatabaseSync` is the repository set as the repository files write it, and
 * `transact()` is its synchronous transaction.
 *
 * TODO(ceiling): Postgres backup path — rebuilding the control authority from a
 * bundle is a SQLite file operation here. A Postgres authority restores from a
 * dump into a fresh database, and everything from `new DatabaseSync` down needs
 * a different mechanism.
 *
 * **The local revocation ledger is not rewritten.** Entries newer than the
 * snapshot are *applied* (the grant is revoked, its sessions end) and recorded
 * in the report, but they are not re-appended to the restored
 * `revocation_ledger`, because its `seq` is `AUTOINCREMENT` and inventing
 * numbers for entries that already have off-host ones is how two ledgers stop
 * agreeing. The consequence is deliberate and self-healing: the next backup
 * still records the old `revocationSeq`, so a future restore re-applies the
 * same entries — and re-revoking an already revoked grant does nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  HostedError,
  type BackupManifest,
  type BackupTarget,
  type GrantState,
  type RevocationLedgerEntry,
} from "@/lib/hosted/contracts";
import { createRepos, transact, type SyncRepos } from "@/lib/hosted/authority";
import { log } from "@/lib/log";
import { unpackBundle } from "./bundle";
import { unseal } from "./crypto";
import { REVOCATION_LEDGER_KEY, selectedBackupTarget } from "./targets";

/** The file a restore leaves behind for whoever has to decide about reopening. */
export const RESTORE_REPORT_FILE = "RESTORE-REPORT.json";

/** How a restore is asked for. */
export interface RestoreOptions {
  /** The sealed bundle itself, or the target key it is stored under. */
  bundle: Buffer | string;
  /** The data directory to restore into. Must not exist, or must be empty. */
  into: string;
  /** Where to read the bundle and the revocation ledger. Defaults to the configured target. */
  target?: BackupTarget;
  /** Override the timestamp. Tests only. */
  now?: Date;
}

/** What the reconciliation found and did. */
export interface ReconciliationReport {
  ledgerKey: string;
  /** False when the ledger could not be read at all. */
  ledgerAvailable: boolean;
  /** The highest sequence number the off-host ledger holds, or null when unread. */
  ledgerMaxSeq: number | null;
  /** The snapshot's own high-water mark: entries above it are what must be applied. */
  cutoffSeq: number;
  applied: { seq: number; at: string; appId: string; grantId: string; revoked: boolean; sessionsEnded: number }[];
  /** Ledger lines that could not be parsed. Counted, never guessed at. */
  unreadable: number;
  /**
   * True only when the ledger was read and reaches at least as far as the
   * snapshot. False means "we cannot prove nobody was removed", and every
   * grant is closed until a human says otherwise.
   */
  evidenceComplete: boolean;
  /** Grants moved to `needs_reapproval` because the evidence was incomplete. */
  needsReapproval: number;
  /** Apps moved to `recovering` for the same reason. */
  appsRecovering: number;
  detail: string;
}

/** Everything an operator has to look at before reopening an app. */
export interface RestoreReport {
  restoredAt: string;
  into: string;
  backup: Pick<BackupManifest, "id" | "createdAt" | "digest" | "byteSize" | "keyId" | "revocationSeq">;
  files: BackupManifest["files"];
  reconciliation: ReconciliationReport;
  /** Sessions ended by the restore itself, over and above those ended by a revocation. */
  sessionsTerminated: number;
  counts: {
    apps: number;
    appsByState: Record<string, number>;
    grantsByState: Record<GrantState, number>;
    invites: number;
    releases: number;
    recordsByApp: { appId: string; slug: string; records: number | null; detail: string }[];
    artifacts: { referenced: number; present: number; missing: string[] };
  };
  limitations: string[];
}

/**
 * Restore a bundle into a clean data directory and reconcile revocations.
 *
 * Returns the same report it writes to `RESTORE-REPORT.json`. Nothing is
 * reopened: every app the reconciliation could not vouch for is left
 * `recovering` and every grant on it `needs_reapproval`, which `reopenApp()`
 * is the deliberate second step for.
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreReport> {
  const into = path.resolve(options.into);
  assertEmpty(into);

  const selection = selectedBackupTarget();
  const target = options.target ?? selection.target;

  let sealed: Buffer;
  if (Buffer.isBuffer(options.bundle)) sealed = options.bundle;
  else {
    if (!target)
      throw new HostedError("policy_unavailable", `The bundle was given as the key "${options.bundle}" but no backup target is configured to read it from.`, {
        fix: selection.availability.fix,
      });
    const fetched = await target.get(options.bundle);
    if (!fetched)
      throw new HostedError("not_found", `The backup target holds no object at "${options.bundle}".`, {
        fix: "List the target's `backups/` prefix and restore one of the keys it names.",
      });
    sealed = fetched;
  }

  // Verify completely before a single byte is written: an unseal proves the
  // bundle is the one that was sealed, and an unpack re-hashes every file in it.
  const { plain } = unseal(sealed);
  const { manifest, files } = unpackBundle(plain);

  fs.mkdirSync(into, { recursive: true });
  for (const file of files) {
    const destination = path.join(into, ...file.name.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.bytes);
  }

  const controlPath = path.join(into, "control.sqlite");
  if (!fs.existsSync(controlPath))
    throw new HostedError("invalid_input", "That bundle carries no control.sqlite, so there is no authority to restore.", {
      fix: "Restore a bundle produced by createBackup(); a bundle without the control database cannot describe who may open anything.",
    });

  const restoredAt = (options.now ?? new Date()).toISOString();
  const db = new DatabaseSync(controlPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    const repos = createRepos(db);

    const reconciliation = await reconcile(db, repos, manifest, target, selection.availability.fix, restoredAt);

    // Every session, on every app, regardless of the reconciliation outcome:
    // a session in a snapshot was issued by a host that is now gone.
    const apps = repos.apps.listAll();
    let sessionsTerminated = 0;
    transact(db, () => {
      for (const app of apps) sessionsTerminated += repos.sessions.terminateByApp(app.id, "restored", restoredAt);
    });

    const report: RestoreReport = {
      restoredAt,
      into,
      backup: {
        id: manifest.id,
        createdAt: manifest.createdAt,
        digest: manifest.digest,
        byteSize: manifest.byteSize,
        keyId: manifest.keyId,
        revocationSeq: manifest.revocationSeq,
      },
      files: manifest.files,
      reconciliation,
      sessionsTerminated,
      counts: countEverything(repos, into),
      limitations: [
        `Data is as of ${manifest.createdAt}. Anything written after that is not in this restore and is not recoverable from it.`,
        reconciliation.evidenceComplete
          ? `Revocations up to ledger sequence ${reconciliation.ledgerMaxSeq} were reconciled. Access decisions made after the last ledger line are not represented.`
          : "The off-host revocation ledger could not be read far enough to prove nobody was removed after this snapshot, so every grant is closed pending re-approval.",
        "Artifact bytes are only present if the bundle was taken with includeArtifacts, or if the artifact store was restored separately. Missing digests are listed under counts.artifacts.missing.",
        "This restore has not been measured against an RPO or an RTO. Neither number has been established on any real host.",
      ],
    };

    fs.writeFileSync(path.join(into, RESTORE_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);

    // Recorded in the *restored* authority: this install is the one that was
    // restored, and the process running the script may be serving nothing.
    transact(db, () =>
      repos.events.append({
        id: randomUUID(),
        event: "restore.completed",
        workspaceId: "__install",
        outcome: reconciliation.evidenceComplete ? "ok" : "error",
        logicalId: `restore:${manifest.id}:${restoredAt}`,
        assisted: false,
        actorClass: "system",
        ts: restoredAt,
        props: {
          backupId: manifest.id,
          apps: report.counts.apps,
          evidenceComplete: reconciliation.evidenceComplete,
          revocationsApplied: reconciliation.applied.length,
          needsReapproval: reconciliation.needsReapproval,
          sessionsTerminated,
        },
      })
    );

    log.info("hosted restore completed", {
      scope: "hosted.restore",
      into,
      backupId: manifest.id,
      apps: report.counts.apps,
      evidenceComplete: reconciliation.evidenceComplete,
      revocationsApplied: reconciliation.applied.length,
      needsReapproval: reconciliation.needsReapproval,
    });
    return report;
  } finally {
    try {
      db.close();
    } catch {
      /* the files are written; a stuck handle is not worth masking the result */
    }
  }
}

/** A restore never writes into a directory that already holds something. */
function assertEmpty(into: string): void {
  if (!fs.existsSync(into)) return;
  const stat = fs.statSync(into);
  if (!stat.isDirectory())
    throw new HostedError("invalid_input", `${into} is a file, not a directory.`, {
      fix: "Point the restore at an empty directory, or at a path that does not exist yet.",
    });
  const entries = fs.readdirSync(into);
  if (entries.length === 0) return;
  throw new HostedError(
    "conflict",
    `${into} is not empty (${entries.length} ${entries.length === 1 ? "entry" : "entries"}), and a restore never writes over an existing data directory.`,
    {
      fix: "Restore into a new, empty directory. To replace a live install, stop the service, move the old directory aside, and restore into a fresh one — an in-place restore over live data is a separate, operator-approved procedure (docs/hosted/RUNBOOK-DEPLOY.md §6).",
      details: { into, entries: entries.slice(0, 10) },
    }
  );
}

/** Read the off-host ledger and apply — or refuse to vouch for — what it says. */
async function reconcile(
  db: DatabaseSync,
  repos: SyncRepos,
  manifest: BackupManifest,
  target: BackupTarget | null,
  targetFix: string | undefined,
  now: string
): Promise<ReconciliationReport> {
  const base: ReconciliationReport = {
    ledgerKey: REVOCATION_LEDGER_KEY,
    ledgerAvailable: false,
    ledgerMaxSeq: null,
    cutoffSeq: manifest.revocationSeq,
    applied: [],
    unreadable: 0,
    evidenceComplete: false,
    needsReapproval: 0,
    appsRecovering: 0,
    detail: "",
  };

  let raw: Buffer | null = null;
  let failure: string | undefined;
  if (!target) failure = `no backup target is configured to read ${REVOCATION_LEDGER_KEY} from${targetFix ? ` — ${targetFix}` : ""}`;
  else
    try {
      raw = await target.get(REVOCATION_LEDGER_KEY);
      if (raw === null) failure = `the target holds no ${REVOCATION_LEDGER_KEY}`;
    } catch (error) {
      failure = `reading ${REVOCATION_LEDGER_KEY} failed: ${error instanceof Error ? error.message : String(error)}`;
    }

  if (!raw) return closeEverything(db, repos, { ...base, detail: `Evidence missing: ${failure}.` }, now);

  base.ledgerAvailable = true;
  const entries: RevocationLedgerEntry[] = [];
  for (const line of raw.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = parseLedgerLine(trimmed);
    if (parsed) entries.push(parsed);
    else base.unreadable += 1;
  }
  base.ledgerMaxSeq = entries.reduce((top, entry) => Math.max(top, entry.seq), 0);

  if (base.ledgerMaxSeq < manifest.revocationSeq)
    return closeEverything(
      db,
      repos,
      {
        ...base,
        detail:
          `Evidence missing: the off-host ledger reaches sequence ${base.ledgerMaxSeq} and this snapshot already contains ${manifest.revocationSeq}. ` +
          "A ledger behind its own backup cannot say what happened after it.",
      },
      now
    );

  const newer = entries.filter((entry) => entry.seq > manifest.revocationSeq).sort((a, b) => a.seq - b.seq);
  transact(db, () => {
    for (const entry of newer) {
      const grant = repos.grants.revoke(entry.grantId, entry.by, entry.reason || "revoked before this restore", now);
      const sessionsEnded = repos.sessions.terminateByGrant(entry.grantId, "revoked", now);
      base.applied.push({
        seq: entry.seq,
        at: entry.at,
        appId: entry.appId,
        grantId: entry.grantId,
        // A grant the snapshot never held is not an error: it was created and
        // revoked entirely after the backup, and there is nothing to close.
        revoked: grant?.state === "revoked",
        sessionsEnded,
      });
    }
  });

  base.evidenceComplete = true;
  base.detail =
    newer.length === 0
      ? `The off-host ledger reaches sequence ${base.ledgerMaxSeq}, and nothing was revoked after this snapshot (sequence ${manifest.revocationSeq}).`
      : `Re-applied ${newer.length} ${newer.length === 1 ? "revocation" : "revocations"} recorded after this snapshot (sequences ${manifest.revocationSeq + 1}–${base.ledgerMaxSeq}).` +
        (base.unreadable > 0 ? ` ${base.unreadable} ledger line(s) could not be parsed and were counted, not guessed at.` : "");
  return base;
}

/**
 * The fail-closed path: no usable evidence, so nobody keeps access.
 *
 * Every active grant becomes `needs_reapproval` and every app becomes
 * `recovering`. Data, releases and artifacts are untouched — this closes the
 * door, it does not throw anything away.
 */
function closeEverything(
  db: DatabaseSync,
  repos: SyncRepos,
  report: ReconciliationReport,
  now: string
): ReconciliationReport {
  const apps = repos.apps.listAll();
  const ids = apps.map((app) => app.id);
  transact(db, () => {
    report.needsReapproval = repos.grants.markNeedsReapproval(ids, now);
    for (const app of apps) {
      repos.apps.update(
        app.id,
        {
          state: "recovering",
          stateReason:
            "Restored from a backup whose revocations could not be confirmed against the off-host ledger. Every grant is held for re-approval until an owner confirms it.",
        },
        now
      );
      report.appsRecovering += 1;
    }
  });
  report.detail +=
    ` ${report.needsReapproval} grant(s) were moved to needs_reapproval and ${report.appsRecovering} app(s) to recovering. ` +
    "No data, release or artifact was changed.";
  return report;
}

/** One ledger line, or null when it is not one this restore will act on. */
function parseLedgerLine(line: string): RevocationLedgerEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const seq = Number(row.seq);
  if (!Number.isFinite(seq) || seq <= 0) return null;
  for (const key of ["at", "appId", "grantId", "subject", "by"])
    if (typeof row[key] !== "string" || row[key] === "") return null;
  return {
    seq,
    at: row.at as string,
    appId: row.appId as string,
    grantId: row.grantId as string,
    subject: row.subject as string,
    by: row.by as string,
    reason: typeof row.reason === "string" ? row.reason : "",
  };
}

/** The counts an operator checks before deciding anything is safe to reopen. */
function countEverything(repos: SyncRepos, into: string): RestoreReport["counts"] {
  const apps = repos.apps.listAll();
  const appsByState: Record<string, number> = {};
  const grantsByState: Record<GrantState, number> = { active: 0, revoked: 0, needs_reapproval: 0 };
  let invites = 0;
  let releases = 0;
  const referenced = new Set<string>();
  const recordsByApp: RestoreReport["counts"]["recordsByApp"] = [];

  for (const app of apps) {
    appsByState[app.state] = (appsByState[app.state] ?? 0) + 1;
    for (const grant of repos.grants.listByApp(app.id)) grantsByState[grant.state] += 1;
    invites += repos.invites.listByApp(app.id).length;
    for (const release of repos.releases.listByApp(app.id, { limit: 1000 })) {
      releases += 1;
      referenced.add(release.artifactDigest);
    }
    recordsByApp.push(countRecords(app.id, app.slug, into));
  }

  const missing: string[] = [];
  let present = 0;
  for (const digest of referenced) {
    if (fs.existsSync(path.join(into, "artifacts", "sha256", digest))) present += 1;
    else missing.push(digest);
  }

  return {
    apps: apps.length,
    appsByState,
    grantsByState,
    invites,
    releases,
    recordsByApp,
    artifacts: { referenced: referenced.size, present, missing: missing.sort() },
  };
}

/** How many equipment requests a restored app holds, read straight off the file. */
function countRecords(appId: string, slug: string, into: string): {
  appId: string;
  slug: string;
  records: number | null;
  detail: string;
} {
  const file = path.join(into, "apps", appId, "data.sqlite");
  if (!fs.existsSync(file))
    return { appId, slug, records: null, detail: "No data database in this bundle — the app had never been opened." };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const check = db.prepare("PRAGMA quick_check").all();
    const ok = check.length === 1 && String(check[0]?.quick_check) === "ok";
    const row = db.prepare("SELECT COUNT(*) AS total FROM equipment_requests").get();
    const records = Number(row?.total ?? 0);
    return { appId, slug, records, detail: ok ? "quick_check ok" : `quick_check reported ${String(check[0]?.quick_check)}` };
  } catch (error) {
    return { appId, slug, records: null, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* count already taken */
    }
  }
}
