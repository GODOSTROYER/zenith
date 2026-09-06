/**
 * Findings whose fix landed in the working copy but not in the environment.
 * They stay on this page rather than moving to History, because the running
 * system still has the problem until a deployment says otherwise.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import type { SecurityFinding } from "@/lib/domain/types";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { TimeAgo } from "@/components/ui/time-ago";
import { STATUS_LABEL } from "./rows";

export interface PendingSectionProps {
  pending: SecurityFinding[];
  slug: string;
  envChip: (finding: SecurityFinding) => ReactNode;
}

export function PendingSection({ pending, slug, envChip }: PendingSectionProps) {
  return (
    <section className="space-y-3">
      <h2 className="app-section-title">
        Awaiting deployment <span className="ml-2 font-mono text-[13px] text-warn">{pending.length}</span>
      </h2>
      <p className="max-w-[80ch] text-[12.5px] text-ink-mute">
        {pending.length === 1 ? "This fix is" : "These fixes are"} in the working configuration. Review and deploy the changes before considering the running environment resolved.
      </p>
      <Card padded={false} className="border-warn/30">
        <ul>
          {pending.map((f) => (
            <li key={f.id} className="border-b border-line px-5 py-4 last:border-b-0">
              <div className="flex flex-col items-start gap-3 sm:flex-row">
                <Chip tone="warn" className="mt-0.5">
                  {STATUS_LABEL[f.status]}
                </Chip>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-medium text-ink [overflow-wrap:anywhere]">{f.title}</h3>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
                    {f.resolvedAt && <TimeAgo iso={f.resolvedAt} prefix="fixed" />}
                    {f.resolvedBy && <span>by {f.resolvedBy.name}</span>}
                    {envChip(f)}
                    {slug && (
                      <Link href={`/p/${slug}?review=1${f.environmentId ? `&env=${encodeURIComponent(f.environmentId)}` : ""}`} className="text-signal hover:underline">
                        Review pending changes →
                      </Link>
                    )}
                  </p>
                  {f.resolvedReason && (
                    <p className="mt-1 text-[12px] text-ink-mute">{f.resolvedReason}</p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
