"use client";
/**
 * Getting the app's contents out, and what happens after a restore.
 *
 * Reopening an app that came back from a backup is an operator action, not a
 * button — the whole point of the recovery state is that the platform will not
 * let a screen wave it through.
 *
 * Workstream W9 (hosted R3)
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { TimeAgo } from "@/components/ui/time-ago";
import { errorText, useSafeToasts } from "@/components/screens/shared";
import { exportHostedApp } from "@/lib/client/hosted";
import type { AppState } from "@/lib/hosted/contracts";

export interface ExportSectionProps {
  appId: string;
  appName: string;
  appSlug: string;
  state: AppState;
  stateReason?: string;
  /** the server does not report this yet; the panel says so rather than implying one */
  lastBackupAt?: string | null;
  /** why exporting is refused */
  exportDisabledReason?: string;
}

export function ExportSection({
  appId,
  appName,
  appSlug,
  state,
  stateReason,
  lastBackupAt,
  exportDisabledReason,
}: ExportSectionProps) {
  const toasts = useSafeToasts();
  const [busy, setBusy] = useState(false);

  const exportNow = async () => {
    setBusy(true);
    try {
      await exportHostedApp(appId, appSlug);
      toasts.push({ kind: "ok", title: `The export of ${appName} was saved to this computer.` });
    } catch (cause) {
      const { message, fix } = errorText(cause);
      toasts.push({ kind: "err", title: message, body: fix });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Export and recovery"
      subtitle="Take a copy of everything this app holds, and see where it stands after a restore."
    >
      <div className="space-y-5">
        <div>
          <p className="max-w-[70ch] text-[13px] text-ink">
            The export is one JSON file of what the server holds for {appName}. It is written
            straight to this computer — Zenith keeps no copy of the download.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              busy={busy}
              disabled={Boolean(exportDisabledReason)}
              disabledReason={exportDisabledReason}
              onClick={() => void exportNow()}
              icon={<Download className="h-4 w-4" aria-hidden="true" />}
            >
              Export JSON
            </Button>
            {exportDisabledReason ? (
              <span className="max-w-[60ch] text-[12.5px] text-ink-mute">
                {exportDisabledReason}
              </span>
            ) : null}
          </div>
        </div>

        <div className="border-t border-line pt-4">
          <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Last backup</p>
          <p className="mt-1 text-[13px] text-ink">
            {lastBackupAt ? (
              <TimeAgo iso={lastBackupAt} />
            ) : (
              <span className="text-ink-mute">
                Unknown — the server did not report a backup time for this app.
              </span>
            )}
          </p>
        </div>

        {state === "recovering" && (
          <Callout tone="warn" title="This app is closed while recovery is checked">
            <p>
              {stateReason ??
                "This app came back from a backup. Some of the people who had access could not be confirmed against the off-host record of revocations, so nobody is let in until that is settled."}
            </p>
            <p className="mt-1.5 text-ink-mute">
              Reopening it is an operator action taken on the server, not something this screen can
              do. Anyone marked “needs re-approval” in Audience stays locked out until then.
            </p>
          </Callout>
        )}
      </div>
    </Card>
  );
}
