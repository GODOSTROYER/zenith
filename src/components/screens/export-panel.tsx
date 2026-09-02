"use client";
/**
 * The no-lock-in surface: everything Orrery generated for an environment, as
 * files you can read, copy and take with you. Rendered on Source → Export and
 * again on Settings → Export.
 */
import { useMemo, useState } from "react";
import { Download, FileCode2 } from "lucide-react";
import { useJson } from "@/lib/client/api";
import type { Manifest } from "@/lib/domain/types";
import { Button, Card, Chip, CodeBlock, EmptyState, Skeleton } from "@/components/ui";
import { useShell } from "@/components/shell/shell-context";
import { ErrorNote } from "./shared";

interface ExportFile {
  path: string;
  content: string;
}

interface ExportResponse {
  files: ExportFile[];
  readme: string;
  provider: string;
  source:
    | { kind: "revision"; revisionId: string; number: number }
    | { kind: "working"; note: string };
}

/**
 * Every generated file in one plain-text file. No zip dependency, and nothing
 * to unpack blindly: the separators are readable and the paths are the real
 * ones, so splitting it back up is a text operation.
 */
function bundleText(files: ExportFile[], readme: string, envName: string): string {
  const rule = (path: string) => `\n\n${"=".repeat(72)}\n===== ${path}\n${"=".repeat(72)}\n\n`;
  const head =
    `Orrery export — ${envName}\n` +
    `Generated ${new Date().toISOString()}\n` +
    `${files.length} file${files.length === 1 ? "" : "s"}, concatenated. Each one starts at its\n` +
    `"===== <path>" marker below; split on those markers to get the tree back.\n`;
  return (
    head +
    rule("README.md") +
    readme +
    files.map((f) => rule(f.path) + f.content).join("") +
    "\n"
  );
}

/** Hand the browser a file without a zip dependency: one Blob per download. */
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.split("/").pop() || "file.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ExportPanelProps {
  environmentId: string | undefined;
  environmentName?: string;
  /** offered as an extra download alongside the provider bundle */
  workingManifest?: Manifest;
}

export function ExportPanel({
  environmentId,
  environmentName,
  workingManifest,
}: ExportPanelProps) {
  const { data, error, loading } = useJson<ExportResponse>(
    environmentId ? `/api/environments/${environmentId}/export` : null
  );
  const { boot } = useShell();
  const [open, setOpen] = useState<string | null>(null);

  const files = useMemo(() => data?.files ?? [], [data]);
  const provider = boot?.providers.find((p) => p.id === data?.provider);

  if (!environmentId)
    return (
      <EmptyState
        icon={<FileCode2 className="h-5 w-5" />}
        title="Pick an environment"
        body="Exports are per environment — each one has its own region, connection and hostnames."
      />
    );

  if (error) return <ErrorNote error={error} />;

  if (loading && !data)
    return (
      <div className="space-y-3">
        <Skeleton height={18} width="40%" />
        <Skeleton height={120} />
      </div>
    );

  if (!data) return null;

  const sourceLabel =
    data.source.kind === "revision"
      ? `Describes revision r${data.source.number} — what is live in ${environmentName ?? "this environment"}.`
      : data.source.note;

  const providerName = provider?.displayName ?? data.provider;
  /** Whether Orrery can run these files itself, said plainly. */
  const applicability = !provider
    ? `Generated for "${data.provider}". This server did not report that provider's status, so whether Orrery can apply these files is unknown — running them yourself always works.`
    : provider.availability === "available"
      ? `${providerName} is available in Orrery: it applies these files itself when you deploy. Running them with your own tooling gets you the same system.`
      : provider.availability === "preview"
        ? `${providerName} is Preview in Orrery: it plans and generates these files but does not apply them. Run them yourself, with your own credentials.`
        : `${providerName} is planned, not implemented. These files describe the system; nothing in Orrery applies them.`;

  return (
    <div className="space-y-4">
      <Card
        title="Take it with you"
        subtitle={sourceLabel}
        actions={
          <>
            <Chip tone="neutral">{providerName}</Chip>
            {provider && provider.availability !== "available" && (
              <Chip tone={provider.availability === "preview" ? "warn" : "neutral"}>
                {provider.availability}
              </Chip>
            )}
          </>
        }
      >
        <p className="text-[13px] text-ink-mute">
          These are the real files for this system: run them with your own tooling and Orrery
          stops being required. Nothing here calls back to us.
        </p>
        <p className="mt-2 text-[12.5px] text-ink-mute">{applicability}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            icon={<Download className="h-3.5 w-3.5" />}
            title={`All ${files.length + 1} files in one text file, split by "===== <path>" markers`}
            onClick={() =>
              download(
                `orrery-${(environmentName ?? "environment").toLowerCase().replace(/\s+/g, "-")}-bundle.txt`,
                bundleText(files, data.readme, environmentName ?? "this environment")
              )
            }
          >
            Download all {files.length + 1} files
          </Button>
          <Button
            variant="quiet"
            icon={<Download className="h-3.5 w-3.5" />}
            onClick={() => download("README.md", data.readme)}
          >
            README.md
          </Button>
          {workingManifest && (
            <Button
              variant="quiet"
              icon={<Download className="h-3.5 w-3.5" />}
              onClick={() =>
                download("orrery.manifest.json", JSON.stringify(workingManifest, null, 2))
              }
            >
              Manifest JSON
            </Button>
          )}
        </div>
        <p className="mt-2 text-[12px] text-ink-faint">
          One file, concatenated — no zip, so there is nothing to unpack before you can read it.
        </p>
      </Card>

      <CodeBlock code={data.readme} title="README.md" maxHeight={340} wrap />

      <div className="space-y-3">
        <h3 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          {files.length} generated file{files.length === 1 ? "" : "s"}
        </h3>
        {files.map((f) => {
          const isOpen = open === f.path;
          return (
            <div key={f.path} className="overflow-hidden rounded-card border border-line bg-bg2">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : f.path)}
                  className="min-w-0 flex-1 text-left font-mono text-[12.5px] text-ink hover:text-signal"
                  aria-expanded={isOpen}
                >
                  {f.path}
                </button>
                <span className="tnum shrink-0 text-[11.5px] text-ink-faint">
                  {f.content.split("\n").length} lines
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  title={`Download ${f.path}`}
                  onClick={() => download(f.path, f.content)}
                  icon={<Download className="h-3.5 w-3.5" />}
                >
                  Save
                </Button>
              </div>
              {isOpen && (
                <div className="animate-enter border-t border-line p-3">
                  <CodeBlock code={f.content} title={f.path} lineNumbers maxHeight={420} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
