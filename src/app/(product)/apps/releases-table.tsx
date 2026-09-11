"use client";
/**
 * Every version this app has had, and the one way back: roll the code back to
 * a release that already passed its checks.
 *
 * Rolling back is not restoring. The confirmation says so in those words,
 * because they are the two things a builder must not confuse under pressure.
 */
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Table } from "@/components/ui/table";
import { TimeAgo } from "@/components/ui/time-ago";
import { errorText, useSafeToasts } from "@/components/screens/shared";
import { newJobId, rollbackHostedApp } from "@/lib/client/hosted";
import type { Release } from "@/lib/hosted/contracts";
import { RELEASE_STATUS } from "./labels";

export interface ReleasesTableProps {
  appId: string;
  appName: string;
  releases: Release[];
  activeReleaseId: string | null;
  /** why rolling back is refused for everything — role, app state, a running job */
  rollbackDisabledReason?: string;
  onChanged: () => void;
}

/** `4 of 4 checks passed`, or the first thing that failed. */
function probeSummary(release: Release): string {
  if (!release.probe) return "Not checked";
  const total = release.probe.checks.length;
  const passed = release.probe.checks.filter((c) => c.ok).length;
  return release.probe.ok
    ? `${passed} of ${total} checks passed`
    : `${total - passed} of ${total} checks failed`;
}

export function ReleasesTable({
  appId,
  appName,
  releases,
  activeReleaseId,
  rollbackDisabledReason,
  onChanged,
}: ReleasesTableProps) {
  const toasts = useSafeToasts();
  const [target, setTarget] = useState<{ release: Release; jobId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const rollback = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await rollbackHostedApp(appId, { jobId: target.jobId, releaseId: target.release.id });
      toasts.push({
        kind: "ok",
        title: `Rolling ${appName} back to release ${target.release.number}.`,
        body: "The data stays as it is; only the code changes.",
      });
      setTarget(null);
      onChanged();
    } catch (cause) {
      const { message, fix } = errorText(cause);
      toasts.push({ kind: "err", title: message, body: fix });
    } finally {
      setBusy(false);
    }
  };

  const reasonFor = (release: Release): string | undefined => {
    if (rollbackDisabledReason) return rollbackDisabledReason;
    if (release.id === activeReleaseId) return `Release ${release.number} is already live.`;
    if (release.status === "failed")
      return `Release ${release.number} never passed its health checks, so it cannot be made live.`;
    if (release.status === "candidate")
      return `Release ${release.number} was never verified, so it cannot be made live.`;
    return undefined;
  };

  return (
    <>
      <Table<Release>
        caption={`${releases.length} release${releases.length === 1 ? "" : "s"} of ${appName}, newest first`}
        rows={releases}
        rowKey={(r) => r.id}
        rowClassName={(r) => (r.id === activeReleaseId ? "bg-signal-dim" : undefined)}
        empty={
          <Table.Empty>
            <p>Nothing has been published yet. The first publish creates release 1.</p>
          </Table.Empty>
        }
        columns={[
          {
            key: "number",
            header: "Release",
            width: 88,
            render: (r) => <span className="tnum font-mono text-[13px] text-ink">{r.number}</span>,
          },
          {
            key: "status",
            header: "Status",
            width: 120,
            render: (r) => (
              <Chip tone={RELEASE_STATUS[r.status].tone}>{RELEASE_STATUS[r.status].text}</Chip>
            ),
          },
          {
            key: "created",
            header: "Built",
            width: 130,
            render: (r) => <TimeAgo iso={r.createdAt} className="text-[12.5px] text-ink-mute" />,
          },
          {
            key: "digest",
            header: "Build fingerprint",
            width: 150,
            render: (r) => (
              <span
                className="font-mono text-[12px] text-ink-mute"
                title={`Content hash of the built files: ${r.artifactDigest}`}
              >
                {r.artifactDigest.slice(0, 12)}
              </span>
            ),
          },
          {
            key: "probe",
            header: "Health checks",
            render: (r) => (
              <div className="min-w-[180px]">
                <p className="text-[12.5px] text-ink-mute">{probeSummary(r)}</p>
                {r.probe && !r.probe.ok && (
                  <ul className="mt-1 space-y-0.5 text-[12px] text-err">
                    {r.probe.checks
                      .filter((c) => !c.ok)
                      .map((c) => (
                        <li key={c.id}>{c.detail}</li>
                      ))}
                  </ul>
                )}
                {r.status === "failed" && r.error && (
                  <p className="mt-1 text-[12px] text-err">{r.error}</p>
                )}
              </div>
            ),
          },
          {
            key: "act",
            header: "",
            headerLabel: "Roll back to this release",
            align: "right",
            width: 120,
            render: (r) => {
              const reason = reasonFor(r);
              return (
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={Boolean(reason)}
                  disabledReason={reason}
                  onClick={() => setTarget({ release: r, jobId: newJobId() })}
                  icon={<Undo2 className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                  Roll back
                </Button>
              );
            },
          },
        ]}
      />

      <Dialog
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target ? `Roll back to release ${target.release.number}?` : "Roll back"}
        description={`${appName} will serve the code from that release again.`}
        width={520}
        footer={
          <>
            <Button variant="quiet" onClick={() => setTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void rollback()}>
              Roll back
            </Button>
          </>
        }
      >
        <ul className="space-y-2 text-[13px] text-ink">
          <li>
            <strong className="font-medium">Kept:</strong> everything the app has stored — records,
            who can open it, and the addresses people already have.
          </li>
          <li>
            <strong className="font-medium">Changed:</strong> the code behind the private URL goes
            back to release {target?.release.number}. The release that is live now becomes an older
            version you can return to.
          </li>
          <li className="text-ink-mute">
            This is not a restore. Nothing is read from a backup, and no data is rewound.
          </li>
        </ul>
      </Dialog>
    </>
  );
}
