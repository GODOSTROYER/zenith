"use client";
/**
 * Settings — who is in the workspace and what they may do, the environments
 * and the policy that guards them, cloud connections and the exact access each
 * one holds, the export bundle, and the two destructive things in the product.
 *
 * Two rules shape this screen. Every control is role-gated where it is
 * rendered, so nothing here fails only after a plan dialog has been walked
 * through; and every mutation is plan-first, so what a button will do is
 * readable before it does it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { FileCode2, Trash2 } from "lucide-react";
import type { Workspace } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";
import { useShell } from "@/components/shell/shell-context";
import { useGate } from "./access";
import { AlertChannelsSection } from "./alerts";
import { ConnectionsSection } from "./connections";
import { EnvironmentsSection } from "./environments";
import { MembersSection } from "./members";
import { SecretsSection } from "./secrets";
import { providersOf } from "./shared";
import { PageHeading } from "@/components/screens/page-heading";
import { SettingsNavigation } from "./settings-navigation";
import styles from "./settings.module.css";

const SECTIONS = [
  { id: "workspace", label: "Workspace" },
  { id: "members", label: "Members" },
  { id: "environments", label: "Environments" },
  { id: "connections", label: "Connections" },
  { id: "secrets", label: "Secrets" },
  { id: "alerts", label: "Alerts" },
  { id: "export", label: "Export" },
  { id: "danger", label: "Danger zone" },
];
const ExportPanel = dynamic(() => import("@/components/screens/export-panel").then((m) => m.ExportPanel), {
  loading: () => <Skeleton height={120} />,
});

type Pending = { kind: "renameWorkspace"; from: string; name: string } | { kind: "deleteProject" };

export default function SettingsPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const { boot, error: bootError, refresh: refreshShell } = useShell();
  const gate = useGate();
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [showBundle, setShowBundle] = useState(false);
  const scrollRoot = useRef<HTMLDivElement>(null);

  const role = boot?.role;
  const connections = useMemo(() => boot?.connections ?? [], [boot]);
  const providers = useMemo(() => providersOf(boot), [boot]);
  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);

  // Activity and the role-denied copy link straight to /settings#members. The
  // section does not exist yet at first paint, so the browser's own hash jump
  // lands nowhere — do it again once the payload is in.
  const ready = !!data && !!boot;
  useEffect(() => {
    if (!ready) return;
    const target = window.location.hash.slice(1);
    if (target) document.getElementById(target)?.scrollIntoView({ block: "start" });
  }, [ready]);

  if (!data)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  const done = () => {
    setPending(null);
    refresh();
    refreshShell();
  };
  const deleteGate = gate(role, "project.delete");

  return (
    <div ref={scrollRoot} className={`product-page ${styles.page}`}>
      <div className={styles.inner}>
      <PageHeading title="Settings" description="Workspace access, environment safeguards, and the connections behind your system." />
      <div className={styles.scope}>
        <span>Workspace <strong>{boot?.workspace.name ?? "Loading…"}</strong></span>
        <span>Project <strong>{data.project.name}</strong></span>
        <span>Your access <strong>{role ?? "Loading…"}</strong></span>
      </div>
      <div className={styles.layout}>
      <SettingsNavigation sections={SECTIONS} scrollRoot={scrollRoot} />

      <div className={styles.content}>
        {/* -------------------------------- workspace ----------------------- */}
        <section id="workspace" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Workspace"
            body="The shared identity for your projects, connections, and members."
          />
          {bootError ? <ErrorNote error={bootError} /> : null}
          {!boot ? (
            <Skeleton height={120} />
          ) : (
            <WorkspaceCard
              workspace={boot.workspace}
              disabledReason={gate(role, "workspace.rename")}
              onRename={(name) =>
                setPending({ kind: "renameWorkspace", from: boot.workspace.name, name })
              }
            />
          )}
        </section>

        {/* --------------------------------- members ------------------------ */}
        <section id="members" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Members"
            body="Manage membership and permissions across this workspace. Every member can preview a plan; their role determines what they can apply."
          />
          <MembersSection boot={boot} refresh={refreshShell} />
        </section>

        {/* ------------------------------ environments ---------------------- */}
        <section id="environments" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Environments"
            body="Review each environment’s deployed revision, connection, budget, and approval policy."
          />
          <EnvironmentsSection
            environments={data.environments}
            revisions={data.revisions}
            deployments={boot?.deployments ?? []}
            connections={connections}
            providerById={providerById}
            connectionsLoaded={!!boot}
            role={role}
            projectId={projectId}
            refresh={done}
          />
        </section>

        {/* ------------------------------ connections ----------------------- */}
        <section id="connections" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Connections"
            body="Provider connections shared by this workspace, with their last check and declared access."
          />
          <ConnectionsSection
            connections={connections}
            providers={providers}
            providerById={providerById}
            loaded={!!boot}
            error={bootError}
            role={role}
            projectId={projectId}
            refresh={done}
          />
        </section>

        {/* -------------------------------- secrets ------------------------- */}
        <section id="secrets" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Secrets"
            body="Inspect encrypted secret references and versions. Values stay on the server; only references appear in manifests, reviews, and exports."
          />
          {!boot ? (
            <Skeleton height={180} />
          ) : (
            <SecretsSection
              workspaceId={boot.workspace.id}
              workspaceName={boot.workspace.name}
              projectId={projectId}
              slug={slug}
              manifest={data.project.workingManifest}
              role={role}
            />
          )}
        </section>

        {/* -------------------------------- alerts -------------------------- */}
        <section id="alerts" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Alerts"
            body="Choose where workspace alerts are delivered. Configure the rules in Observe; without a delivery channel, alerts remain available in the application."
          />
          <AlertChannelsSection projectId={projectId} role={role} />
        </section>

        {/* -------------------------------- export -------------------------- */}
        <section id="export" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Export"
            body="Everything Zenith generated for this environment, in files you can run yourself."
          />
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <p className="max-w-[62ch] text-[13px] text-ink-mute">
                The bundle for{" "}
                <span className="text-ink">{env?.name ?? "the selected environment"}</span> is
                generated on request: every file, plus a README naming the provider that produced
                them and whether they came from a deployed revision or the working copy. The Source
                screen carries the same panel under its Export tab.
              </p>
              <Link
                href={`/p/${slug}/source`}
                className="text-[12.5px] text-signal underline-offset-2 hover:underline"
              >
                Open Source
              </Link>
            </div>
            {showBundle ? (
              <div className="mt-5">
                <ExportPanel
                  environmentId={env?.id}
                  environmentName={env?.name}
                  workingManifest={data.project.workingManifest}
                />
              </div>
            ) : (
              <Button
                variant="quiet"
                className="mt-4"
                icon={<FileCode2 className="h-3.5 w-3.5" />}
                onClick={() => setShowBundle(true)}
              >
                Generate export bundle
              </Button>
            )}
          </Card>
        </section>

        {/* ------------------------------ danger zone ----------------------- */}
        <section id="danger" tabIndex={-1} className="space-y-4">
          <SectionHead
            title="Danger zone"
            body="Permanent record removal. Review the exact impact before confirming."
          />
          <Card className="border-err/25">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-[14px] text-ink">Delete this project</h3>
                <p className="mt-1 max-w-[62ch] text-[12.5px] text-ink-mute">
                  Removes {data.project.name}, its environments, revisions, deployment records and
                  findings from Zenith. Nothing in your cloud or in the sandbox is torn down: if an
                  environment is running something, it keeps running and Zenith loses the way back
                  to it. The plan lists the exact counts before you confirm.
                </p>
              </div>
              <Button
                variant="danger"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                disabled={!!deleteGate}
                disabledReason={deleteGate}
                onClick={() => setPending({ kind: "deleteProject" })}
              >
                Delete project
              </Button>
            </div>
          </Card>
          <p className="text-[12px] text-ink-faint">
            Deleting a single environment lives on its card under Environments.
          </p>
        </section>
      </div>
      </div>
      </div>

      {/* ------------------------------ confirmations ---------------------- */}
      {pending?.kind === "renameWorkspace" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="workspace.rename"
          input={{ name: pending.name }}
          title={`Rename “${pending.from}” to “${pending.name}”`}
          confirmLabel="Rename workspace"
          onDone={done}
        />
      )}

      {pending?.kind === "deleteProject" && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="project.delete"
          input={{ projectId }}
          scope={{ projectId }}
          title={`Delete the project ${data.project.name}`}
          confirmLabel="Delete project"
          danger
          typeToConfirm={data.project.name}
          onDone={() => {
            setPending(null);
            refreshShell();
            router.push("/overview");
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

/* -------------------------------- workspace ------------------------------- */

function WorkspaceCard({
  workspace,
  disabledReason,
  onRename,
}: {
  workspace: Workspace;
  /** why renaming is not this member's to do, when that is the case */
  disabledReason: string | undefined;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const trimmed = name.trim();
  const tooShort = trimmed.length < 2;
  const unchanged = trimmed === workspace.name;

  return (
    <Card
      title={workspace.name}
      subtitle={
        <>
          <span className="break-all font-mono">{workspace.slug}</span> · workspace links keep this slug when the name changes
        </>
      }
    >
      <Field
        label="Workspace name"
        help="Shown in navigation and workspace switching. Existing links and audit history are preserved."
        error={!tooShort || name === "" ? undefined : "Use at least 2 characters."}
      >
        <div className="flex flex-wrap gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="min-w-[180px] flex-1"
            disabled={!!disabledReason}
          />
          <Button
            variant="quiet"
            disabled={tooShort || unchanged || !!disabledReason}
            disabledReason={
              disabledReason ??
              (tooShort
                ? "A workspace name needs at least 2 characters."
                : "This is already the workspace name.")
            }
            onClick={() => onRename(trimmed)}
          >
            Preview and rename
          </Button>
        </div>
      </Field>
    </Card>
  );
}
