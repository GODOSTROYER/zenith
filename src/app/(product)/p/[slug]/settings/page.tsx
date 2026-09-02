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
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCode2, Trash2 } from "lucide-react";
import type { Workspace } from "@/lib/domain/types";
import { Button, Card, Field, Input, Skeleton } from "@/components/ui";
import { ExportPanel } from "@/components/screens/export-panel";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";
import { useShell } from "@/components/shell/shell-context";
import { useGate } from "./access";
import { ConnectionsSection } from "./connections";
import { EnvironmentsSection } from "./environments";
import { MembersSection } from "./members";
import { SecretsSection } from "./secrets";
import { providersOf } from "./shared";

const SECTIONS = [
  { id: "workspace", label: "Workspace" },
  { id: "members", label: "Members" },
  { id: "environments", label: "Environments" },
  { id: "connections", label: "Connections" },
  { id: "secrets", label: "Secrets" },
  { id: "export", label: "Export" },
  { id: "danger", label: "Danger zone" },
];

type Pending = { kind: "renameWorkspace"; from: string; name: string } | { kind: "deleteProject" };

export default function SettingsPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const { boot, error: bootError, refresh: refreshShell } = useShell();
  const gate = useGate();
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [showBundle, setShowBundle] = useState(false);

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
    <div className="mx-auto h-full w-full max-w-[1040px] overflow-y-auto px-6 py-6">
      <nav
        aria-label="Settings sections"
        className="sticky top-0 z-10 -mx-6 mb-8 flex flex-wrap items-center gap-1 border-b border-line bg-bg0/90 px-6 py-2 backdrop-blur"
      >
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-ctl px-2.5 py-1 text-[12.5px] text-ink-mute transition-colors hover:bg-bg2 hover:text-ink"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div className="space-y-10">
        {/* -------------------------------- workspace ----------------------- */}
        <section id="workspace" className="scroll-mt-16 space-y-4">
          <SectionHead
            title="Workspace"
            body="The name in the top bar. Onboarding promised you could change it later; this is later."
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
        <section id="members" className="scroll-mt-16 space-y-4">
          <SectionHead
            title="Members"
            body="Who is in this workspace and what each role may do. Every refusal in the product points here."
          />
          <MembersSection boot={boot} refresh={refreshShell} />
        </section>

        {/* ------------------------------ environments ---------------------- */}
        <section id="environments" className="scroll-mt-16 space-y-4">
          <SectionHead
            title="Environments"
            body="Where revisions run. Class decides the defaults; policy decides who can change them."
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
        <section id="connections" className="scroll-mt-16 space-y-4">
          <SectionHead
            title="Connections"
            body="Every connection lists the exact access it holds. Orrery never asks for more than it shows."
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
        <section id="secrets" className="scroll-mt-16 space-y-4">
          <SectionHead
            title="Secrets"
            body="What the store holds, as metadata. The value is never shown here, and no route returns one — only the reference reaches a manifest, a diff or an export."
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

        {/* -------------------------------- export -------------------------- */}
        <section id="export" className="scroll-mt-16 space-y-4">
          <SectionHead
            title="Export"
            body="Everything Orrery generated for this environment, in files you can run yourself."
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
                Generate it here
              </Button>
            )}
          </Card>
        </section>

        {/* ------------------------------ danger zone ----------------------- */}
        <section id="danger" className="scroll-mt-16 space-y-4">
          <SectionHead
            title="Danger zone"
            body="Irreversible things live here. Each one previews exactly what it removes — and what it does not."
          />
          <Card className="border-err/25">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-[14px] text-ink">Delete this project</h3>
                <p className="mt-1 max-w-[62ch] text-[12.5px] text-ink-mute">
                  Removes {data.project.name}, its environments, revisions, deployment records and
                  findings from Orrery. Nothing in your cloud or in the sandbox is torn down: if an
                  environment is running something, it keeps running and Orrery loses the way back
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
    <div>
      <h2 className="text-[20px] font-medium tracking-[-0.01em] text-ink">{title}</h2>
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
          slug <span className="font-mono">{workspace.slug}</span> · renaming never changes the
          slug, so links keep working
        </>
      }
    >
      <Field
        label="Workspace name"
        help="Shows in the top bar. Audit history is keyed to the workspace id, so nothing already written changes."
        error={!tooShort || name === "" ? undefined : "Use at least 2 characters."}
      >
        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
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
