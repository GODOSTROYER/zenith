"use client";
/**
 * The top of an app's page: where it lives, whether it is answering, what is
 * live on it, and who is allowed to change that.
 *
 * Publishing needs two different things — the editor role in the workspace and
 * the owner role on this app — so both are shown as their own chip. One chip
 * saying "you can't" would leave a builder guessing which of the two to ask for.
 */
import { useState } from "react";
import { ExternalLink, PauseCircle, PlayCircle } from "lucide-react";
import type { Role } from "@/lib/actions/core";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { TimeAgo } from "@/components/ui/time-ago";
import { RoleChip, errorText, roleShortfall, useSafeToasts } from "@/components/screens/shared";
import { APP_STATE } from "../labels";
import { newJobId, resumeHostedApp, suspendHostedApp } from "@/lib/client/hosted";
import type { HostedAppSummary } from "@/lib/client/hosted";
import type { Release } from "@/lib/hosted/contracts";

export interface OverviewSectionProps {
  app: HostedAppSummary;
  activeRelease: Release | null;
  workspaceRole: Role | null;
  workspaceName: string;
  isOwner: boolean;
  onOpen: () => void;
  opening: boolean;
  onChanged: () => void;
  /** why suspending or resuming is refused right now */
  stateChangeReason?: string;
}

export function OverviewSection({
  app,
  activeRelease,
  workspaceRole,
  workspaceName,
  isOwner,
  onOpen,
  opening,
  onChanged,
  stateChangeReason,
}: OverviewSectionProps) {
  const toasts = useSafeToasts();
  const [confirming, setConfirming] = useState<"suspend" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);

  const state = APP_STATE[app.state];
  const shortfall = roleShortfall("editor", workspaceRole);
  const suspended = app.state === "suspended";
  const url = app.url;

  const openReason = suspended
    ? `${app.name} is suspended, so nobody can open it.`
    : app.state === "recovering"
      ? `${app.name} stays closed until an operator finishes the recovery check.`
      : !app.activeReleaseId
        ? "Nothing is published yet. Publish a version and this address starts answering."
        : undefined;

  const changeState = async () => {
    if (!confirming) return;
    setBusy(true);
    try {
      const jobId = newJobId();
      if (confirming === "suspend") await suspendHostedApp(app.id, { jobId });
      else await resumeHostedApp(app.id, { jobId });
      toasts.push({
        kind: "ok",
        title:
          confirming === "suspend"
            ? `${app.name} is being suspended.`
            : `${app.name} is being reopened.`,
      });
      setConfirming(null);
      onChanged();
    } catch (cause) {
      const { message, fix } = errorText(cause);
      toasts.push({ kind: "err", title: message, body: fix });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Overview"
      subtitle="The address people use, and what is answering on it."
      actions={<Chip tone={state.tone}>{state.text}</Chip>}
    >
      <div className="space-y-5">
        <div>
          <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Private URL</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] break-all text-ink">{url}</span>
            <CopyButton value={url} what={`the address of ${app.name}`} />
          </div>
          <p className="mt-1.5 max-w-[70ch] text-[12.5px] text-ink-mute">
            {state.note} People you invite sign in on this address; they never see this screen.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            busy={opening}
            disabled={Boolean(openReason)}
            disabledReason={openReason}
            onClick={onOpen}
            icon={<ExternalLink className="h-4 w-4" aria-hidden="true" />}
          >
            Open app
          </Button>
          <Button
            variant="quiet"
            disabled={Boolean(stateChangeReason)}
            disabledReason={stateChangeReason}
            onClick={() => setConfirming(suspended ? "resume" : "suspend")}
            icon={
              suspended ? (
                <PlayCircle className="h-4 w-4" aria-hidden="true" />
              ) : (
                <PauseCircle className="h-4 w-4" aria-hidden="true" />
              )
            }
          >
            {suspended ? "Resume" : "Suspend"}
          </Button>
        </div>

        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Live now</dt>
            <dd className="mt-1 text-[13px] text-ink">
              {activeRelease ? (
                <>
                  Release {activeRelease.number}
                  {activeRelease.activatedAt ? (
                    <span className="text-ink-mute">
                      {" · "}
                      <TimeAgo iso={activeRelease.activatedAt} />
                    </span>
                  ) : null}
                </>
              ) : (
                "Nothing published yet"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
              Who can publish
            </dt>
            <dd className="mt-1.5 flex flex-wrap items-center gap-2">
              <RoleChip required="editor" shortfall={shortfall} />
              <Chip
                tone={isOwner ? "neutral" : "err"}
                title={
                  isOwner
                    ? "You are an owner of this app."
                    : `Publishing needs the owner role on ${app.name}. Ask an owner to publish, or to make you an owner in Audience.`
                }
              >
                needs app owner
              </Chip>
            </dd>
            <dd className="mt-1.5 max-w-[46ch] text-[12.5px] text-ink-mute">
              Publishing needs both: the editor role in {workspaceName} and the owner role on this
              app.
            </dd>
          </div>
        </dl>

        {app.stateReason && app.state !== "active" && (
          <Callout tone="warn" compact>
            <p>{app.stateReason}</p>
          </Callout>
        )}
      </div>

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming === "resume" ? `Reopen ${app.name}?` : `Suspend ${app.name}?`}
        tone={confirming === "suspend" ? "danger" : "default"}
        width={480}
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={confirming === "suspend" ? "danger" : "primary"}
              busy={busy}
              onClick={() => void changeState()}
            >
              {confirming === "resume" ? "Reopen" : "Suspend"}
            </Button>
          </>
        }
      >
        {confirming === "suspend" ? (
          <ul className="space-y-2 text-[13px] text-ink">
            <li>Nobody can open {app.name} until you resume it. Open pages stop working.</li>
            <li className="text-ink-mute">
              Its data, its releases and everyone&apos;s access are kept exactly as they are.
            </li>
          </ul>
        ) : (
          <p className="text-[13px] text-ink">
            Everyone who had access can open {app.name} again, on the same address, with the same
            data.
          </p>
        )}
      </Dialog>
    </Card>
  );
}
