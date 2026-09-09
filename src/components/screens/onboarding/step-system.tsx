"use client";
/**
 * Step 3 — the system itself, and the only step that creates anything: the
 * cloud connection first (the environment has to reference it), then the
 * project, then the manifest for the formats that parse in the browser.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileCode2, Layers, PlusSquare, Sparkles, Upload } from "lucide-react";
import { api, ApiError, executeAction } from "@/lib/client/api";
import { recoveryKey, restoreRecovery, type StarterRecovery } from "@/components/guide/recovery";
import { canEditGuide } from "@/components/guide/progress";
import { importDockerfile } from "@/lib/importers/dockerfile";
import { importTerraform } from "@/lib/importers/terraform";
import type { ImportReport } from "@/lib/importers/types";
import { cx, fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote } from "../shared";
import { ImportReportView } from "../import-report";
import type { BlueprintCard, Bootstrap, ProviderChoice } from "./types";

type Mode = "blueprint" | "import" | "blank";

interface CreateResult {
  projectId?: string;
  slug?: string;
  environmentId?: string;
  report?: ImportReport;
}

type Format = "compose" | "terraform" | "dockerfile";

const FORMATS: {
  value: Format;
  label: string;
  title: string;
  accept: string;
  /** what the box wants, and what it honestly does with it */
  prompt: string;
  placeholder: string;
}[] = [
  {
    value: "compose",
    label: "compose",
    title: "docker-compose.yml — services, resources and the links between them.",
    accept: ".yml,.yaml,text/yaml,application/x-yaml,text/plain",
    prompt: "Services, images, ports and depends_on all translate. Volumes and build args do not.",
    placeholder: 'version: "3.9"\nservices:\n  web:\n    image: my/app:latest\n    ports:\n      - "3000:3000"',
  },
  {
    value: "terraform",
    label: "terraform",
    title: "A .tf file — recognised resources are imported as referenced, never provisioned.",
    accept: ".tf,.hcl,text/plain",
    prompt:
      "A text scan, not an HCL parse: modules, variables and count/for_each are not evaluated. What it recognises is imported as “referenced” — read, never changed.",
    placeholder: 'resource "aws_db_instance" "primary" {\n  engine = "postgres"\n}\n\nresource "aws_s3_bucket" "assets" {}',
  },
  {
    value: "dockerfile",
    label: "dockerfile",
    title: "A Dockerfile — one image, so one web service.",
    accept: "text/plain,.dockerfile",
    prompt:
      "One Dockerfile describes one image, so this produces exactly one web service. Build instructions stay in your Dockerfile.",
    placeholder: 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]',
  },
];

/**
 * Past this the input is a mistake, not a manifest — a 5 MB paste would parse
 * on the main thread and freeze the tab with no explanation.
 */
const MAX_IMPORT_CHARS = 256 * 1024;
const kb = (n: number) => Math.max(1, Math.round(n / 1024));
const OVERSIZE_FIX = `Keep the file under ${kb(MAX_IMPORT_CHARS)} KB — trim it to the services you want, or import them a few at a time.`;

export interface StepSystemProps {
  blueprints: BlueprintCard[];
  sampleCompose: string;
  /** An explicit choice is required; there is no implicit sandbox fallback. */
  choice: ProviderChoice;
  boot: Bootstrap;
  onBack: () => void;
  onCreated: (slug: string, message: string, projectId?: string) => void;
}

export function StepSystem({
  blueprints,
  sampleCompose,
  choice,
  boot,
  onBack,
  onCreated,
}: StepSystemProps) {
  const [mode, setMode] = useState<Mode>("blueprint");
  const [format, setFormat] = useState<Format>("compose");
  const [selected, setSelected] = useState<string>(blueprints.find((b) => b.id === (choice.providerId === "localstack" ? "local-resources" : "saas-standard"))?.id ?? blueprints[0]?.id ?? "");
  const [source, setSource] = useState("");
  const [sourceFile, setSourceFile] = useState<string>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [review, setReview] = useState<{ report: ImportReport; slug: string; summary: string; projectId?: string }>();
  /** the usable connection, once this step has one */
  const [connectionId, setConnectionId] = useState(choice?.connectionId);
  /** created, but preflight did not pass — retrying re-checks it, never duplicates it */
  const [unusableConnectionId, setUnusableConnectionId] = useState<string>();
  const [pendingProject, setPendingProject] = useState<CreateResult>();
  const [uncertain, setUncertain] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const inFlight = useRef(false);
  const recovery = useRef<StarterRecovery>({ workspaceId: boot.workspace.id, userId: boot.user?.id ?? "", providerId: choice.providerId });
  const saveRecovery = (patch: Partial<StarterRecovery>) => {
    recovery.current = { ...recovery.current, ...patch };
    const key = recoveryKey(boot, choice.providerId);
    try { if (key) localStorage.setItem(key, JSON.stringify(recovery.current)); } catch { /* no import text or credentials are persisted */ }
  };
  const clearRecovery = () => {
    const key = recoveryKey(boot, choice.providerId);
    try { if (key) localStorage.removeItem(key); } catch { /* optional persistence */ }
  };
  useEffect(() => {
    if (recovered) return;
    const key = recoveryKey(boot, choice.providerId);
    try {
      const saved = restoreRecovery(key ? localStorage.getItem(key) : null, boot, choice.providerId);
      if (saved) {
        recovery.current = saved;
        setUncertain(!!saved.uncertain);
        if (saved.connectionId) setConnectionId(saved.connectionId);
        const project = boot.projects.find((p) => p.id === saved.projectId);
        if (project) {
          setPendingProject({ projectId: project.id, slug: project.slug, environmentId: boot.environments.find((e) => e.projectId === project.id)?.id });
          setName(project.name);
          if (saved.format) { setMode("import"); setFormat(saved.format); }
        }
      }
    } catch { /* optional storage */ }
    setRecovered(true);
  }, [boot, choice.providerId, recovered]);
  const needsNewConnection = !connectionId && !unusableConnectionId;
  const roleBlock = !canEditGuide(boot) ? "An editor or admin role is required to create projects." : needsNewConnection && boot.role !== "admin" ? "An admin must create this connection. Choose an existing connection or ask a workspace admin." : undefined;

  const chosen = useMemo(
    () => blueprints.find((b) => b.id === selected),
    [blueprints, selected]
  );
  const spec = FORMATS.find((f) => f.value === format)!;
  const oversize = source.length > MAX_IMPORT_CHARS;

  const projectName =
    name.trim() || (mode === "blueprint" ? (chosen?.name ?? "") : mode === "import" ? "Imported app" : "");

  // Terraform and Dockerfile parse in the browser — the same importers the map
  // dialog uses — so the file is understood before anything is created.
  const parsed = useMemo(() => {
    if (mode !== "import" || format === "compose" || !source.trim() || oversize) return undefined;
    try {
      const out =
        format === "terraform"
          ? importTerraform(source)
          : importDockerfile(source, sourceFile?.replace(/\.[^.]+$/, "") || projectName || "app");
      return { manifest: out.manifest, report: out.report, error: undefined };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [mode, format, source, sourceFile, projectName, oversize]);

  const canCreate =
    mode === "blueprint"
      ? !!chosen
      : mode === "import"
        ? source.trim().length > 0 &&
          !oversize &&
          (format === "compose" || !!parsed?.manifest)
        : !!name.trim();

  const readFile = async (file: File) => {
    setError(undefined);
    if (file.size > MAX_IMPORT_CHARS) {
      setSourceFile(undefined);
      setError(new ApiError(`${file.name} is ${kb(file.size)} KB.`, 413, OVERSIZE_FIX));
      return;
    }
    try {
      setSource(await file.text());
      setSourceFile(file.name);
    } catch (err) {
      setSourceFile(undefined);
      setError(err);
    }
  };

  const create = async () => {
    if (inFlight.current || !recovered || uncertain || roleBlock || !choice || !canCreate) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    let mutationStarted = false;
    let projectData = pendingProject;
    try {
      // Another tab can change the workspace cookie. Revalidate before any write.
      const fresh = await api<Bootstrap>("/api/bootstrap");
      if (fresh.workspace.id !== boot.workspace.id || fresh.user?.id !== boot.user?.id || !canEditGuide(fresh))
        throw new ApiError("Your workspace or access changed.", 409, "Reload the starter before creating anything.");
      let connId = connectionId ?? unusableConnectionId;
      let conn = fresh.connections.find((c) => c.id === connId && c.workspaceId === fresh.workspace.id && c.provider === choice.providerId);
      if (connId && !conn) throw new ApiError("The selected connection is no longer in this workspace.", 409, "Return to Connection and choose again.");
      // Reuse a connection saved by a prior interrupted attempt.
      conn ??= fresh.connections.find((c) => c.provider === choice.providerId && c.workspaceId === fresh.workspace.id);
      connId = conn?.id;
      if (!conn || conn.status !== "healthy" || choice.providerId === "localstack") {
        if (!conn && fresh.role !== "admin") throw new ApiError("Creating a connection requires an admin.", 403, "Choose an existing connection or ask a workspace admin.");
        mutationStarted = true;
        if (!conn) saveRecovery({ uncertain: true });
        const result = await executeAction(conn ? "connection.check" : "connection.create", {
          input: conn ? { connectionId: conn.id } : { provider: choice.providerId },
        });
        const made = (result.data as { connectionId?: string } | undefined)?.connectionId ?? conn?.id;
        if (made) { connId = made; setConnectionId(made); saveRecovery({ connectionId: made, uncertain: false }); }
        if (!result.ok) {
          if (made) setUnusableConnectionId(made);
          else { setUncertain(true); saveRecovery({ uncertain: true }); }
          setError(new ApiError(result.summary, 400, result.error));
          return;
        }
        setUnusableConnectionId(undefined);
      }
      if (!connId) throw new ApiError("No connection was returned.", 500, "Reload your workspace to inspect the saved connections.");
      saveRecovery({ connectionId: connId });

      if (projectData?.projectId) {
        const actual = fresh.projects.find((p) => p.id === projectData?.projectId && p.workspaceId === fresh.workspace.id);
        if (!actual) throw new ApiError("The saved project is no longer available.", 409, "Open the overview and review your projects.");
        if (!recovery.current.format || actual.workingManifest.services.length || actual.workingManifest.resources.length) {
          clearRecovery();
          onCreated(actual.slug, "Your project already exists. Review its current manifest in System; nothing was replaced.", actual.id);
          return;
        }
      }

      const call = mode === "blueprint"
        ? { actionId: "project.applyBlueprint", input: { blueprint: selected, name: projectName, connectionId: connId } }
        : mode === "import" && format === "compose"
          ? { actionId: "project.importCompose", input: { composeYaml: source, name: projectName, connectionId: connId } }
          : { actionId: "project.create", input: { name: projectName, connectionId: connId } };
      let summary = "Your editable project is saved. Nothing is deployed.";
      if (!projectData) {
        mutationStarted = true;
        // This marker survives a lost response or a refresh during the request.
        saveRecovery({ uncertain: true });
        const result = await executeAction(call.actionId, { input: call.input });
        projectData = (result.data ?? {}) as CreateResult;
        if (projectData.projectId) {
          setPendingProject(projectData);
          saveRecovery({ projectId: projectData.projectId, format: mode === "import" && format !== "compose" ? format : undefined, uncertain: false });
        }
        if (!result.ok || !projectData.projectId || !projectData.slug) {
          setUncertain(!projectData.projectId);
          setError(new ApiError(result.summary, 400, result.error ?? "Check the overview before attempting another creation."));
          return;
        }
        summary = result.summary;
      }
      const data = projectData;
      if (!data.projectId || !data.slug) throw new ApiError("The project response was incomplete.", 500, "Open the overview to inspect the saved project.");

      if (mode === "import" && format !== "compose" && parsed?.manifest) {
        // Preserve importer identity: Dockerfile secret references use the real
        // newly created project and service IDs, never a preview name.
        const importedManifest = format === "dockerfile"
          ? importDockerfile(source, sourceFile?.replace(/\.[^.]+$/, "") || projectName || "app", data.projectId).manifest
          : parsed.manifest;
        const applied = await executeAction("project.updateManifest", {
          input: { projectId: data.projectId, manifest: importedManifest }, scope: { projectId: data.projectId },
        });
        if (!applied.ok) {
          setError(new ApiError(`The project exists, but the ${spec.label} import did not apply: ${applied.summary}`, 400,
            applied.error ?? "Retry to apply this file to the same project, or open the saved project below."));
          return;
        }
        clearRecovery();
        setReview({ report: parsed.report, slug: data.slug, projectId: data.projectId, summary: `Imported your ${spec.label} file. Review the translation; nothing is deployed.` });
        return;
      }
      clearRecovery();
      if (data.report) setReview({ report: data.report, slug: data.slug, projectId: data.projectId, summary });
      else onCreated(data.slug, "Your editable system is saved. Nothing is deployed yet.", data.projectId);
    } catch (error) {
      if (mutationStarted && !projectData?.projectId) { setUncertain(true); saveRecovery({ uncertain: true }); }
      setError(error);
    } finally { inFlight.current = false; setBusy(false); }
  };
  if (review)
    return (
      <div className="max-w-[860px] space-y-6">
        <p className="text-[16px] leading-relaxed text-ink-mute">{review.summary}</p>
        <ImportReportView report={review.report} />
        <Button
          onClick={() => onCreated(review.slug, "Import saved. Review any unsupported elements before planning.", review.projectId)}
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          Continue to the guide
        </Button>
      </div>
    );

  return (
    <div className="max-w-[860px] space-y-6">
      <p className="text-[14px] leading-relaxed text-ink-mute">
        Start with a blueprint, import your configuration, or begin with an empty system.
        This creates an editable manifest and an environment using {choice.displayName}. Nothing is deployed.
      </p>
      {choice.providerId === "aws" && <p className="text-sm text-warn">AWS Preview supports plans and Terraform export only. Zenith never calls or applies changes to AWS. No credentials or IAM setup are needed.</p>}
      {choice.providerId === "localstack" && <p className="text-sm text-ink-mute">LocalStack supports real local S3 and SQS operations. The Local resources blueprint is a supported starting point. Application services, routes and other emulated behavior remain simulated; a successful connection check does not verify application support.</p>}
      {pendingProject?.slug && <div className="rounded-card border border-line bg-bg1 p-4 text-sm text-ink-mute"><p>Your project is already saved. Retrying an interrupted import uses this same project. If you refreshed, choose or paste the file again; its contents are never stored in browser storage.</p><Link href={`/p/${encodeURIComponent(pendingProject.slug)}`} className="mt-2 inline-block text-signal underline">Open the saved project</Link></div>}
      {uncertain && <div className="space-y-3 rounded-card border border-line bg-bg1 p-4 text-sm text-ink-mute"><p>The previous creation did not return a complete response. Check your projects before starting again, so you do not create duplicates.</p><Link href="/overview" className="block text-signal underline">Review projects in overview</Link><Button size="sm" variant="quiet" onClick={() => { clearRecovery(); setUncertain(false); }}>I checked — discard this saved attempt</Button><p className="text-xs text-ink-faint">This forgets starter progress only. It does not remove any saved project or connection.</p></div>}

      <div className="grid gap-3 sm:grid-cols-3">
        <ModeCard
          icon={<Layers className="h-4 w-4" />}
          title="Blueprint"
          body="An opinionated starting system, priced before you commit."
          active={mode === "blueprint"}
          disabled={busy || !!pendingProject}
          onClick={() => setMode("blueprint")}
        />
        <ModeCard
          icon={<FileCode2 className="h-4 w-4" />}
          title="Import a file"
          body="compose, Terraform or a Dockerfile. Every element is mapped or explained."
          active={mode === "import"}
          disabled={busy || !!pendingProject}
          onClick={() => setMode("import")}
        />
        <ModeCard
          icon={<PlusSquare className="h-4 w-4" />}
          title="Blank"
          body={`An empty system and an environment using ${choice.displayName}.`}
          active={mode === "blank"}
          disabled={busy || !!pendingProject}
          onClick={() => setMode("blank")}
        />
      </div>

      <Field
        label="Project name"
        help={
          mode === "blueprint"
            ? `Leave blank to use “${chosen?.name ?? "the blueprint name"}”.`
            : mode === "import"
              ? "Leave blank to call it “Imported app”."
              : "Used for the URL: /p/<slug>."
        }
      >
        <Input
          disabled={busy || !!pendingProject}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={mode === "blueprint" ? (chosen?.name ?? "Atlas") : "Atlas"}
          maxLength={60}
        />
      </Field>

      {mode === "blueprint" && (
        <div className="grid gap-3 sm:grid-cols-2">
          {blueprints.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={busy || !!pendingProject}
              onClick={() => setSelected(b.id)}
              aria-pressed={b.id === selected}
              className={cx(
                "rounded-card border bg-bg2 p-4 text-left transition-colors duration-[var(--dur-fast)]",
                b.id === selected
                  ? "border-signal bg-signal-dim"
                  : "border-line hover:border-line-strong"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <h4 className="text-[14px] font-medium text-ink">{b.name}</h4>
                <span className="tnum shrink-0 text-[13px] text-ink">
                  {fmtUsd(b.monthlyUsd)}
                  <span className="text-ink-faint">/mo est.</span>
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-mute">{b.description}</p>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-mute">{b.highlights.join(" · ")}</p>
              <p className="tnum mt-3 text-[11.5px] text-ink-faint">
                {b.nodes} nodes · {b.services} service{b.services === 1 ? "" : "s"} ·{" "}
                {b.resources} resource{b.resources === 1 ? "" : "s"}
              </p>
            </button>
          ))}
        </div>
      )}

      {mode === "import" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl<Format>
              size="sm"
              label="Import format"
              value={format}
              onChange={(f) => {
                if (busy || pendingProject) return;
                setFormat(f);
                setSource("");
                setSourceFile(undefined);
                setError(undefined);
              }}
              options={FORMATS.map((f) => ({ value: f.value, label: f.label, title: f.title }))}
            />
            <div className="flex items-center gap-2">
              <label className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-ctl border border-line px-2.5 text-[12.5px] text-ink-mute transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:text-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-signal">
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                Choose a file
                <input
                  type="file"
                  accept={spec.accept}
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ""; // let the same file be re-picked
                    if (file) await readFile(file);
                  }}
                />
              </label>
              {format === "compose" && (
                <Button
                  variant="quiet"
                  size="sm"
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  disabled={!sampleCompose}
                  disabledReason="The sample app fixture is missing from this build."
                  onClick={() => {
                    setSource(sampleCompose);
                    setSourceFile(undefined);
                  }}
                >
                  Use sample app
                </Button>
              )}
            </div>
          </div>

          <label htmlFor="import-source" className="block text-[13px] text-ink">
            Paste your {spec.label} file, or choose it
          </label>
          <p className="text-[12.5px] leading-relaxed text-ink-mute">{spec.prompt}</p>

          {sourceFile && (
            <p className="text-[12.5px] text-ink-mute">
              Loaded <span className="font-mono text-ink">{sourceFile}</span> — it is editable
              below, and nothing is read from your disk again.
            </p>
          )}
          <Textarea
            id="import-source"
            mono
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSourceFile(undefined);
            }}
            spellCheck={false}
            placeholder={spec.placeholder}
            className="h-[320px]"
          />
          {oversize && (
            <p className="text-[12.5px] text-err">
              That is {kb(source.length)} KB of text. {OVERSIZE_FIX}
            </p>
          )}
          {parsed?.error && <p className="text-[12.5px] text-err">{parsed.error}</p>}
          <p className="text-[12.5px] leading-relaxed text-ink-mute">
            Review the import report for unsupported elements. Importing changes the editable
            manifest and deploys nothing. The map shows estimates before a deployment plan.
          </p>
        </div>
      )}

      {mode === "blank" && (
        <Card title="An empty system" subtitle="You add services and resources on the System map.">
          <p className="text-[13px] text-ink-mute">
            Creates the project and one environment using {choice.displayName}. Nothing is deployed.
          </p>
          <p className="tnum mt-2 text-[13px] text-ink">
            {fmtUsd(0)}
            <span className="text-ink-faint">/mo est. — an empty system prices at nothing, and the map prices each thing as you add it.</span>
          </p>
        </Card>
      )}

      {error ? <ErrorNote error={error} /> : null}
      {roleBlock && <p className="text-sm text-warn">{roleBlock}</p>}

      <div className="flex gap-2">
        <Button variant="quiet" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          busy={busy}
          disabled={!canCreate || !recovered || uncertain || !!roleBlock}
          disabledReason={
            roleBlock ?? (uncertain ? "Review existing projects before starting again." : !recovered ? "Restoring saved progress…" : mode === "import"
              ? !source.trim()
                ? `Paste a ${spec.label} file, or choose one from disk.`
                : oversize
                  ? OVERSIZE_FIX
                  : (parsed?.error ?? "That file could not be read — see the message above.")
              : mode === "blank"
                ? "Give the project a name first."
                : "Pick a blueprint.")
          }
          onClick={create}
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          {pendingProject ? (recovery.current.format ? "Retry import in saved project" : "Continue with saved project") : mode === "import" ? "Import and review" : "Create editable project"}
        </Button>
      </div>
    </div>
  );
}

function ModeCard({
  icon,
  title,
  body,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "rounded-card border bg-bg2 p-4 text-left transition-colors duration-[var(--dur-fast)]",
        active ? "border-signal bg-signal-dim" : "border-line hover:border-line-strong"
      )}
    >
      <span className={cx("inline-flex", active ? "text-signal" : "text-ink-mute")}>{icon}</span>
      <h4 className="mt-2 text-[14px] font-medium text-ink">{title}</h4>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-mute">{body}</p>
    </button>
  );
}
