"use client";
/**
 * Publish: choose a source, press one button, watch the server do it.
 *
 * The job id is generated once per intent and kept here, so Retry replays the
 * same publish rather than starting a second one, and a reload that lands on a
 * job already running picks it back up instead of offering to start another.
 *
 * Workstream W9 (hosted R3)
 */
import { useCallback, useState } from "react";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorNote, useSafeToasts } from "@/components/screens/shared";
import {
  newJobId,
  publishHostedApp,
  readTarballBase64,
  type PublishSource,
} from "@/lib/client/hosted";
import type { Release } from "@/lib/hosted/contracts";
import { JobProgress } from "./job-progress";
import { SourcePicker, archiveProblem, type SourceChoice } from "./source-picker";

export interface PublishPanelProps {
  appId: string;
  appName: string;
  url: string;
  activeRelease: Release | null;
  /** why publishing is refused right now — role, runtime, builder, app state */
  blockedReason?: string;
  /** a publish this app already has in flight, from the app payload */
  runningJobId?: string | null;
  onChanged: () => void;
  onOpen: () => void;
  opening?: boolean;
}

export function PublishPanel({
  appId,
  appName,
  url,
  activeRelease,
  blockedReason,
  runningJobId,
  onChanged,
  onOpen,
  opening = false,
}: PublishPanelProps) {
  const toasts = useSafeToasts();
  const [source, setSource] = useState<SourceChoice | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const shownJobId = jobId ?? runningJobId ?? null;
  const fileProblem = source?.kind === "tarball" ? archiveProblem(source.file) : undefined;

  const start = useCallback(
    async (id: string) => {
      if (!source) return;
      setBusy(true);
      setError(undefined);
      try {
        const body: PublishSource =
          source.kind === "fixture"
            ? { kind: "fixture", name: source.name }
            : { kind: "tarball", base64: await readTarballBase64(source.file) };
        await publishHostedApp(appId, { jobId: id, source: body });
        setJobId(id);
        toasts.push({
          kind: "ok",
          title: `Publishing ${appName}.`,
          body: "The phases below come from the server as it works.",
        });
        onChanged();
      } catch (cause) {
        setError(cause);
        // The job id stays: a failed request may still have created the job,
        // and replaying the same id is how that is resolved safely.
        setJobId(id);
      } finally {
        setBusy(false);
      }
    },
    [appId, appName, onChanged, source, toasts]
  );

  const publishReason =
    blockedReason ??
    fileProblem ??
    (!source ? "Choose what to publish first." : undefined);

  if (shownJobId)
    return (
      <div className="space-y-4">
        {error ? <ErrorNote error={error} /> : null}
        <JobProgress
          appId={appId}
          jobId={shownJobId}
          appName={appName}
          url={url}
          activeRelease={activeRelease}
          onSettled={onChanged}
          onRetry={() => void start(shownJobId)}
          onPublishAgain={() => {
            setJobId(null);
            setError(undefined);
          }}
          retrying={busy}
          onOpen={onOpen}
          opening={opening}
        />
      </div>
    );

  return (
    <Card
      title="Publish a version"
      subtitle="Zenith builds what you send and puts it behind the same private URL. The version that is live now keeps serving until the new one passes its health checks."
    >
      <div className="space-y-5">
        <SourcePicker value={source} onChange={setSource} disabled={Boolean(blockedReason)} />

        {error ? <ErrorNote error={error} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            busy={busy}
            disabled={Boolean(publishReason)}
            disabledReason={publishReason}
            onClick={() => void start(newJobId())}
            icon={<UploadCloud className="h-4 w-4" aria-hidden="true" />}
          >
            Publish
          </Button>
          {publishReason && !busy ? (
            <span className="max-w-[60ch] text-[12.5px] text-ink-mute">{publishReason}</span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
