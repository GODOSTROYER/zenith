/**
 * What is behind every app in this workspace: the service that answers the
 * private URLs, and the machines that can build what you publish.
 *
 * Both descriptions come from the API and are shown word for word — the
 * runtime names itself, and each build runner states its own isolation
 * boundary. This screen must never soften either one.
 *
 * The API lists every runner it knows about rather than the one it would pick,
 * so this panel reports availability per runner and refuses to imply a build
 * will work when none of them can run.
 */
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { StatusDot } from "@/components/ui/status-dot";
import type { BuilderInfo, RuntimeInfo } from "@/lib/client/hosted";

export interface RuntimeBannerProps {
  runtime: RuntimeInfo;
  builders?: BuilderInfo[];
  buildsPaused?: boolean;
  buildsPausedReason?: string;
  className?: string;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-5 py-4 last:border-b-0 sm:flex-row sm:gap-6">
      <dt className="w-[104px] shrink-0 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
        {term}
      </dt>
      <dd className="min-w-0 flex-1 space-y-3">{children}</dd>
    </div>
  );
}

export function RuntimeBanner({
  runtime,
  builders,
  buildsPaused = false,
  buildsPausedReason,
  className,
}: RuntimeBannerProps) {
  const serving = runtime.availability.available;
  const rows = builders ?? [];
  const anyBuilder = rows.some((b) => b.availability.available);

  return (
    <Card
      title="Where your apps run"
      subtitle="The service that answers your private URLs, and the machines that can build what you publish."
      padded={false}
      className={className}
    >
      <dl>
        <Row term="Serving">
          <p className="flex items-start gap-2 text-[13px] text-ink">
            <StatusDot status={serving ? "ok" : "err"} className="mt-1.5" />
            <span className="min-w-0">{runtime.label}</span>
          </p>
          {!serving && (
            <Callout tone="err" title="Apps cannot be served right now" compact>
              <p>{runtime.availability.reason ?? "The runtime did not say why it is unavailable."}</p>
              {runtime.availability.fix && (
                <p className="mt-1 text-ink-mute">{runtime.availability.fix}</p>
              )}
            </Callout>
          )}
        </Row>

        <Row term="Building">
          {rows.length === 0 ? (
            <p className="max-w-[70ch] text-[13px] text-ink-mute">
              The server did not report any build runner, so this screen cannot say whether a publish
              would build here. Try again after a reload.
            </p>
          ) : (
            <ul className="space-y-3">
              {rows.map((builder) => (
                <li key={builder.id} className="min-w-0">
                  <p className="flex items-start gap-2 text-[13px] text-ink">
                    <StatusDot
                      status={builder.availability.available ? "ok" : "idle"}
                      label={builder.availability.available ? "Ready" : "Unavailable"}
                      className="mt-1.5"
                    />
                    <span className="min-w-0">{builder.label}</span>
                  </p>
                  <p className="mt-1 max-w-[70ch] pl-4 text-[12.5px] leading-relaxed text-ink-mute">
                    {builder.boundary}
                  </p>
                  {!builder.availability.available && builder.availability.reason && (
                    <p className="mt-1 max-w-[70ch] pl-4 text-[12.5px] leading-relaxed text-ink-mute">
                      Unavailable: {builder.availability.reason}
                      {builder.availability.fix ? ` ${builder.availability.fix}` : ""}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {rows.length > 0 && !anyBuilder && (
            <Callout tone="warn" title="Nothing can be built here right now" compact>
              <p>
                None of the build runners this install knows about can run, so a publish would be
                refused before it started.
              </p>
            </Callout>
          )}

          {buildsPaused && (
            <Callout tone="warn" title="Builds are paused" compact>
              <p>
                {buildsPausedReason ??
                  "Spending reached the monthly envelope for this workspace, so new builds are paused. Apps that are already published keep serving."}
              </p>
            </Callout>
          )}
        </Row>
      </dl>
    </Card>
  );
}
