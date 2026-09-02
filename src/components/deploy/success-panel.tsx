"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Gauge, Globe, ScrollText } from "lucide-react";
import { Button, Chip, CopyButton, StatusDot, type DotStatus } from "@/components/ui";
import { OrbitMark } from "@/components/shell/wordmark";
import { useProjectData } from "@/components/shell/project-context";
import { useShell } from "@/components/shell/shell-context";
import { useJson } from "@/lib/client/api";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { cx, fmtUsd } from "@/lib/format";
import type { Deployment, Output, Revision } from "@/lib/domain/types";
import { copyTarget, isSimulated, openLabel } from "./output-link";

interface HealthPayload {
  simulated: boolean;
  services: Record<
    string,
    { status: "ok" | "degraded"; replicasReady: number; replicasDesired: number; latencyMs: number }
  >;
}

/** `web — https://web--staging.atlas.orrery.app` → the two halves. */
function splitLabel(label: string): { name: string; pretty: string } {
  const at = label.indexOf(" — ");
  if (at < 0) return { name: label, pretty: label };
  return { name: label.slice(0, at), pretty: label.slice(at + 3) };
}

/**
 * Claims the one-time celebration. Side effect — never call this while
 * rendering: StrictMode double-invokes render, which would burn the flag
 * before anything reached the screen. Effects only.
 */
function claimFirstLiveEver(projectId: string): boolean {
  const key = `orrery-first-live-${projectId}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, new Date().toISOString());
    return true;
  } catch {
    return false; // no storage, no celebration — never a broken panel
  }
}

function OutputRow({
  output,
  simulated: envSimulated,
}: {
  output: Output;
  simulated: boolean | undefined;
}) {
  const { name, pretty } = splitLabel(output.label);
  const isUrl = output.kind === "url";
  const simulated = isSimulated(output, envSimulated);
  const copy = copyTarget(output, simulated);
  return (
    <li className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
      <Globe className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">{name}</p>
        <p className="truncate font-mono text-[12px] text-ink-mute" title={pretty}>
          {pretty}
        </p>
      </div>
      <CopyButton value={copy.value} what={copy.what} label={simulated ? "Copy link" : "Copy"} />
      {isUrl && (
        <span className="flex shrink-0 items-center gap-1.5">
          {/* The address above is a pretty fake whenever the sandbox produced
              it. Until the workspace payload says which provider that was, the
              honest label is "checking" — never the unqualified "Open". */}
          {simulated !== false && (
            <Chip
              title={
                simulated
                  ? `${pretty} does not exist on the internet. Open shows a local preview of this service, served by the sandbox provider.`
                  : "Checking which provider produced this address."
              }
            >
              {simulated ? "simulated" : "checking…"}
            </Chip>
          )}
          <a
            href={output.value}
            target="_blank"
            rel="noreferrer"
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-ctl border border-transparent bg-signal px-2.5",
              "text-[12.5px] font-medium text-on-signal hover:bg-signal-strong",
              "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]"
            )}
          >
            {openLabel(simulated)}
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </span>
      )}
    </li>
  );
}

export function SuccessPanel({
  deployment,
  onAddRoute,
}: {
  deployment: Deployment;
  onAddRoute: () => void;
}) {
  const { project, selectedEnv, changesets } = useProjectData();
  const { boot } = useShell();
  // Only ever flips on: StrictMode's second pass finds the flag already burned
  // and leaves the celebration that is currently on screen alone.
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (claimFirstLiveEver(project.id)) setCelebrate(true);
  }, [project.id]);
  // Health is keyed on the environment, not on a revision id the project
  // payload has not polled yet: this panel only renders after a deployment
  // succeeded, so the first fetch can go out immediately.
  const { data: health } = useJson<HealthPayload>(
    `/api/health/${deployment.environmentId}`,
    10_000
  );

  // What this environment now runs — the deployed revision, not the working
  // copy that may already have moved on.
  const { data: deployed } = useJson<{ revision: Revision }>(
    `/api/revisions/${deployment.revisionId}`
  );

  // Only the sandbox provider hands out addresses that do not exist; a real
  // provider's URL must never be labeled simulated. `undefined` until the
  // workspace payload lands, so the panel never claims either way too early.
  const simulated = boot
    ? boot.connections.find((c) => c.id === selectedEnv?.connectionId)?.provider === "sandbox"
    : undefined;

  const urls = deployment.outputs.filter((o) => o.kind === "url");
  const others = deployment.outputs.filter((o) => o.kind !== "url");
  const liveCost = deployed ? monthlyCostUsd(deployed.revision.manifest) : undefined;
  const pending = changesets[deployment.environmentId];
  // Only once the project payload agrees this revision is the live one; until
  // then its changeset still counts the changes this deployment just applied.
  const settled = selectedEnv?.deployedRevisionId === deployment.revisionId;
  const pendingCount = settled ? (pending?.items.length ?? 0) : 0;
  const services = deployed?.revision.manifest.services ?? project.workingManifest.services;

  return (
    <div className="animate-enter space-y-5">
      <div className="flex items-center gap-3">
        <OrbitMark size={36} draw={celebrate} className="text-signal" />
        <div>
          <h2 className="text-[40px] leading-none font-medium tracking-[-0.02em] text-ink">
            Live.
          </h2>
          <p className="mt-1.5 text-[13px] text-ink-mute">
            {deployment.changeSummary} on {selectedEnv?.name ?? "this environment"}
            {simulated ? " · simulated environment" : ""}.
          </p>
        </div>
      </div>

      {urls.length > 0 ? (
        <ul className="overflow-hidden rounded-card border border-line bg-bg1">
          {urls.map((o) => (
            <OutputRow key={o.key} output={o} simulated={simulated} />
          ))}
        </ul>
      ) : (
        <p className="rounded-card border border-line bg-bg1 px-4 py-3 text-[13px] text-ink-mute">
          Nothing in this system answers HTTP, so there is no address to open. Publish a route to
          give it a public front door.
        </p>
      )}

      {others.length > 0 && (
        <ul className="overflow-hidden rounded-card border border-line bg-bg1">
          {others.map((o) => (
            <li
              key={o.key}
              className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-mute">
                {o.label}
              </span>
              <CopyButton value={o.value} what="the value" label="Copy" />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {health?.services &&
          Object.entries(health.services).map(([serviceId, h]) => {
            const name = services.find((s) => s.id === serviceId)?.name ?? serviceId;
            const dot: DotStatus = h.status === "ok" ? "ok" : "warn";
            return (
              <Chip
                key={serviceId}
                tone={h.status === "ok" ? "ok" : "warn"}
                icon={<StatusDot status={dot} size={6} />}
                title={`${h.replicasReady}/${h.replicasDesired} ready · ${h.latencyMs}ms — simulated health.`}
              >
                {name} {h.replicasReady}/{h.replicasDesired}
              </Chip>
            );
          })}
        <span className="tnum ml-auto text-right font-mono text-[12.5px] text-ink-mute">
          {liveCost === undefined ? (
            <span className="text-ink-faint">pricing this revision…</span>
          ) : (
            <>
              live {fmtUsd(liveCost)}
              <span className="text-ink-faint">/mo est.</span>
            </>
          )}
          {/* The working copy is a different system from the one that just
              went live; its cost is never folded into the number above. */}
          {pendingCount > 0 && (
            <span className="block text-[11.5px] text-ink-faint">
              working copy {fmtUsd(pending.totalCostDeltaUsd, { sign: true })}/mo in {pendingCount}{" "}
              pending change{pendingCount === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="text-[12px] font-medium tracking-[0.04em] text-ink-faint uppercase">Next</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="quiet"
            icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={onAddRoute}
          >
            Add a custom domain
          </Button>
          <Link href={`/p/${project.slug}/observe`}>
            <Button
              size="sm"
              variant="quiet"
              icon={<ScrollText className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              Watch the logs
            </Button>
          </Link>
          <Link href={`/p/${project.slug}/settings`}>
            <Button
              size="sm"
              variant="quiet"
              icon={<Gauge className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {selectedEnv?.policies.budgetUsdMonthly
                ? "Review the budget"
                : "Set a monthly budget"}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
