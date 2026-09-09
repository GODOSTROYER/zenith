/**
 * Taking a backup: a consistent snapshot of the control authority and of every
 * app's data, sealed, checksummed and written to the configured target.
 *
 * **WAL-safe, online, under load.** Both the control database and each app
 * database are copied with SQLite's own online backup API through a *dedicated
 * read-only connection*, never with a file copy and never through the live
 * connection. W1 found (and documented on `backupAuthority`) that `node:sqlite`
 * fails the copy with a contradictory "not an error" whenever the source
 * connection commits mid-flight; a second connection has no such problem and
 * produces a verified, internally consistent prefix of what was committed.
 * That is why `snapshotSqlite` below opens its own handle for every app.
 *
 * **What is in the bundle**, and what is deliberately not:
 *
 *  - `control.sqlite` — apps, grants, invitations, sessions, jobs, releases,
 *    quotas, usage, the revocation ledger and the events. Everything that
 *    decides who may open what.
 *  - `apps/<appId>/data.sqlite` — each app's customer records. The disposable
 *    `test.sqlite` a candidate probes against is not backed up: it is thrown
 *    away and rebuilt by design.
 *  - `artifacts.json` — the digest, size and full provenance of every
 *    artifact, but **not the artifact bytes**. Artifacts are content-addressed
 *    and immutable: the same source and the same pinned recipe rebuild the
 *    same digest, and the store can be re-uploaded independently. Carrying
 *    them in every backup would multiply its size by the whole build history
 *    for bytes that are already reproducible. Pass `{ includeArtifacts: true }`
 *    when the artifact store itself is the thing at risk — and know that
 *    reproducibility depends on the *source* still existing, which the bundle
 *    does not hold either.
 *
 * **`revocationSeq`** is the highest revocation sequence number the snapshot
 * contains. It is the number a restore compares against the off-host ledger to
 * learn which revocations postdate the file it just wrote (G23).
 *
 * ponytail: the whole bundle is assembled in memory before it is sealed, so
 * peak memory is roughly the size of the databases. That is right for a pilot
 * measured in megabytes and wrong for an install measured in gigabytes; a
 * streaming container is the upgrade, and it needs a streaming AEAD rather
 * than one `createCipheriv` pass.
 *
 * Workstream W8 (hosted R3).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { HostedError, type Artifact, type BackupManifest, type BackupTarget } from "@/lib/hosted/contracts";
import { authority, backupAuthority } from "@/lib/hosted/authority";
import { appDataPath } from "@/lib/hosted/data";
import { hostedConfig } from "@/lib/hosted/config";
import { removeQuietly } from "@/lib/hosted/fs";
import { INSTALL_WORKSPACE, recordEvent } from "@/lib/hosted/events";
import { log } from "@/lib/log";
import { packBundle, sha256, type BundleFile } from "./bundle";
import { seal } from "./crypto";
import { backupKeyFor, requireBackupTarget } from "./targets";

/** How a backup is taken. */
export interface CreateBackupOptions {
  /** Copy the artifact store's bytes into the bundle as well. Off by default. */
  includeArtifacts?: boolean;
  /** Write to this target instead of the configured one. Tests and drills. */
  target?: BackupTarget;
  /** Override the manifest id. Tests only; production takes a UUID. */
  id?: string;
  /** Override the timestamp. Tests only. */
  now?: Date;
}

/** What `artifacts.json` holds inside the bundle. */
export interface ArtifactInventory {
  /** True when the bundle also carries the artifact bytes. */
  includesBytes: boolean;
  note: string;
  artifacts: Artifact[];
}

/**
 * Take a backup and record it.
 *
 * Returns the manifest that was written to `backup_manifests`, whose `digest`
 * is the SHA-256 of the *sealed* bytes as stored — so a target-side integrity
 * check needs nothing but the object and this row.
 */
export async function createBackup(options: CreateBackupOptions = {}): Promise<BackupManifest> {
  const target = options.target ?? requireBackupTarget();
  const availability = await target.availability();
  if (!availability.available)
    throw new HostedError("policy_unavailable", `The backup target is not usable: ${availability.reason}`, {
      fix: availability.fix,
    });

  const id = options.id ?? randomUUID();
  const createdAt = (options.now ?? new Date()).toISOString();
  const a = authority();
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-backup-"));

  try {
    const files: BundleFile[] = [];

    // The control authority first: it names the apps whose data follows, and
    // a snapshot taken after them could reference an app whose data is missing.
    const controlCopy = path.join(scratch, "control.sqlite");
    await backupAuthority(controlCopy);
    files.push({ name: "control.sqlite", bytes: fs.readFileSync(controlCopy) });

    const apps = a.repos.apps.listAll();
    const skipped: string[] = [];
    for (const app of apps) {
      const source = appDataPath(app.id);
      if (!fs.existsSync(source)) {
        // An app that has never been opened has no data file yet. Recording
        // that is more useful than an empty database pretending to be one.
        skipped.push(app.id);
        continue;
      }
      const copy = path.join(scratch, "apps", app.id, "data.sqlite");
      await snapshotSqlite(source, copy);
      files.push({ name: `apps/${app.id}/data.sqlite`, bytes: fs.readFileSync(copy) });
    }

    const inventory: ArtifactInventory = {
      includesBytes: options.includeArtifacts === true,
      note: options.includeArtifacts
        ? "The artifact bytes are in this bundle under artifacts/sha256/<digest>/."
        : "Artifact bytes are NOT in this bundle. Artifacts are content-addressed and immutable: re-upload the store, or rebuild from the same source with the same pinned recipe to reproduce the same digest. The bundle does not hold the source.",
      artifacts: a.repos.artifacts.list({ limit: 10_000 }),
    };
    files.push({ name: "artifacts.json", bytes: Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, "utf8") });

    if (options.includeArtifacts) files.push(...artifactFiles(inventory.artifacts));

    const packed = packBundle(
      { id, createdAt, revocationSeq: a.repos.revocations.maxSeq(), keyId: "" },
      files
    );
    const sealed = seal(packed.bytes);
    // The key id is known only once the key has been read, so the manifest the
    // bundle carries has an empty one and the *recorded* manifest — the one a
    // restore is judged against — carries the real value.
    const manifest: BackupManifest = {
      id,
      createdAt,
      digest: sha256(sealed.bytes),
      byteSize: sealed.bytes.length,
      files: packed.files,
      revocationSeq: a.repos.revocations.maxSeq(),
      keyId: sealed.keyId,
    };

    await target.put(backupKeyFor(id), sealed.bytes);
    a.tx(() => a.repos.backups.insert(manifest));
    recordEvent({
      event: "backup.completed",
      workspaceId: INSTALL_WORKSPACE,
      logicalId: `backup:${id}`,
      props: {
        files: manifest.files.length,
        bytes: manifest.byteSize,
        apps: apps.length - skipped.length,
        revocationSeq: manifest.revocationSeq,
        includesArtifacts: options.includeArtifacts === true,
      },
    });
    log.info("hosted backup written", {
      scope: "hosted.backup",
      id,
      target: target.label,
      key: backupKeyFor(id),
      bytes: manifest.byteSize,
      files: manifest.files.length,
      appsWithoutData: skipped.length,
      revocationSeq: manifest.revocationSeq,
    });
    return manifest;
  } finally {
    removeQuietly(scratch);
  }
}

/** The artifact store's own files, named exactly as the store lays them out. */
function artifactFiles(artifacts: Artifact[]): BundleFile[] {
  const root = path.join(hostedConfig().artifactDir, "sha256");
  const out: BundleFile[] = [];
  for (const artifact of artifacts) {
    const dir = path.join(root, artifact.digest);
    if (!fs.existsSync(dir)) continue;
    const walk = (absolute: string, relative: string): void => {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        const full = path.join(absolute, entry.name);
        if (entry.isDirectory()) walk(full, child);
        else if (entry.isFile())
          out.push({ name: `artifacts/sha256/${artifact.digest}/${child}`, bytes: fs.readFileSync(full) });
      }
    };
    walk(dir, "");
  }
  return out;
}

/**
 * Copy one SQLite file with the online backup API and read the copy back.
 *
 * The dedicated read-only connection is the whole point — see the header. The
 * copy is `quick_check`ed before this resolves, because a backup that has not
 * been read back is a hope rather than a backup, and anything that fails is
 * deleted rather than left where a restore might find it.
 */
export async function snapshotSqlite(source: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    let reader: DatabaseSync | undefined;
    try {
      reader = new DatabaseSync(source, { readOnly: true });
      reader.exec("PRAGMA busy_timeout = 5000;");
      await sqliteBackup(reader, dest);
    } finally {
      try {
        reader?.close();
      } catch {
        /* the copy is what matters now */
      }
    }
    let copy: DatabaseSync | undefined;
    try {
      copy = new DatabaseSync(dest, { readOnly: true });
      const rows = copy.prepare("PRAGMA quick_check").all();
      const ok = rows.length === 1 && String(rows[0]?.quick_check) === "ok";
      if (!ok)
        throw new Error(
          `PRAGMA quick_check on the copy reported: ${rows.map((row) => String(row.quick_check)).join("; ") || "no result"}`
        );
    } finally {
      try {
        copy?.close();
      } catch {
        /* verification result already decided */
      }
    }
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dest}${suffix}`, { force: true });
    throw new HostedError(
      "internal",
      `The snapshot of ${source} did not complete and verify, so the partial copy was deleted rather than kept as a backup that cannot be restored.`,
      {
        fix: "Check free space and write permissions on the temporary directory, then take the backup again. The source database was not modified.",
        details: { detail: error instanceof Error ? error.message : String(error) },
      }
    );
  }
}

