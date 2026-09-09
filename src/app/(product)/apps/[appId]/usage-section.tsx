"use client";
/**
 * What this app has actually used, against what it is allowed — and what that
 * is estimated to cost.
 *
 * Two words do the work here. Requests and stored bytes are *measured*: the
 * server counted them, and it says in its own words how. Spend is an
 * *estimate*: nobody has been billed for these numbers. Neither word is
 * decoration, and both disclosures come from the API rather than from this
 * screen's imagination.
 *
 * Workstream W9 (hosted R3)
 */
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Meter } from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote, SectionTitle } from "@/components/screens/shared";
import { fmtUsd } from "@/lib/format";
import { LimitsTable } from "@/components/apps/limits-table";
import { fmtBytes, fmtCount } from "@/components/apps/limits";
import { useHostedUsage, useSpending } from "@/lib/client/hosted";
import type { HostedLimits, LimitEnforcement } from "@/lib/hosted/contracts";

export interface UsageSectionProps {
  appId: string;
  appName: string;
  /** from the apps list, used until this app's own reading arrives */
  limits?: HostedLimits;
  enforcement?: LimitEnforcement | null;
  /** owners read usage; everyone else is told who to ask */
  canRead: boolean;
  readReason?: string;
  /** spending is a workspace-admin reading */
  canSeeSpending: boolean;
  workspaceName: string;
}

export function UsageSection({
  appId,
  appName,
  limits,
  enforcement,
  canRead,
  readReason,
  canSeeSpending,
  workspaceName,
}: UsageSectionProps) {
  const usageQuery = useHostedUsage(canRead ? appId : null);
  const spendingQuery = useSpending(canSeeSpending);

  const usage = usageQuery.data;
  const activeLimits = usage?.limits ?? limits;
  const activeEnforcement = usage?.enforcement ?? enforcement ?? undefined;

  const requests = usage?.quota.current.requests ?? 0;
  const denied = usage?.quota.current.denied ?? 0;
  const requestLimit = usage?.quota.limit ?? activeLimits?.requestsPerDay;
  const storage = usage?.usage.byKind.find((row) => row.kind === "storage_bytes")?.amount;
  const spending = spendingQuery.data?.spending;

  return (
    <Card
      title="Limits and usage"
      subtitle="What this app has used today, and the ceilings it runs under."
    >
      <div className="space-y-6">
        {!canRead ? (
          <p className="max-w-[70ch] text-[13px] text-ink-mute">
            {readReason ?? `Only an owner of ${appName} can read its usage.`}
          </p>
        ) : usageQuery.error && !usage ? (
          <div>
            <ErrorNote error={usageQuery.error} />
            <Button className="mt-3" size="sm" variant="quiet" onClick={usageQuery.refresh}>
              Try again
            </Button>
          </div>
        ) : usageQuery.loading && !usage ? (
          <div className="space-y-3">
            <Skeleton height={14} width="30%" />
            <Skeleton height={40} />
            <Skeleton height={40} />
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              {requestLimit ? (
                <Meter
                  value={requests}
                  max={requestLimit}
                  label="Requests today · measured"
                  hint={`${fmtCount(requests)} of ${fmtCount(requestLimit)}`}
                />
              ) : (
                <>
                  <SectionTitle>Requests today · measured</SectionTitle>
                  <p className="mt-1 text-[13px] text-ink">{fmtCount(requests)}</p>
                </>
              )}
              <p className="mt-1.5 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                {usage?.quota.disclosure ??
                  "Counted on every request that resolved to this app, whatever the outcome, and reset at 00:00 UTC."}
                {denied > 0 ? ` ${fmtCount(denied)} were refused.` : ""}
              </p>
            </div>

            <div>
              {typeof storage === "number" && activeLimits ? (
                <Meter
                  value={storage}
                  max={activeLimits.storageBytes}
                  label="Stored data · measured"
                  hint={`${fmtBytes(storage)} of ${fmtBytes(activeLimits.storageBytes)}`}
                />
              ) : (
                <>
                  <SectionTitle>Stored data · measured</SectionTitle>
                  <p className="mt-1 text-[13px] text-ink">
                    {typeof storage === "number"
                      ? fmtBytes(storage)
                      : "Nothing measured yet — this app has not stored anything."}
                  </p>
                </>
              )}
              <p className="mt-1.5 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                Counted as the logical bytes of the fields stored in this app&apos;s database, not
                the size of the file on disk.
              </p>
            </div>
          </div>
        )}

        <div>
          <SectionTitle>Limits</SectionTitle>
          <div className="mt-2">
            {activeLimits && activeEnforcement ? (
              <LimitsTable
                limits={activeLimits}
                enforcement={activeEnforcement}
                labels={usage?.enforcementLabels}
              />
            ) : (
              <p className="text-[13px] text-ink-mute">
                The runtime could not be asked which limits it enforces, so this table would only be
                a guess. It appears once the runtime answers.
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-line pt-5">
          <SectionTitle>Spending</SectionTitle>
          {!canSeeSpending ? (
            <p className="mt-1.5 max-w-[70ch] text-[13px] text-ink-mute">
              Spending is a workspace-wide figure, so it needs the admin role in {workspaceName}. Ask
              a workspace admin what the envelope looks like.
            </p>
          ) : spendingQuery.error ? (
            <div className="mt-2">
              <ErrorNote error={spendingQuery.error} />
              <Button className="mt-3" size="sm" variant="quiet" onClick={spendingQuery.refresh}>
                Try again
              </Button>
            </div>
          ) : spendingQuery.loading && !spending ? (
            <Skeleton className="mt-2" height={40} />
          ) : spending ? (
            <div className="mt-2 space-y-3">
              {spending.envelopeUsd > 0 ? (
                <Meter
                  value={spending.estimatedUsd}
                  max={spending.envelopeUsd}
                  label="Estimated spend this month · estimate"
                  hint={`${fmtUsd(spending.estimatedUsd)} of ${fmtUsd(spending.envelopeUsd)}`}
                />
              ) : (
                <p className="text-[13px] text-ink">
                  {fmtUsd(spending.estimatedUsd)} estimated this month. No monthly envelope is set
                  for {workspaceName}, so nothing is measured against one.
                </p>
              )}
              <p className="max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                {spending.disclosure}
              </p>
              {Object.keys(spending.thresholds ?? {}).length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] text-ink-mute">Alerts at</span>
                  {Object.values(spending.thresholds).map((t) => (
                    <Chip key={t.threshold} tone={t.crossed ? "warn" : "neutral"}>
                      {t.threshold}%{t.crossed ? " · reached" : ""}
                    </Chip>
                  ))}
                </div>
              )}
              {spending.buildsPaused.paused && (
                <Callout tone="warn" title="Builds are paused" compact>
                  <p>{spending.buildsPaused.reason}</p>
                </Callout>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
