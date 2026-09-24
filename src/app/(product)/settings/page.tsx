"use client";
/**
 * Workspace settings without a project in the URL.
 *
 * Settings live under a project (`/p/<slug>/settings`), which left a
 * workspace with no projects nowhere to rename itself or manage members, and
 * gave hand-off links nowhere to point. This page sends a workspace that has
 * projects to its first project's settings, keeping the query and the section
 * anchor, and renders the two workspace-wide sections itself when there is
 * no project yet.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Callout } from "@/components/ui/callout";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeading } from "@/components/screens/page-heading";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";
import { useShell } from "@/components/shell/shell-context";
import { useGate } from "../p/[slug]/settings/access";
import { MembersSection } from "../p/[slug]/settings/members";
import { SettingsNavigation } from "../p/[slug]/settings/settings-navigation";
import { WorkspaceCard } from "../p/[slug]/settings/workspace-card";
import styles from "../p/[slug]/settings/settings.module.css";

const SECTIONS = [
  { id: "workspace", label: "Workspace" },
  { id: "members", label: "Members" },
];

export default function WorkspaceSettingsPage() {
  const { boot, error, refresh } = useShell();
  const router = useRouter();
  const gate = useGate();
  const scrollRoot = useRef<HTMLDivElement>(null);
  const [rename, setRename] = useState<{ from: string; name: string }>();
  const [hash, setHash] = useState("");
  const first = boot?.projects[0]?.slug;

  useEffect(() => {
    if (!first) return;
    const { search, hash } = window.location;
    router.replace(`/p/${encodeURIComponent(first)}/settings${search}${hash}`);
  }, [first, router]);

  const standalone = !!boot && !first;
  // The sections exist only once the payload is in, so the browser's own jump
  // to #members found nothing. Do it again now.
  useEffect(() => {
    if (!standalone) return;
    const target = window.location.hash.slice(1);
    setHash(target);
    if (target) document.getElementById(target)?.scrollIntoView({ block: "start" });
  }, [standalone]);

  if (!boot)
    return (
      <div className="space-y-3 p-6">
        {error ? <ErrorNote error={error} /> : null}
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  if (first)
    return (
      <div className="space-y-3 p-6" role="status" aria-label="Opening settings">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  const projectOnly = hash !== "" && !SECTIONS.some((s) => s.id === hash);

  return (
    <div ref={scrollRoot} className={`product-page ${styles.page}`}>
      <div className={styles.inner}>
        <PageHeading title="Settings" description="Workspace name and members. Environments, connections, secrets and alerts appear here once the workspace has a project." />
        <div className={styles.scope}>
          <span>Workspace <strong>{boot.workspace.name}</strong></span>
          <span>Projects <strong>none yet</strong></span>
          <span>Your access <strong>{boot.role ?? "Loading…"}</strong></span>
        </div>
        {projectOnly && (
          <Callout tone="info" className="mb-6" title="This section belongs to a project">
            <p>
              This workspace has no projects yet, so there is nothing to configure there.{" "}
              <Link href="/onboarding?step=2" className="text-signal underline-offset-2 hover:underline">
                Create a project
              </Link>{" "}
              first.
            </p>
          </Callout>
        )}
        <div className={styles.layout}>
          <SettingsNavigation sections={SECTIONS} scrollRoot={scrollRoot} />
          <div className={styles.content}>
            <section id="workspace" tabIndex={-1} className="space-y-4">
              <SectionHead title="Workspace" body="The shared identity for your projects, connections, and members." />
              <WorkspaceCard
                workspace={boot.workspace}
                disabledReason={gate(boot.role, "workspace.rename")}
                onRename={(name) => setRename({ from: boot.workspace.name, name })}
              />
            </section>
            <section id="members" tabIndex={-1} className="space-y-4">
              <SectionHead
                title="Members"
                body="Manage membership and permissions across this workspace. Every member can preview a plan; their role determines what they can apply."
              />
              <MembersSection boot={boot} refresh={refresh} />
            </section>
          </div>
        </div>
      </div>
      {rename && (
        <ActionConfirm
          open
          onClose={() => setRename(undefined)}
          actionId="workspace.rename"
          input={{ name: rename.name }}
          title={`Rename “${rename.from}” to “${rename.name}”`}
          confirmLabel="Rename workspace"
          onDone={() => {
            setRename(undefined);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SectionHead({ title, body }: { title: string; body: string }) {
  return (
    <div className={styles.sectionHead}>
      <h2 className="app-section-title">{title}</h2>
      <p className="mt-1 max-w-[70ch] text-[13px] text-ink-mute">{body}</p>
    </div>
  );
}
