"use client";
/**
 * One app, on one screen: where it lives, how to publish to it, what has been
 * published, who may open it, what it has used, whether it is healthy, and how
 * to get its contents out.
 *
 * Every refusal on this screen names both halves of the rule it enforces —
 * publishing needs the editor role in the workspace *and* the owner role on the
 * app — so nobody has to press a button to find out which one they are missing.
 *
 * Workstream W9 (hosted R3)
 */
import { use, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote, errorText, useSafeToasts } from "@/components/screens/shared";
import { PageHeading } from "@/components/screens/page-heading";
import { SectionNavigation } from "@/components/screens/section-navigation";
import { useShell } from "@/components/shell/shell-context";
import { AudiencePanel } from "@/components/apps/audience-panel";
import { HealthPanel } from "@/components/apps/health-panel";
import { PublishPanel } from "@/components/apps/publish-panel";
import { ReleasesTable } from "@/components/apps/releases-table";
import { RuntimeBanner } from "@/components/apps/runtime-banner";
import {
  publishBlockedReason,
  rollbackBlockedReason,
  stateChangeBlockedReason,
} from "@/components/apps/gating";
import {
  launchHostedApp,
  useHostedApp,
  useHostedApps,
  useHostedHealth,
  useSpending,
} from "@/lib/client/hosted";
import { ExportSection } from "./export-section";
import { OverviewSection } from "./overview-section";
import { UsageSection } from "./usage-section";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "publish", label: "Publish" },
  { id: "releases", label: "Releases" },
  { id: "audience", label: "Audience" },
  { id: "usage", label: "Limits & usage" },
  { id: "health", label: "Health & logs" },
  { id: "export", label: "Export & recovery" },
];

export default function AppDetailPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params);
  const { boot } = useShell();
  const toasts = useSafeToasts();
  const detail = useHostedApp(appId);
  const list = useHostedApps();
  const [opening, setOpening] = useState(false);

  const payload = detail.data;
  const app = payload?.app;
  // The API attaches grants only for an owner, so their presence is the role.
  const isOwner = payload?.isOwner ?? false;
  const health = useHostedHealth(isOwner ? appId : null);

  const workspaceRole = boot?.role ?? null;
  const workspaceName = boot?.workspace.name ?? "this workspace";
  const isWorkspaceAdmin = workspaceRole === "admin";
  const appName = app?.name ?? "this app";

  // Whether builds are paused is a workspace-wide, admin-only reading. When the
  // caller cannot read it the button stays offered and the server refuses in
  // its own words — better than a refusal this screen cannot substantiate.
  const spending = useSpending(isWorkspaceAdmin);
  const paused = spending.data?.spending.buildsPaused;

  const runtime = list.data?.runtime;
  const builders = list.data?.builders;
  const runningJob = payload?.runningJob ?? null;

  const gate = {
    appName,
    appState: app?.state ?? "active",
    workspaceRole,
    workspaceName,
    isOwner,
    runtime,
    builders,
    buildsPaused: paused?.paused,
    buildsPausedReason: paused?.reason,
    hasRunningJob: Boolean(runningJob),
  } as const;

  const publishBlocked = publishBlockedReason(gate);
  const rollbackBlocked = rollbackBlockedReason(gate);
  const stateChangeReason = stateChangeBlockedReason(gate);
  const ownerOnlyReason = isOwner ? undefined : `Only an owner of ${appName} can do this.`;

  const refreshAll = () => {
    detail.refresh();
    list.refresh();
  };

  const open = async () => {
    setOpening(true);
    try {
      await launchHostedApp(appId);
    } catch (cause) {
      const { message, fix } = errorText(cause);
      toasts.push({ kind: "err", title: `${appName} did not open. ${message}`, body: fix });
      setOpening(false);
    }
  };

  if (detail.error && !payload)
    return (
      <div className="product-page mx-auto h-full w-full max-w-[820px] overflow-y-auto">
        <PageHeading title="App" description="This app could not be loaded." />
        <Card>
          <ErrorNote error={detail.error} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="quiet" onClick={detail.refresh}>
              Try again
            </Button>
            <Link
              href="/apps"
              className="inline-flex h-8 items-center rounded-ctl px-2.5 text-[12.5px] text-ink-mute hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              Back to apps
            </Link>
          </div>
        </Card>
      </div>
    );

  if (!payload || !app)
    return (
      <div className="product-page mx-auto h-full w-full max-w-[1100px] overflow-y-auto">
        <div className="space-y-4">
          <Skeleton height={34} width="40%" />
          <Skeleton height={14} width="60%" />
          <Skeleton height={200} />
          <Skeleton height={260} />
        </div>
      </div>
    );

  return (
    <div className="product-page mx-auto h-full w-full max-w-[1100px] overflow-y-auto">
      <PageHeading
        title={app.name}
        description="Publish new versions, choose who can open it, and watch how it is doing."
        actions={
          <Link
            href="/apps"
            className="inline-flex h-9 items-center rounded-ctl px-3 text-[13px] text-ink-mute transition-colors hover:bg-bg2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            All apps
          </Link>
        }
      />

      <SectionNavigation sections={SECTIONS} label={`Sections of ${app.name}`} />

      <div className="space-y-10 pb-16">
        <section id="overview" tabIndex={-1}>
          <OverviewSection
            app={app}
            activeRelease={payload.activeRelease}
            workspaceRole={workspaceRole}
            workspaceName={workspaceName}
            isOwner={isOwner}
            onOpen={() => void open()}
            opening={opening}
            onChanged={refreshAll}
            stateChangeReason={stateChangeReason}
          />
        </section>

        <section id="publish" tabIndex={-1} className="space-y-4">
          {runtime && (
            <RuntimeBanner
              runtime={runtime}
              builders={builders}
              buildsPaused={paused?.paused}
              buildsPausedReason={paused?.reason}
            />
          )}
          <PublishPanel
            appId={appId}
            appName={app.name}
            url={app.url}
            activeRelease={payload.activeRelease}
            blockedReason={publishBlocked}
            runningJobId={runningJob?.id ?? null}
            onChanged={refreshAll}
            onOpen={() => void open()}
            opening={opening}
          />
        </section>

        <section id="releases" tabIndex={-1}>
          <Card
            title="Releases"
            subtitle="Every version this app has had. Rolling back changes the code and leaves the data alone."
            padded={false}
          >
            <ReleasesTable
              appId={appId}
              appName={app.name}
              releases={payload.releases ?? []}
              activeReleaseId={app.activeReleaseId}
              rollbackDisabledReason={rollbackBlocked}
              onChanged={refreshAll}
            />
          </Card>
        </section>

        <section id="audience" tabIndex={-1}>
          <AudiencePanel
            appId={appId}
            appName={app.name}
            grants={payload.grants}
            invites={payload.invites}
            canManage={isOwner}
            manageDisabledReason={ownerOnlyReason}
            onChanged={refreshAll}
          />
        </section>

        <section id="usage" tabIndex={-1}>
          <UsageSection
            appId={appId}
            appName={app.name}
            limits={list.data?.limits}
            enforcement={list.data?.enforcement}
            canRead={isOwner}
            readReason={ownerOnlyReason}
            canSeeSpending={isWorkspaceAdmin}
            workspaceName={workspaceName}
          />
        </section>

        <section id="health" tabIndex={-1}>
          <Card
            title="Health and logs"
            subtitle="What a real check against this app found, and what the app itself recorded."
          >
            {isOwner ? (
              <HealthPanel
                health={health.data}
                loading={health.loading}
                error={health.error}
                onRetry={health.refresh}
              />
            ) : (
              <p className="max-w-[70ch] text-[13px] text-ink-mute">{ownerOnlyReason}</p>
            )}
          </Card>
        </section>

        <section id="export" tabIndex={-1}>
          <ExportSection
            appId={appId}
            appName={app.name}
            appSlug={app.slug}
            state={app.state}
            stateReason={app.stateReason}
            exportDisabledReason={ownerOnlyReason}
          />
        </section>
      </div>
    </div>
  );
}
