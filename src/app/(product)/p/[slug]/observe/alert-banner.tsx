"use client";
/**
 * The alert banner above the health cards. Renders nothing when everything is
 * clear — a permanent "all good" banner is furniture, not information.
 *
 * What it can honestly say about delivery comes from the open alerts' own
 * records: it is rendered by a screen that does not pass the feed, so it reads
 * what happened rather than asserting anything.
 */
import { BellRing } from "lucide-react";
import type { AlertEvent } from "@/lib/domain/types";
import { Callout } from "@/components/ui/callout";
import { TimeAgo } from "@/components/ui/time-ago";

/**
 * Open alerts, above the health cards. Renders nothing when everything is
 * clear — a permanent "all good" banner is furniture, not information.
 */
export function AlertBanner({ open }: { open: AlertEvent[] }) {
  if (open.length === 0) return null;
  const worst = open.some((e) => e.severity === "high") ? "err" : "warn";
  return (
    // A banner that appears on a poll, not on an action the operator just took:
    // it is announced politely even when the worst alert is an error.
    <Callout
      tone={worst}
      live="status"
      icon={
        <BellRing
          className={`mt-0.5 h-4 w-4 shrink-0 ${worst === "err" ? "text-err" : "text-warn"}`}
          aria-hidden="true"
        />
      }
      title={
        <>
          {open.length} open alert{open.length === 1 ? "" : "s"}
        </>
      }
    >
      <div className="space-y-1.5">
        {open.slice(0, 3).map((e) => (
          <p key={e.id} className="text-[12.5px] leading-relaxed text-ink">
            <span className="text-ink-faint">
              <TimeAgo iso={e.firedAt} /> ·{" "}
            </span>
            {e.summary}
            {e.acknowledgedAt && (
              <span className="text-ink-faint">
                {" "}
                — acknowledged by {e.acknowledgedBy?.name ?? "someone"}
              </span>
            )}
          </p>
        ))}
        {open.length > 3 && (
          <p className="text-[12px] text-ink-faint">
            and {open.length - 3} more, listed under Alerts.
          </p>
        )}
        <p className="text-[11.5px] text-ink-faint">
          <a href="#alerts" className="underline underline-offset-2 hover:text-ink">
            Acknowledge or change these rules under Alerts
          </a>
          . {bannerDelivery(open)}
        </p>
      </div>
    </Callout>
  );
}

/**
 * What the banner can honestly say about delivery from the open alerts alone —
 * it is rendered by a screen that does not pass the feed, so it reads the
 * record instead of asserting anything.
 */
function bannerDelivery(open: AlertEvent[]): string {
  const attempted = open.filter((e) => e.deliveries !== undefined);
  if (attempted.length === 0) return "Delivery for these is not recorded.";
  const failed = attempted.filter((e) => e.deliveries!.some((d) => !d.ok)).length;
  const sent = attempted.filter((e) => e.deliveries!.some((d) => d.ok)).length;
  if (failed > 0)
    return `${failed} of these could not be delivered to a channel — each one below says why.`;
  if (sent > 0) return "These were delivered to this workspace's channels.";
  return "Not sent anywhere: this workspace has no delivery channels (Settings → Alerts).";
}
