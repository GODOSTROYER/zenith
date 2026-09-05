"use client";
/**
 * Step 3 — the system itself, and the only step that creates anything: the
 * cloud connection first (the environment has to reference it), then the
 * project, then the manifest for the formats that parse in the browser.
 */
import { useMemo, useState } from "react";
import { ArrowRight, FileCode2, Layers, PlusSquare, Sparkles, Upload } from "lucide-react";
import { ApiError, executeAction } from "@/lib/client/api";
import { importDockerfile } from "@/lib/importers/dockerfile";
import { importTerraform } from "@/lib/importers/terraform";
import type { ImportReport } from "@/lib/importers/types";
import { cx, fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote } from "../shared";
import { ImportReportView } from "../import-report";
import type { BlueprintCard, ProviderChoice } from "./types";

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
  /** what step 2 settled on; undefined means the default sandbox connection */
  choice?: ProviderChoice;
  onBack: () => void;
  onCreated: (slug: string, message: string) => void;
}

export function StepSystem({
  blueprints,
  sampleCompose,
  choice,
  onBack,
  onCreated,
}: StepSystemProps) {
  const [mode, setMode] = useState<Mode>("blueprint");
  const [format, setFormat] = useState<Format>("compose");
  const [selected, setSelected] = useState<string>(blueprints[0]?.id ?? "");
  const [source, setSource] = useState("");
  const [sourceFile, setSourceFile] = useState<string>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [review, setReview] = useState<{ report: ImportReport; slug: string; summary: string }>();
  /** the usable connection, once this step has one */
  const [connectionId, setConnectionId] = useState(choice?.connectionId);
  /** created, but preflight did not pass — retrying re-checks it, never duplicates it */
  const [unusableConnectionId, setUnusableConnectionId] = useState<string>();

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
    setBusy(true);
    setError(undefined);
    try {
      // The connection has to exist before the environment can reference it,
      // so it is created here — at the last step — and not a moment earlier.
      let connId = connectionId;
      if (!connId && choice && choice.providerId !== "sandbox") {
        const conn = await executeAction(
          unusableConnectionId ? "connection.check" : "connection.create",
          {
            input: unusableConnectionId
              ? { connectionId: unusableConnectionId }
              : { provider: choice.providerId },
          }
        );
        const made = (conn.data as { connectionId?: string } | undefined)?.connectionId;
        if (!conn.ok) {
          // The connection row exists but its preflight did not pass. Fixing
          // the cause and pressing again re-checks that one.
          if (made) setUnusableConnectionId(made);
          setError(new ApiError(conn.summary, 400, conn.error));
          return;
        }
        connId = made;
        setConnectionId(made);
        setUnusableConnectionId(undefined);
      }

      // Compose creates the project in one action; Terraform and Dockerfile
      // parse here, so they create the project and then write the manifest
      // through the same audited action the Source view uses.
      const call =
        mode === "blueprint"
          ? {
              actionId: "project.applyBlueprint",
              input: { blueprint: selected, name: projectName, connectionId: connId },
            }
          : mode === "import" && format === "compose"
            ? {
                actionId: "project.importCompose",
                input: { composeYaml: source, name: projectName, connectionId: connId },
              }
            : { actionId: "project.create", input: { name: projectName, connectionId: connId } };

      const result = await executeAction(call.actionId, { input: call.input });
      if (!result.ok) {
        setError(new ApiError(result.summary, 400, result.error));
        return;
      }
      const data = (result.data ?? {}) as CreateResult;
      if (!data.slug) {
        setError(new ApiError(result.summary, 500, "The project was created but has no URL. Open it from the overview."));
        return;
      }

      if (mode === "import" && format !== "compose" && parsed?.manifest) {
        const applied = await executeAction("project.updateManifest", {
          input: { projectId: data.projectId, manifest: parsed.manifest },
          scope: { projectId: data.projectId },
        });
        if (!applied.ok) {
          setError(
            new ApiError(
              `The project was created, but the ${spec.label} import did not apply: ${applied.summary}`,
              400,
              applied.error ?? `Open /p/${data.slug} and import the file again from the map.`
            )
          );
          return;
        }
        setReview({
          report: parsed.report,
          slug: data.slug,
          summary: `Imported your ${spec.label} file into “${projectName}”. Nothing is deployed yet — this is what Orrery made of it.`,
        });
        return;
      }

      if (data.report) setReview({ report: data.report, slug: data.slug, summary: result.summary });
      else onCreated(data.slug, result.summary);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (review)
    return (
      <div className="max-w-[860px] space-y-6 animate-enter">
        <p className="text-[16px] leading-relaxed text-ink-mute">{review.summary}</p>
        <ImportReportView report={review.report} />
        <Button
          onClick={() => onCreated(review.slug, "Import complete — every element is accounted for.")}
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          Open the system map
        </Button>
      </div>
    );

  return (
    <div className="max-w-[860px] space-y-8 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        Start from a shape that already works, bring a file you already have, or begin with
        nothing. All three end in the same editable system
        {choice ? `, deploying through ${choice.displayName}` : ""}.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <ModeCard
          icon={<Layers className="h-4 w-4" />}
          title="Blueprint"
          body="An opinionated starting system, priced before you commit."
          active={mode === "blueprint"}
          onClick={() => setMode("blueprint")}
        />
        <ModeCard
          icon={<FileCode2 className="h-4 w-4" />}
          title="Import a file"
          body="compose, Terraform or a Dockerfile. Every element is mapped or explained."
          active={mode === "import"}
          onClick={() => setMode("import")}
        />
        <ModeCard
          icon={<PlusSquare className="h-4 w-4" />}
          title="Blank"
          body="An empty system and one sandbox environment."
          active={mode === "blank"}
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
              onClick={() => setSelected(b.id)}
              aria-pressed={b.id === selected}
              className={cx(
                "rounded-card border bg-bg2 p-4 text-left transition-colors duration-[var(--dur-fast)]",
                b.id === selected
                  ? "border-signal/60 ring-1 ring-signal/25"
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
              <div className="mt-3 flex flex-wrap gap-1.5">
                {b.highlights.map((h) => (
                  <Chip key={h}>{h}</Chip>
                ))}
              </div>
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
                setFormat(f);
                setSource("");
                setSourceFile(undefined);
                setError(undefined);
              }}
              options={FORMATS.map((f) => ({ value: f.value, label: f.label, title: f.title }))}
            />
            <div className="flex items-center gap-2">
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-ctl border border-line px-2.5 text-[12.5px] text-ink-mute transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:text-ink">
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
            Nothing is silently dropped: anything Orrery cannot translate is listed with a reason
            before you finish. The import itself deploys nothing, so it costs nothing — the map
            prices every service and resource before your first deploy.
          </p>
        </div>
      )}

      {mode === "blank" && (
        <Card title="An empty system" subtitle="You add services and resources on the System map.">
          <p className="text-[13px] text-ink-mute">
            Creates the project and one sandbox environment. Nothing is deployed and nothing
            costs anything until you deploy.
          </p>
          <p className="tnum mt-2 text-[13px] text-ink">
            {fmtUsd(0)}
            <span className="text-ink-faint">/mo est. — an empty system prices at nothing, and the map prices each thing as you add it.</span>
          </p>
        </Card>
      )}

      {error ? <ErrorNote error={error} /> : null}

      <div className="flex gap-2">
        <Button variant="quiet" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          busy={busy}
          disabled={!canCreate}
          disabledReason={
            mode === "import"
              ? !source.trim()
                ? `Paste a ${spec.label} file, or choose one from disk.`
                : oversize
                  ? OVERSIZE_FIX
                  : (parsed?.error ?? "That file could not be read — see the message above.")
              : mode === "blank"
                ? "Give the project a name first."
                : "Pick a blueprint."
          }
          onClick={create}
          icon={<ArrowRight className="h-3.5 w-3.5" />}
        >
          {mode === "import" ? "Import and review" : "Create project"}
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
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "rounded-card border bg-bg2 p-4 text-left transition-colors duration-[var(--dur-fast)]",
        active ? "border-signal/60 ring-1 ring-signal/25" : "border-line hover:border-line-strong"
      )}
    >
      <span className={cx("inline-flex", active ? "text-signal" : "text-ink-mute")}>{icon}</span>
      <h4 className="mt-2 text-[14px] font-medium text-ink">{title}</h4>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-mute">{body}</p>
    </button>
  );
}
