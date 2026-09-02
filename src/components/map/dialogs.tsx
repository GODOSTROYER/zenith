"use client";
import { useMemo, useState } from "react";
import {
  Boxes,
  CalendarClock,
  CircleDashed,
  Cpu,
  Globe,
  Sparkles,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Button, Chip, Dialog, SegmentedControl } from "@/components/ui";
import { PlanFirst } from "@/components/inspector/plan-first";
import { useProjectData } from "@/components/shell/project-context";
import { importDockerfile, importTerraform } from "@/lib/importers";
import { uniqueName, type ImportReport } from "@/lib/importers/types";
import type { Manifest } from "@/lib/domain/types";
import { cx } from "@/lib/format";

/** Blueprint catalog metadata, handed down from the server component. */
export interface BlueprintCard {
  id: string;
  name: string;
  description: string;
  icon: string;
  highlights: string[];
}

const ICONS: Record<string, LucideIcon> = {
  Boxes,
  Cpu,
  Globe,
  Sparkles,
  Wrench,
  CalendarClock,
};

export function BlueprintDialog({
  open,
  onClose,
  blueprints,
}: {
  open: boolean;
  onClose: () => void;
  blueprints: BlueprintCard[];
}) {
  const [picked, setPicked] = useState<string>("");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      title="Start from a blueprint"
      description="An opinionated starting system. Everything in it is ordinary and editable afterwards."
    >
      <div className="space-y-2">
        {blueprints.map((b) => {
          const Icon = ICONS[b.icon] ?? Boxes;
          const active = picked === b.id;
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={active}
              onClick={() => setPicked(b.id)}
              className={cx(
                "flex w-full items-start gap-3 rounded-card border p-3 text-left",
                "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
                active
                  ? "border-signal bg-signal-dim"
                  : "border-line bg-bg1 hover:border-line-strong"
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-mute" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-ink">{b.name}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-mute">{b.description}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {b.highlights.map((h) => (
                    <Chip key={h}>{h}</Chip>
                  ))}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <PlanFirst
          actionId="project.applyBlueprint"
          input={{ blueprint: picked }}
          label="Apply blueprint"
          disabled={!picked}
          disabledReason="Pick a blueprint first."
          onDone={onClose}
          onCancel={onClose}
        />
      </div>
    </Dialog>
  );
}

/* --------------------------------- import --------------------------------- */

type Format = "compose" | "terraform" | "dockerfile";

const FORMATS: {
  value: Format;
  label: string;
  title: string;
  accept: string;
  /** what the box wants, and what it honestly does with it */
  prompt: string;
  sample: string;
}[] = [
  {
    value: "compose",
    label: "compose",
    title: "docker-compose.yml — services, resources and the links between them.",
    accept: ".yml,.yaml,text/yaml,application/x-yaml,text/plain",
    prompt: "Services, images, ports and depends_on all translate. Volumes and build args do not.",
    sample: `services:
  web:
    image: ghcr.io/acme/web:1.0.0
    ports: ["3000:3000"]
  db:
    image: postgres:16`,
  },
  {
    value: "terraform",
    label: "terraform",
    title: "A .tf file — recognised resources are imported as referenced, never provisioned.",
    accept: ".tf,.hcl,text/plain",
    prompt:
      "A text scan, not an HCL parse: modules, variables and count/for_each are not evaluated. What it recognises is imported as 'referenced' — read, never changed.",
    sample: `resource "aws_db_instance" "primary" {
  engine = "postgres"
}

resource "aws_s3_bucket" "assets" {}`,
  },
  {
    value: "dockerfile",
    label: "dockerfile",
    title: "A Dockerfile — one image, so one web service.",
    accept: "text/plain,.dockerfile",
    prompt:
      "One Dockerfile describes one image, so this produces exactly one web service. Build instructions stay in your Dockerfile.",
    sample: `FROM node:22-alpine
EXPOSE 3000
CMD ["node", "server.js"]`,
  },
];

/**
 * Append an imported manifest to the working one, renaming anything whose name
 * is already taken. Importing never silently replaces what is already on the
 * map — the plan preview shows the whole diff before any of it is applied.
 */
export function mergeImport(
  current: Manifest,
  incoming: Manifest
): { manifest: Manifest; renamed: string[] } {
  const taken = [
    ...current.services.map((s) => s.name),
    ...current.resources.map((r) => r.name),
  ];
  const renamed: string[] = [];

  const rename = <T extends { name: string }>(node: T): T => {
    const name = uniqueName(node.name, taken);
    taken.push(name);
    if (name !== node.name) renamed.push(`${node.name} → ${name}`);
    return { ...node, name };
  };

  return {
    manifest: {
      ...current,
      services: [...current.services, ...incoming.services.map(rename)],
      resources: [...current.resources, ...incoming.resources.map(rename)],
      routes: [...current.routes, ...incoming.routes],
      bindings: [...current.bindings, ...incoming.bindings],
    },
    renamed,
  };
}

/**
 * Import from any of the shipped importers. Compose has its own action (it can
 * create a project); Terraform and Dockerfile produce a manifest that is merged
 * into the working copy through project.updateManifest — the same plan-first,
 * audited path, and the same diff preview.
 */
export function ImportComposeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { project } = useProjectData();
  const [format, setFormat] = useState<Format>("compose");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [report, setReport] = useState<ImportReport>();

  const spec = FORMATS.find((f) => f.value === format)!;

  // Terraform and Dockerfile parse in the browser, so the dialog knows what the
  // file became before the plan is even requested.
  const parsed = useMemo(() => {
    if (format === "compose" || !text.trim()) return undefined;
    try {
      const out =
        format === "terraform"
          ? importTerraform(text)
          : importDockerfile(text, fileName?.replace(/\.[^.]+$/, "") || project.name);
      const { manifest, renamed } = mergeImport(project.workingManifest, out.manifest);
      return {
        manifest,
        report: {
          ...out.report,
          warnings: renamed.length
            ? [
                ...out.report.warnings,
                `Renamed to avoid clashing with what is already here: ${renamed.join(", ")}.`,
              ]
            : out.report.warnings,
        },
        error: undefined as string | undefined,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [format, text, fileName, project.workingManifest, project.name]);

  const reset = () => {
    setText("");
    setFileName(undefined);
    setReport(undefined);
  };

  const close = () => {
    reset();
    onClose();
  };

  if (report)
    return (
      <Dialog
        open={open}
        onClose={close}
        width={620}
        title="What was imported"
        description="Exact means a faithful translation. Assumed means Orrery had to guess — check those."
      >
        <ImportReportView report={report} />
        <div className="mt-4 border-t border-line pt-3">
          <Button size="sm" onClick={close}>
            Back to the map
          </Button>
        </div>
      </Dialog>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      width={620}
      title="Import into this system"
      description="Everything Orrery cannot map is listed with a reason, never dropped silently."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<Format>
          size="sm"
          label="Import format"
          value={format}
          onChange={(f) => {
            setFormat(f);
            reset();
          }}
          options={FORMATS.map((f) => ({ value: f.value, label: f.label, title: f.title }))}
        />
        <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-ctl border border-line px-2.5 text-[12.5px] text-ink-mute transition-colors duration-[120ms] hover:border-line-strong hover:text-ink">
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          Choose a file
          <input
            type="file"
            accept={spec.accept}
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setText(await file.text());
              setFileName(file.name);
            }}
          />
        </label>
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mute">{spec.prompt}</p>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFileName(undefined);
        }}
        spellCheck={false}
        rows={12}
        placeholder={spec.sample}
        aria-label={`${spec.label} contents`}
        className={cx(
          "mt-2 w-full resize-y rounded-ctl border border-line bg-bg1 p-3 font-mono text-[12.5px] text-ink",
          "outline-none placeholder:text-ink-faint focus:border-signal",
          "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]"
        )}
      />
      {fileName && (
        <p className="mt-1.5 text-[12px] text-ink-mute">
          Loaded <span className="font-mono text-ink">{fileName}</span> — editable above.
        </p>
      )}
      {parsed?.error && <p className="mt-2 text-[12.5px] text-err">{parsed.error}</p>}

      <div className="mt-3 border-t border-line pt-3">
        {format === "compose" ? (
          <PlanFirst
            actionId="project.importCompose"
            input={{ composeYaml: text }}
            label="Preview import"
            disabled={!text.trim()}
            disabledReason="Paste a compose file, or choose one from disk."
            onDone={(result) => {
              const r = (result.data as { report?: ImportReport } | undefined)?.report;
              if (r) setReport(r);
              else close();
            }}
            onCancel={close}
          />
        ) : (
          <PlanFirst
            actionId="project.updateManifest"
            input={{ manifest: parsed?.manifest }}
            label="Preview import"
            disabled={!text.trim() || !parsed?.manifest}
            disabledReason={
              !text.trim()
                ? `Paste a ${spec.label} file, or choose one from disk.`
                : (parsed?.error ?? "That file could not be read — see the message above.")
            }
            onDone={() => setReport(parsed?.report)}
            onCancel={close}
          />
        )}
      </div>
    </Dialog>
  );
}

/**
 * The import report, in dialog proportions. Onboarding shows the same three
 * lists at full width; the same import must explain itself in both places.
 */
function ImportReportView({ report }: { report: ImportReport }) {
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {report.mapped.map((m) => (
          <li key={m.source} className="flex items-start gap-2.5">
            <Chip tone={m.confidence === "exact" ? "ok" : "warn"} className="mt-0.5">
              {m.confidence}
            </Chip>
            <div className="min-w-0">
              <p className="font-mono text-[12.5px] text-ink">
                {m.source} <span className="text-ink-faint">→</span> {m.result}
              </p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">{m.note}</p>
            </div>
          </li>
        ))}
      </ul>

      {report.unmapped.length > 0 && (
        <div className="border-t border-line pt-3">
          <h3 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
            {report.unmapped.length} not imported
          </h3>
          <ul className="mt-2 space-y-1.5">
            {report.unmapped.map((u) => (
              <li key={u.source} className="flex items-start gap-2.5">
                <CircleDashed className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <div className="min-w-0">
                  <p className="font-mono text-[12.5px] text-ink">{u.source}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">{u.reason}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-signal">{u.suggestion}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.warnings.length > 0 && (
        <ul className="space-y-1.5 rounded-ctl border border-warn/30 bg-warn-dim px-3 py-2.5 text-[12.5px] text-ink">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {report.mapped.length === 0 && report.unmapped.length === 0 && (
        <p className="text-[12.5px] text-ink-faint">
          The importer produced no mapping detail for this file.
        </p>
      )}
    </div>
  );
}
