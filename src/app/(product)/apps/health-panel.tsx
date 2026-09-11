/**
 * Health: what a real probe found when it asked this app, which release it was
 * asking, and what the app's own records say happened in the last day.
 *
 * The `simulated` label appears when — and only when — the payload says the
 * result was generated rather than measured. A screen that shows a green tick
 * for a check nobody ran is the failure mode this panel exists to prevent.
 */
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { TimeAgo } from "@/components/ui/time-ago";
import { ErrorNote, SimulatedChip } from "@/components/screens/shared";
import type { HostedHealth } from "@/lib/client/hosted";
import { checkTitle } from "./labels";
import { fmtCount } from "./limits";

export interface HealthPanelProps {
  health: HostedHealth | null | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

/** The digest counts, in the order a builder cares about them. */
const COUNTS = [
  { key: "writes", label: "records written" },
  { key: "conflicts", label: "editing conflicts" },
  { key: "denials", label: "requests refused" },
  { key: "errors", label: "errors" },
] as const;

export function HealthPanel({ health, loading, error, onRetry, className }: HealthPanelProps) {
  if (error && !health)
    return (
      <div className={className}>
        <ErrorNote error={error} />
        {onRetry && (
          <Button className="mt-3" size="sm" variant="quiet" onClick={onRetry}>
            Check again
          </Button>
        )}
      </div>
    );

  if (loading && !health)
    return (
      <div className={className}>
        <Skeleton height={14} width="35%" />
        <Skeleton className="mt-2" height={12} />
        <Skeleton className="mt-2" height={12} width="70%" />
      </div>
    );

  if (!health)
    return (
      <p className={className}>
        <span className="text-[13px] text-ink-mute">
          No health check has run for this app yet. One runs with every publish, and again whenever
          you open this section.
        </span>
      </p>
    );

  const events = health.lastEvents;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot status={health.ok ? "ok" : "err"} />
        <span className="text-[13px] text-ink">
          {health.ok ? "Every check passed" : "Something is failing"}
        </span>
        {health.simulated ? (
          <SimulatedChip title="These results were generated, not measured against a running app." />
        ) : (
          <Chip tone="ok" title="These results come from checks actually run against this app.">
            measured
          </Chip>
        )}
        <span className="text-[12.5px] text-ink-mute">
          <TimeAgo iso={health.checkedAt} prefix="checked" />
        </span>
        {onRetry && (
          <Button size="sm" variant="quiet" onClick={onRetry}>
            Check again
          </Button>
        )}
      </div>

      <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
        {health.release ? (
          <>
            These checks ran against release {health.release.number} (build fingerprint{" "}
            <span className="font-mono text-ink">{health.release.digest.slice(0, 12)}</span>). Every
            response the app serves carries that release id in an{" "}
            <span className="font-mono">x-zenith-release</span> header, so a reply can always be
            traced back to the version that produced it.
          </>
        ) : (
          <>
            Nothing is serving this app yet, so there is no release to attribute these results to.
          </>
        )}
      </p>

      {health.checks.length === 0 ? (
        <Callout tone="warn" compact className="mt-3">
          <p>The check ran but reported nothing, so there is no result to read.</p>
        </Callout>
      ) : (
        <ul className="mt-4 space-y-2">
          {health.checks.map((check) => (
            <li key={check.id} className="flex gap-2.5">
              <StatusDot status={check.ok ? "ok" : "err"} className="mt-1.5" />
              <div className="min-w-0">
                <p className="text-[13px] text-ink">{checkTitle(check.id)}</p>
                <p className="mt-0.5 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                  {check.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {events && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
            What the app recorded
          </p>
          <p className="mt-1 text-[13px] text-ink">
            {events.total === 0 ? (
              <>
                Nothing recorded since <TimeAgo iso={events.since} />. Either nobody used the app, or
                nothing it does is worth recording.
              </>
            ) : (
              <>
                {fmtCount(events.total)} events since <TimeAgo iso={events.since} />.
              </>
            )}
          </p>
          {events.total > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-mute">
              {COUNTS.map(({ key, label }) => (
                <li key={key}>
                  <span className="tnum text-ink">{fmtCount(events[key])}</span> {label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
