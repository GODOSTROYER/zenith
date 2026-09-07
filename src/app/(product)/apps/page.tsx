"use client";
/**
 * Apps — everything this workspace has published, and the one button that
 * starts a new one.
 *
 * A card only claims what the API said: the address the server gave it, a
 * release number when there is a release, a running publish when a job is
 * actually moving. The banner above them says what serves these apps and what
 * could build the next version, in the runtime's and the runners' own words.
 *
 * Workstream W9 (hosted R3)
 */
import { useState } from "react";
import Link from "next/link";
import { AppWindow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote, errorText, useSafeToasts } from "@/components/screens/shared";
import { PageHeading } from "@/components/screens/page-heading";
import { useShell } from "@/components/shell/shell-context";
import { AppCard } from "@/components/apps/app-card";
import { RuntimeBanner } from "@/components/apps/runtime-banner";
import { launchHostedApp, useHostedApps } from "@/lib/client/hosted";

/** A Link that has to look like the primary Button; the kit has no `asChild`. */
const PRIMARY_LINK =
  "inline-flex h-9 items-center rounded-ctl bg-signal px-3.5 text-[13px] font-medium text-on-signal transition-colors hover:bg-signal-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

export default function AppsPage() {
  const { data, error, loading, refresh } = useHostedApps();
  const { boot } = useShell();
  const toasts = useSafeToasts();
  const [openingId, setOpeningId] = useState<string | null>(null);

  // Creating an app needs editor or admin in the workspace. While the shell is
  // still loading nobody knows yet, and the create screen re-checks anyway.
  const viewerOnly = boot?.role === "viewer";
  const createReason = viewerOnly
    ? `Creating an app needs the editor role in ${boot?.workspace.name ?? "this workspace"} and you are viewer. Ask a workspace admin to raise your role in Settings → Members.`
    : undefined;

  const open = async (appId: string, name: string) => {
    setOpeningId(appId);
    try {
      await launchHostedApp(appId);
    } catch (cause) {
      const { message, fix } = errorText(cause);
      toasts.push({ kind: "err", title: `${name} did not open. ${message}`, body: fix });
      setOpeningId(null);
    }
  };

  const apps = data?.apps ?? [];

  return (
    <div className="product-page mx-auto h-full w-full max-w-[1320px] overflow-y-auto">
      <PageHeading
        title="Apps"
        description="Publish a supported app to a private URL, and choose who can open it. People you invite never see this screen."
        actions={
          createReason ? (
            <Button variant="primary" disabled disabledReason={createReason}>
              New app
            </Button>
          ) : (
            <Link href="/apps/new" className={PRIMARY_LINK}>
              New app
            </Link>
          )
        }
      />

      {error && !data ? (
        <Card>
          <ErrorNote error={error} />
          <Button className="mt-3" size="sm" variant="quiet" onClick={refresh}>
            Try again
          </Button>
        </Card>
      ) : loading && !data ? (
        <div className="space-y-6">
          <Skeleton height={168} />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton height={220} />
            <Skeleton height={220} />
          </div>
        </div>
      ) : data ? (
        <div className="space-y-6">
          <RuntimeBanner runtime={data.runtime} builders={data.builders} />

          {apps.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                icon={<AppWindow className="h-5 w-5" />}
                title="No apps yet"
                body="An app is one published frontend with its own private address and its own invited audience. Create one, publish a version, and invite the people who should use it."
                action={
                  createReason ? (
                    <Button variant="primary" disabled disabledReason={createReason}>
                      Create an app
                    </Button>
                  ) : (
                    <Link href="/apps/new" className={PRIMARY_LINK}>
                      Create an app
                    </Link>
                  )
                }
              />
            </Card>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {apps.map((app) => (
                <li key={app.id} className="min-w-0">
                  <AppCard
                    app={app}
                    opening={openingId === app.id}
                    onOpen={() => void open(app.id, app.name)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
