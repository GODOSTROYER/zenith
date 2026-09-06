/**
 * One output of a deployment.
 *
 * `label` is the pretty hostname; `value` is the href that actually works —
 * but only for `url` outputs. A connection string is "postgres.staging…:5432"
 * with no scheme: as an href the browser resolves it against this app and
 * lands on a 404, so a connection gets Copy and nothing else.
 */
import { ExternalLink } from "lucide-react";
import type { Output } from "@/lib/domain/types";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { copyTarget, isSimulated, openLabel } from "@/components/deploy/output-link";

export interface OutputRowProps {
  output: Output;
  /** undefined until the workspace payload lands — unknown is not "real" */
  envSimulated: boolean | undefined;
}

export function OutputRow({ output, envSimulated }: OutputRowProps) {
  const pretty = output.label.includes(" — ")
    ? output.label.slice(output.label.indexOf(" — ") + 3)
    : output.label;
  const isUrl = output.kind === "url";
  const simulated = isSimulated(output, envSimulated);
  const copy = copyTarget(output, simulated);

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="break-words font-mono text-[12.5px] text-ink">{output.label}</p>
        <p className="text-[12px] text-ink-mute">{output.kind}</p>
      </div>
      {simulated !== false && (
        <Chip
          title={
            simulated && isUrl
              ? `${pretty} does not exist on the internet. Open shows a local preview served by the sandbox provider.`
              : simulated
                ? "This is a simulated provider output. It does not identify verified live infrastructure."
                : "Checking which provider produced this output."
          }
        >
          {simulated ? "simulated" : "checking…"}
        </Chip>
      )}
      <CopyButton value={copy.value} what={copy.what} size="sm" variant="ghost" />
      {isUrl && (
        <a
          href={output.value}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-ctl border border-line bg-bg2 px-2.5 text-[12.5px] text-ink hover:border-line-strong"
        >
          {openLabel(simulated)}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </li>
  );
}
