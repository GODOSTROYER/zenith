"use client";
import { useDeferredValue, useMemo, useState } from "react";
import {
  Boxes,
  CalendarClock,
  Cpu,
  Globe,
  Sparkles,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PlanFirst } from "@/components/inspector/plan-first";
import { useProjectData } from "@/components/shell/project-context";
import { useShell } from "@/components/shell/shell-context";
import { ErrorNote } from "@/components/screens/shared";
import { useJson } from "@/lib/client/api";
import { importDockerfile } from "@/lib/importers/dockerfile";
import { importTerraform } from "@/lib/importers/terraform";
import { uniqueName, type ImportReport } from "@/lib/importers/types";
import { ImportReportView } from "@/components/screens/import-report";
import type { Manifest } from "@/lib/domain/types";
import type { DiscoveredResource } from "@/lib/providers/types";
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

type Format = "compose" | "terraform" | "dockerfile" | "live";

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

/** Wire shape of GET /api/connections/:id/discover. */
interface DiscoverResponse {
  simulated: boolean;
  resources: DiscoveredResource[];
  /** hidden because this project already references them */
  alreadyReferenced: number;
  provider: { id: string; displayName: string; availability: string };
  region: string;
}

const KIND_WORD: Record<string, string> = {
  postgres: "database",
  redis: "cache",
  object_store: "bucket",
  queue: "queue",
  email: "email sender",
};

/**
 * Adopt resources that already exist where a connection points.
 *
 * This is the one importer whose input is not a file the user pasted, so it
 * carries an extra honesty burden: it says which account or endpoint it looked
 * in, whether the answer was measured or invented, and — before anything is
 * ticked — that adopting is referencing, not taking over. A provider that
 * cannot look answers with a refusal, which is rendered rather than hidden.
 */
function LiveResourceImport({ onClose }: { onClose: () => void }) {
  const { project, selectedEnv } = useProjectData();
  const { boot } = useShell();
  const connections = boot?.connections ?? [];
  const [connectionId, setConnectionId] = useState(
    selectedEnv?.connectionId ?? connections[0]?.id ?? ""
  );
  const [picked, setPicked] = useState<string[]>([]);

  const found = useJson<DiscoverResponse>(
    connectionId
      ? `/api/connections/${connectionId}/discover?projectId=${encodeURIComponent(project.id)}`
      : null
  );

  const resources = found.data?.resources ?? [];
  // A tick left over from another connection simply does not match, so there is
  // nothing to reset — and the action re-checks every reference server-side.
  const selected = resources.filter((r) => picked.includes(r.externalRef));

  const toggle = (ref: string, on: boolean) =>
    setPicked((p) => (on ? [...p, ref] : p.filter((x) => x !== ref)));

  if (!connections.length)
    return (
      <EmptyState
        title="No connections yet"
        body="Zenith.ai looks for existing resources through a cloud connection. Add one in Settings → Connections, then come back."
      />
    );

  return (
    <div className="space-y-3">
      {connections.length > 1 && (
        <Field label="Look in">
          <Select
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setPicked([]);
            }}
            options={connections.map((c) => ({ value: c.id, label: `${c.label} (${c.region})` }))}
          />
        </Field>
      )}

      {found.error ? (
        <ErrorNote error={found.error} />
      ) : found.loading && !found.data ? (
        <Skeleton height={96} />
      ) : (
        <>
          {found.data && (
            <Callout tone={found.data.simulated ? "info" : "ok"} compact>
              {found.data.simulated
                ? `${found.data.provider.displayName} has no real account to read, so this list is invented — a demonstration of what discovery looks like. Imported references carry a "sim://" prefix so they stay recognisable.`
                : `Read from ${found.data.provider.displayName} in ${found.data.region}. These resources really exist.`}
              {found.data.alreadyReferenced > 0 &&
                ` ${found.data.alreadyReferenced} already referenced by this project ${found.data.alreadyReferenced === 1 ? "is" : "are"} not listed.`}
            </Callout>
          )}

          {resources.length === 0 ? (
            <EmptyState
              title="Nothing new to import"
              body={
                found.data?.alreadyReferenced
                  ? "Everything found here is already referenced by this project."
                  : "Nothing was found where this connection points."
              }
            />
          ) : (
            <ul className="max-h-[260px] space-y-1.5 overflow-y-auto">
              {resources.map((r) => (
                <li key={r.externalRef}>
                  <Checkbox
                    checked={picked.includes(r.externalRef)}
                    onChange={(on) => toggle(r.externalRef, on)}
                    label={
                      <span className="flex items-baseline gap-2">
                        <span className="text-[13px] font-medium text-ink">{r.name}</span>
                        <Chip tone="neutral">{KIND_WORD[r.kind] ?? r.kind}</Chip>
                      </span>
                    }
                    help={<span className="font-mono text-[11.5px]">{r.externalRef}</span>}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="text-[12.5px] leading-relaxed text-ink-mute">
        Imported resources are marked <span className="text-ink">referenced</span>: Zenith.ai draws
        them on the map and lets services bind to them, but never provisions, changes or deletes
        them — and they add nothing to the cost estimate.
      </p>

      <div className="border-t border-line pt-3">
        <PlanFirst
          actionId="project.importResources"
          input={{ connectionId, resources: selected }}
          label={`Preview import${selected.length ? ` (${selected.length})` : ""}`}
          disabled={!selected.length}
          disabledReason="Tick at least one resource to import."
          onDone={onClose}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

/**
 * Import from any of the shipped importers. Compose has its own action (it can
 * create a project); Terraform and Dockerfile produce a manifest that is merged
 * into the working copy through project.updateManifest — the same plan-first,
 * audited path, and the same diff preview.
 */
export function ImportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { project, manifestHash } = useProjectData();
  const [format, setFormat] = useState<Format>("compose");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [report, setReport] = useState<ImportReport>();

  // "live" has no file behind it, so it borrows a spec it never reads.
  const spec = FORMATS.find((f) => f.value === format) ?? FORMATS[0];

  // Terraform and Dockerfile parse in the browser, so the dialog knows what the
  // file became before the plan is even requested. It used to re-parse and
  // re-merge the whole manifest on every keystroke; deferring lets the textarea
  // stay responsive while a paste of a real .tf file settles.
  const deferredText = useDeferredValue(text);

  const parsed = useMemo(() => {
    if (format === "compose" || !deferredText.trim()) return undefined;
    try {
      const out =
        format === "terraform"
          ? importTerraform(deferredText)
          : importDockerfile(deferredText, fileName?.replace(/\.[^.]+$/, "") || project.name, project.id);
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
  }, [format, deferredText, fileName, project.workingManifest, project.name, project.id]);

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
        description="Exact means a faithful translation. Assumed means Zenith.ai had to guess — check those."
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
      description="Everything Zenith.ai cannot map is listed with a reason, never dropped silently."
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
          options={[
            ...FORMATS.map((f) => ({ value: f.value, label: f.label, title: f.title })),
            {
              value: "live" as const,
              label: "existing",
              title:
                "Resources that already exist where a connection points — imported as referenced, never taken over.",
            },
          ]}
        />
        {format !== "live" && (
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
        )}
      </div>

      {format === "live" ? (
        <div className="mt-3">
          <LiveResourceImport onClose={close} />
        </div>
      ) : (
        <>
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
      {parsed?.error && (
        <Callout tone="err" compact className="mt-2">
          {parsed.error}
        </Callout>
      )}

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
            /*
             * The merge above was computed against this exact working copy. If
             * someone saved in between, the import would silently drop their
             * change — so send the token and let the server refuse instead.
             */
            input={{ manifest: parsed?.manifest, expectedHash: manifestHash }}
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
        </>
      )}
    </Dialog>
  );
}
