/**
 * One app on the Apps list: what it is called, where it lives, whether anything
 * is happening to it right now, and the two things a builder does from here —
 * open it, or copy its address for someone who was invited.
 *
 * Workstream W9 (hosted R3)
 */
import Link from "next/link";
import { ExternalLink, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusDot } from "@/components/ui/status-dot";
import { TimeAgo } from "@/components/ui/time-ago";
import type { HostedAppSummary } from "@/lib/client/hosted";
import { APP_STATE } from "./labels";
import { PUBLISH_PHASES } from "./phases";

export interface AppCardProps {
  app: HostedAppSummary;
  onOpen: () => void;
  opening?: boolean;
  /** why "Open app" cannot be pressed, beyond the reasons this card works out */
  openDisabledReason?: string;
}

const phaseLabel = (phase: string): string =>
  PUBLISH_PHASES.find((p) => p.id === phase)?.label ?? "Starting";

export function AppCard({ app, onOpen, opening = false, openDisabledReason }: AppCardProps) {
  const state = APP_STATE[app.state];
  const url = app.url;
  const job = app.runningJob ?? null;
  const release = app.activeRelease ?? null;

  const openReason =
    openDisabledReason ??
    (app.state === "suspended"
      ? `${app.name} is suspended, so nobody can open it. Resume it from the app's page first.`
      : app.state === "recovering"
        ? `${app.name} stays closed until an operator finishes the recovery check.`
        : !app.activeReleaseId
          ? `${app.name} has nothing published yet. Publish a version first and the address will start answering.`
          : undefined);

  return (
    <Card className="flex h-full flex-col">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h3 className="min-w-0 text-[16px] font-medium text-ink">
          <Link
            href={`/apps/${app.id}`}
            className="rounded-ctl break-words underline decoration-line-strong underline-offset-4 hover:text-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            {app.name}
          </Link>
        </h3>
        <Chip tone={state.tone} title={state.note}>
          {state.text}
        </Chip>
      </div>

      <div className="mt-3 min-w-0">
        <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Private URL</p>
        <div className="mt-1 flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={url}>
            {url}
          </span>
          <CopyButton value={url} what={`the address of ${app.name}`} />
        </div>
      </div>

      <dl className="mt-4 space-y-1.5 text-[12.5px] text-ink-mute">
        <div className="flex flex-wrap items-center gap-x-2">
          <dt className="sr-only">Live release</dt>
          <dd>
            {release ? (
              <>
                Release {release.number}
                {release.activatedAt ? (
                  <>
                    {" · live "}
                    <TimeAgo iso={release.activatedAt} />
                  </>
                ) : null}
              </>
            ) : app.activeReleaseId ? (
              "A release is live"
            ) : (
              "Nothing published yet"
            )}
          </dd>
        </div>

        {typeof app.grantCount === "number" || typeof app.inviteCount === "number" ? (
          <div className="flex flex-wrap items-center gap-x-2">
            <dt className="sr-only">Audience</dt>
            <dd className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {typeof app.grantCount === "number"
                ? `${app.grantCount} ${app.grantCount === 1 ? "person" : "people"} can open it`
                : null}
              {typeof app.grantCount === "number" && app.inviteCount ? " · " : null}
              {app.inviteCount ? `${app.inviteCount} invited` : null}
            </dd>
          </div>
        ) : null}

        {job ? (
          <div className="flex flex-wrap items-center gap-x-2">
            <dt className="sr-only">In progress</dt>
            <dd className="flex items-center gap-2 text-signal">
              <StatusDot status="running" />
              {job.kind === "publish" ? "Publishing" : job.kind === "rollback" ? "Rolling back" : "Working"}
              {" — "}
              {phaseLabel(job.phase)}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="primary"
          size="sm"
          busy={opening}
          disabled={Boolean(openReason)}
          disabledReason={openReason}
          onClick={onOpen}
          icon={<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          Open app
        </Button>
        <Link
          href={`/apps/${app.id}`}
          className="inline-flex h-8 items-center rounded-ctl border border-line bg-bg2 px-2.5 text-[12.5px] text-ink transition-colors hover:bg-bg3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          Manage
        </Link>
      </div>
    </Card>
  );
}
