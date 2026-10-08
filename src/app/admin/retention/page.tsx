import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { opsAdminIds } from "@/lib/ops/config";
import { platformConfigured } from "@/lib/ops/runtime";
import { CLASS_SPECS, RETENTION_CLASSES } from "@/lib/retention/classes";
import { retentionOverview, type RetentionOverview } from "@/lib/retention/overview";
import { AdminEntry } from "../admin-entry";
import { HoldsPanel } from "./holds-panel";
import styles from "./retention.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Data retention · Zenith", robots: { index: false, follow: false } };

const n = (v: number): string => v.toLocaleString("en-US");

async function load(): Promise<RetentionOverview | undefined> {
  if (!platformConfigured()) return undefined;
  try {
    const { platformDb } = await import("@/lib/controlplane/db");
    return await retentionOverview(await platformDb());
  } catch { return undefined; }
}

export default async function RetentionPage() {
  const user = await getSessionUser();
  if (!user) return <AdminEntry />;
  if (!opsAdminIds().has(user.id)) return <AdminEntry accessDenied />;
  const overview = await load();

  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <Link href="/admin" className={styles.back}>Back to administration</Link>
        <header className={styles.heading}>
          <h1>Data retention</h1>
          <p>
            What would be archived and pruned under the retention policy, without changing anything. Active operations, approvals, audit,
            receipts, the effect ledger and replay-prevention records are never removed, whatever the policy says.
          </p>
        </header>

        {!overview ? (
          <p className={styles.empty}>The platform control store is not reachable, so retention cannot be shown. Check the platform database configuration and try again.</p>
        ) : (
          <>
            <section className={styles.status} aria-label="Retention status">
              <div className={styles.card}>
                <h2>Policy</h2>
                <strong className={overview.policy.valid ? (overview.policy.retainsEverything ? styles.ok : undefined) : styles.warn}>
                  {!overview.policy.valid ? "Invalid, keeping everything" : overview.policy.retainsEverything ? "Keeping everything forever" : "Windows configured"}
                </strong>
                <p>
                  {overview.policy.source === "default" ? "No policy is configured, so the default applies." : `Loaded from ${overview.policy.source === "file" ? "a policy file" : "inline configuration"}.`}
                  {overview.policy.problems.length ? ` ${overview.policy.problems.slice(0, 3).join(" ")}` : ""}
                </p>
              </div>
              <div className={styles.card}>
                <h2>Deletion</h2>
                <strong className={overview.gate.enabled ? styles.warn : styles.ok}>{overview.gate.enabled ? "Enabled" : "Off (dry run)"}</strong>
                <p>{overview.gate.reason}</p>
              </div>
              <div className={styles.card}>
                <h2>Archive storage</h2>
                <strong className={overview.archiveStorage.configured ? styles.ok : styles.warn}>{overview.archiveStorage.configured ? "Configured" : "Not configured"}</strong>
                <p>{overview.archiveStorage.detail}{overview.archiveStorage.sealingKeyConfigured ? "" : " The sealing key (ZENITH_BACKUP_KEY) is not set, so archives cannot be written."}</p>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="preview-heading">
              <h2 id="preview-heading">Dry-run preview</h2>
              <p>
                Counts per data class under the policy in force. Rows are archived to storage first and pruned only after a verified copy exists.
                The latest observation or report of each resource, rows of unsettled jobs and rows under a hold are always kept.
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Data class</th>
                      <th scope="col">Rows now</th>
                      <th scope="col">Would archive</th>
                      <th scope="col">Already archived</th>
                      <th scope="col">Would prune</th>
                      <th scope="col">Prune waits for archive</th>
                      <th scope="col">Kept (latest)</th>
                      <th scope="col">Held</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.preview.classes.map((c) => (
                      <tr key={c.class}>
                        <td><span className={styles.className}>{c.label}</span><span className={styles.hint}>{c.description}</span></td>
                        <td>{n(c.totals.totalRows)}</td>
                        <td>{n(c.totals.archiveEligible)}</td>
                        <td>{n(c.archivedRows)}</td>
                        <td>{n(c.totals.pruneEligible)}</td>
                        <td>{n(c.totals.pruneWaitingForArchive)}</td>
                        <td>{n(c.totals.keptAsLatest)}</td>
                        <td>{n(c.totals.heldRows)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {overview.preview.classes.some((c) => c.samplePrune.length > 0) ? (
                <ul className={styles.list} aria-label="Sample of rows that would be pruned">
                  {overview.preview.classes.flatMap((c) => c.samplePrune.slice(0, 3).map((s) => (
                    <li key={`${c.class}:${s.workspaceId}:${s.rowId}`}><span>{c.label}, row {s.rowId}</span><span className={styles.meta}>workspace {s.workspaceId}, recorded {s.recordedAt}</span></li>
                  )))}
                </ul>
              ) : null}
            </section>

            <section className={styles.section} aria-labelledby="holds-heading">
              <h2 id="holds-heading">Legal holds</h2>
              <p>A hold blocks archive-then-delete and pruning for a workspace, narrowed by data class, resource or time range. Releasing a hold never deletes anything.</p>
              <HoldsPanel
                classes={RETENTION_CLASSES.map((value) => ({ value, label: CLASS_SPECS[value].label }))}
                holds={overview.holds.map((h) => ({
                  id: h.id, workspaceId: h.workspaceId, dataClass: h.dataClass, classLabel: h.dataClass ? CLASS_SPECS[h.dataClass].label : "All data classes",
                  resourceRef: h.resourceRef, timeFrom: h.timeFrom, timeTo: h.timeTo, reason: h.reason, createdBy: h.createdBy, createdAt: h.createdAt,
                }))}
              />
            </section>

            <section className={styles.section} aria-labelledby="archives-heading">
              <h2 id="archives-heading">Recent archives</h2>
              <p>Verify an archive or restore records from it (to a staging schema, or back to the source without overwriting anything) with the archives API or <code>scripts/retention-archive.ts</code>. Every restore is read back and audited.</p>
              <p>Archives sealed before key purpose separation require an explicit operator restore naming the original <code>enc:backup</code> purpose, the archive&apos;s recorded key fingerprint and an audit reason. The restore never guesses keys.</p>
              {overview.archives.length === 0 ? (
                <p className={styles.empty}>Nothing has been archived. Archiving starts only when a policy sets an archive window and archive storage is configured.</p>
              ) : (
                <ul className={styles.list}>
                  {overview.archives.map((a) => (
                    <li key={a.id}>
                      <span>{CLASS_SPECS[a.dataClass].label}: {n(a.rowCount)} rows, {n(a.prunedRows)} pruned{a.completedAt ? " (done)" : ""}</span>
                      <span className={styles.meta}>workspace {a.workspaceId}, verified {a.verifiedAt.slice(0, 16).replace("T", " ")} UTC, stored in {a.destinationLabel}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.section} aria-labelledby="protected-heading">
              <h2 id="protected-heading">Never removed</h2>
              <p>These tables are outside retention. No policy, flag or hold release can archive-delete or prune them.</p>
              <ul className={styles.protected}>
                {overview.preview.neverPrunable.map((p) => <li key={p.table}><code>{p.table}</code>: {p.reason}</li>)}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
