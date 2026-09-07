/**
 * What to publish. Two reference apps that are already known to build, or your
 * own `.tar.gz`.
 *
 * The rules under the upload option are the supported-source contract said in
 * plain words, with its real numbers — a builder should learn why an archive
 * was refused before uploading it, not after.
 *
 * Workstream W9 (hosted R3)
 */
import { FileArchive } from "lucide-react";
import { cx } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { RECIPE_V1, SOURCE_LIMITS } from "@/lib/hosted/contracts/source-v1";
import type { FixtureName } from "@/lib/client/hosted";
import { fmtBytes } from "./limits";

export type SourceChoice =
  | { kind: "fixture"; name: FixtureName }
  | { kind: "tarball"; file: File };

export interface SourcePickerProps {
  value: SourceChoice | null;
  onChange: (choice: SourceChoice | null) => void;
  disabled?: boolean;
  className?: string;
}

interface FixtureOption {
  name: FixtureName;
  title: string;
  body: string;
}

const FIXTURES: readonly FixtureOption[] = [
  {
    name: "tracker-app",
    title: "Equipment requests — reference app",
    body: "A working request tracker written against the app data contract. Publish it to see the whole path — build, health checks, private URL — with something real at the end.",
  },
  {
    name: "minimal-app",
    title: "Minimal app",
    body: "One page and nothing else. The quickest way to prove publishing works on this install.",
  },
];

/** The archive itself may not be larger than the ceiling it has to unpack under. */
export const MAX_ARCHIVE_BYTES = SOURCE_LIMITS.maxDecompressedBytes;

/** Why this file cannot be published, or undefined when it can be tried. */
export function archiveProblem(file: File): string | undefined {
  if (!/\.(tar\.gz|tgz)$/i.test(file.name))
    return `${file.name} is not a .tar.gz archive. Pack the project with “tar -czf app.tar.gz -C <folder> .” and choose that file.`;
  if (file.size > MAX_ARCHIVE_BYTES)
    return `${file.name} is ${fmtBytes(file.size)}. The limit is ${fmtBytes(MAX_ARCHIVE_BYTES)} — remove anything that is not source, then pack it again.`;
  if (file.size === 0) return `${file.name} is empty. Pack the project again and choose the new file.`;
  return undefined;
}

const OPTION_CLASS =
  "flex cursor-pointer gap-3 rounded-card border p-4 transition-colors duration-[var(--dur-fast)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-signal";

export function SourcePicker({ value, onChange, disabled = false, className }: SourcePickerProps) {
  const file = value?.kind === "tarball" ? value.file : null;
  const problem = file ? archiveProblem(file) : undefined;

  return (
    <fieldset className={cx("min-w-0 space-y-3", className)} disabled={disabled}>
      <legend className="text-[13px] font-medium text-ink">What do you want to publish?</legend>

      {FIXTURES.map((option) => {
        const picked = value?.kind === "fixture" && value.name === option.name;
        return (
          <label
            key={option.name}
            className={cx(
              OPTION_CLASS,
              picked ? "border-signal bg-signal-dim" : "border-line bg-bg1 hover:border-line-strong",
              disabled && "cursor-not-allowed opacity-55"
            )}
          >
            <input
              type="radio"
              name="publish-source"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--signal)]"
              checked={picked}
              onChange={() => onChange({ kind: "fixture", name: option.name })}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-ink">{option.title}</span>
              <span className="mt-1 block max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                {option.body}
              </span>
            </span>
          </label>
        );
      })}

      <label
        className={cx(
          OPTION_CLASS,
          value?.kind === "tarball"
            ? "border-signal bg-signal-dim"
            : "border-line bg-bg1 hover:border-line-strong",
          disabled && "cursor-not-allowed opacity-55"
        )}
      >
        <input
          type="radio"
          name="publish-source"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--signal)]"
          checked={value?.kind === "tarball"}
          onChange={() => onChange(file ? { kind: "tarball", file } : null)}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <FileArchive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Your own app, as a .tar.gz
          </span>
          <span className="mt-1 block max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
            A React app built with Vite. Zenith builds it with its own pinned toolchain — React{" "}
            {RECIPE_V1.react}, Vite {RECIPE_V1.vite} — so the archive never brings a build of its own
            and nothing inside it is ever run to build it.
          </span>
          <span className="mt-2 block max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
            Send <span className="font-mono">index.html</span>,{" "}
            <span className="font-mono">package.json</span>,{" "}
            <span className="font-mono">zenith.app.json</span> and the{" "}
            <span className="font-mono">src/</span> and <span className="font-mono">public/</span>{" "}
            folders. Build scripts, <span className="font-mono">vite.config</span>, lockfiles,
            dotfiles and any dependency other than react and react-dom are refused. Up to{" "}
            {SOURCE_LIMITS.maxFiles} files, {fmtBytes(SOURCE_LIMITS.maxFileBytes)} each and{" "}
            {fmtBytes(SOURCE_LIMITS.maxTotalBytes)} in total; the archive must unpack to no more than{" "}
            {fmtBytes(SOURCE_LIMITS.maxDecompressedBytes)}.
          </span>

          <input
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            aria-label="Choose a .tar.gz archive"
            className="mt-3 block w-full text-[12.5px] text-ink-mute file:mr-3 file:rounded-ctl file:border file:border-line file:bg-bg2 file:px-2.5 file:py-1.5 file:text-[12.5px] file:text-ink hover:file:bg-bg3"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              onChange(chosen ? { kind: "tarball", file: chosen } : null);
            }}
          />
          {file && !problem && (
            <span className="mt-2 block text-[12.5px] text-ink">
              {file.name} · {fmtBytes(file.size)}
            </span>
          )}
        </span>
      </label>

      {problem && (
        <Callout tone="err" compact>
          <p>{problem}</p>
        </Callout>
      )}
    </fieldset>
  );
}
