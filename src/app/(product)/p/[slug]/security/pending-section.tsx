/**
 * Findings whose fix landed in the working copy but not in the environment.
 * They stay on this page rather than moving to History, because the running
 * system still has the problem until a deployment says otherwise.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import type { SecurityFinding } from "@/lib/domain/types";
import { Card, Chip, TimeAgo } from "@/components/ui";
import { STATUS_LABEL } from "./rows";

export interface PendingSectionProps {
  pending: SecurityFinding[];
  slug: string;
  envChip: (finding: SecurityFinding) => ReactNode;
}

export function PendingSection({ pending, slug, envChip }: PendingSectionProps) {
  return (
    <section className="space-y-2">
      <h2 className="text-[13px] text-ink">
        Fixed in the working copy — deploy to make it true
      </h2>
      <p className="max-w-[80ch] text-[12.5px] text-ink-mute">
        {pending.length === 1 ? "This fix" : "These fixes"} changed the system definition, not
        the running environment. Until a deployment lands the change, the environment still has
        the problem — so {pending.length === 1 ? "it stays" : "they stay"} on this page rather
        than moving to History.
      </p>
      <Card padded={false} className="border-warn/30">
        <ul>
          {pending.map((f) => (
            <li key={f.id} className="border-b border-line px-5 py-4 last:border-b-0">
              <div className="flex items-start gap-3">
                <Chip tone="warn" className="mt-0.5">
                  {STATUS_LABEL[f.status]}
                </Chip>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] text-ink">{f.title}</h3>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                    {f.resolvedAt && <TimeAgo iso={f.resolvedAt} prefix="fixed" />}
                    {f.resolvedBy && <span>by {f.resolvedBy.name}</span>}
                    {envChip(f)}
                    {slug && (
                      <Link href={`/p/${slug}?review=1`} className="text-signal hover:underline">
                        review the pending changes
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
