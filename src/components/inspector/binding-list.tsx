"use client";
/** Everything one node is wired to, listed inside that node's editor. */
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { nodeLabel } from "./logic";
import { bindingEnv } from "@/lib/domain/graph";
import type { Binding } from "@/lib/domain/types";
import { cx } from "@/lib/format";

export interface BindingListProps {
  nodeId: string;
  onOpen?: (bindingId: string) => void;
}

export function BindingList({ nodeId, onOpen }: BindingListProps) {
  const { project } = useProjectData();
  const m = project.workingManifest;
  const related = m.bindings.filter((b) => b.from === nodeId || b.to === nodeId);

  const label = (id: string) => nodeLabel(m, id);

  if (related.length === 0)
    return (
      <p className="text-[13px] text-ink-mute">
        Nothing is connected here yet. Use <strong className="font-medium text-ink">Connect</strong>{" "}
        on the map toolbar to draw a connection, and Orrery injects the configuration for you.
      </p>
    );

  return (
    <div className="space-y-2.5">
      {related.map((b: Binding) => {
        const outgoing = b.from === nodeId;
        const injected = bindingEnv(m, b);
        return (
          <div key={b.id} className="space-y-2 rounded-card border border-line bg-bg1 p-3">
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <span className={cx("truncate", !outgoing && "text-ink-mute")}>
                {label(b.from)}
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
              <span className={cx("truncate", outgoing && "text-ink")}>{label(b.to)}</span>
              <Chip className="ml-auto">{b.capability}</Chip>
            </div>
            {b.note && <p className="text-[12.5px] text-ink-mute">{b.note}</p>}
            {outgoing && injected.length > 0 && (
              <p className="font-mono text-[11.5px] text-ink-faint">
                injects {injected.map((e) => e.key).join(", ")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {onOpen && (
                <Button size="sm" variant="quiet" onClick={() => onOpen(b.id)}>
                  Open connection
                </Button>
              )}
              <PlanFirst
                actionId="system.unbind"
                input={{ bindingId: b.id }}
                label="Disconnect"
                variant="ghost"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
