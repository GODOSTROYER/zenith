"use client";
/**
 * What applying an OpenTofu plan would change, grouped by the Zenith resource
 * each change belongs to.
 *
 * Data comes from `planView` (the model-safe view): addresses, actions and
 * changed attribute paths, plus the values of short non-sensitive scalars. So:
 *  - a sensitive attribute is shown only as "(sensitive)", never a value;
 *  - "(known after apply)" is kept verbatim, never turned into a blank;
 *  - a value the view withheld shows "(not shown)": the attribute still changed;
 *  - deleting or replacing a resource is highlighted, and data loss has a
 *    callout of its own naming the resources;
 *  - every string in a plan originates in a manifest, repo or cloud response,
 *    so it is rendered as text and nothing more.
 */
import { useId } from "react";
import { Eye, Minus, Pencil, Plus, RefreshCw, Trash2, type LucideIcon } from "lucide-react";
import type { PlanView, PlanViewResource } from "@/lib/tofu/plan";
import type { TofuAction } from "@/lib/tofu/types";
import { cx } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { groupByNode, isDestructiveAction, describePlanValue, type ShownValue } from "./plan-values";
import { plural, shortDigest } from "./text";

export interface PlanChangesTableProps extends AsyncSurfaceProps {
  plan?: PlanView;
  /** heading; defaults to "Planned changes" */
  title?: string;
}

const ACTION: Record<TofuAction, { label: string; Icon: LucideIcon; tone: ChipTone }> = {
  create: { label: "Create", Icon: Plus, tone: "signal" },
  update: { label: "Change", Icon: Pencil, tone: "signal" },
  delete: { label: "Delete", Icon: Trash2, tone: "err" },
  replace: { label: "Replace", Icon: RefreshCw, tone: "err" },
  read: { label: "Read", Icon: Eye, tone: "info" },
  "no-op": { label: "No change", Icon: Minus, tone: "neutral" },
};

const ACTION_SENTENCE: Record<TofuAction, string> = {
  create: "A new resource will be created.",
  update: "The resource will be changed in place.",
  delete: "The resource will be deleted.",
  replace: "The resource will be destroyed and created again.",
  read: "The resource's data will be read.",
  "no-op": "Nothing changes.",
};

function ValueText({ shown }: { shown: ShownValue }) {
  return (
    <span
      title={shown.explanation}
      className={cx(
        "break-words",
        shown.kind === "value" ? "font-mono text-[12.5px] text-ink" : "text-[12.5px] text-ink-faint italic"
      )}
    >
      {shown.text}
    </span>
  );
}

function ResourceChange({ resource }: { resource: PlanViewResource }) {
  const a = ACTION[resource.action];
  const destructive = isDestructiveAction(resource.action);
  return (
    <article
      data-action={resource.action}
      data-destructive={destructive ? "true" : undefined}
      className={cx(
        "rounded-card border",
        destructive ? "border-err/40 bg-err-dim" : "border-line bg-bg2"
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
        <Chip tone={a.tone} title={ACTION_SENTENCE[resource.action]} icon={<a.Icon className="h-3 w-3" aria-hidden="true" />}>
          {a.label}
        </Chip>
        <span className="min-w-0 break-all font-mono text-[13px] text-ink">{resource.address}</span>
        <span className="text-[12px] text-ink-faint">{resource.type}</span>
        {resource.destroysData && (
          <Chip
            tone="err"
            title="This is a stateful resource. Deleting or replacing it destroys its data, and rollback cannot restore that data."
          >
            Destroys data
          </Chip>
        )}
      </header>
      {resource.changes.length > 0 ? (
        <div className="overflow-x-auto px-4 pb-3">
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">Attribute changes for {resource.address}</caption>
            <thead>
              <tr className="text-[12px] text-ink-mute">
                <th scope="col" className="w-[38%] py-1.5 pr-4 font-medium">
                  Attribute
                </th>
                <th scope="col" className="w-[31%] py-1.5 pr-4 font-medium">
                  Before
                </th>
                <th scope="col" className="w-[31%] py-1.5 font-medium">
                  After
                </th>
              </tr>
            </thead>
            <tbody>
              {resource.changes.map((c) => (
                <tr key={c.path} data-forces-replacement={c.forcesReplacement ? "true" : undefined} className="border-t border-line align-top">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">
                    <span className="break-all font-mono text-[12.5px] text-ink">{c.path}</span>
                    {c.forcesReplacement && (
                      <Chip
                        tone="warn"
                        className="ml-2"
                        title="Changing this attribute means the resource is destroyed and created again."
                      >
                        Forces replacement
                      </Chip>
                    )}
                  </th>
                  <td className="py-2 pr-4">
                    <ValueText shown={describePlanValue(c, "before", resource.action)} />
                  </td>
                  <td className="py-2">
                    <ValueText shown={describePlanValue(c, "after", resource.action)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 pb-3 text-[12.5px] text-ink-mute">No attribute details were listed for this change.</p>
      )}
      {resource.omittedChanges > 0 && (
        <p className="px-4 pb-3 text-[12.5px] text-ink-mute">
          {plural(resource.omittedChanges, "more attribute change")} not shown here to keep this view short.
        </p>
      )}
    </article>
  );
}

/** The counts of what a plan creates, changes, replaces and deletes, with its short digest. */
export function PlanSummaryChips({ plan }: { plan: Pick<PlanView, "summary" | "planDigest"> }) {
  const s = plan.summary;
  const parts: { key: string; n: number; label: string; tone: ChipTone }[] = [
    { key: "create", n: s.create, label: "to create", tone: "signal" },
    { key: "update", n: s.update, label: "to change", tone: "signal" },
    { key: "replace", n: s.replace, label: "to replace", tone: "err" },
    { key: "delete", n: s.delete, label: "to delete", tone: "err" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {parts.map((p) => (
        <Chip key={p.key} tone={p.n > 0 ? p.tone : "neutral"}>
          <span>
            <span className="tnum">{p.n}</span> {p.label}
          </span>
        </Chip>
      ))}
      <span className="text-[12px] text-ink-faint">
        Plan <code className="font-mono" title={plan.planDigest}>{shortDigest(plan.planDigest)}…</code>
      </span>
    </div>
  );
}

export function PlanChangesTable({ plan, title = "Planned changes", loading, error, onRetry }: PlanChangesTableProps) {
  const uid = useId();
  const groups = plan ? groupByNode(plan.resources) : [];
  const dataLoss = plan ? plan.resources.filter((r) => r.destroysData) : [];

  return (
    <Card title={title} subtitle="What applying this plan would change. Nothing is applied by viewing it.">
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="the plan" rows={4}>
        {!plan ? (
          <EmptyState title="No plan yet" body="A plan appears here once Zenith has computed what a change would do." />
        ) : plan.empty ? (
          <EmptyState
            title="This plan contains no changes"
            body="OpenTofu found nothing to create, change or delete for this configuration."
          />
        ) : (
          <div className="space-y-4">
            <PlanSummaryChips plan={plan} />

            {dataLoss.length > 0 && (
              <Callout tone="err" title="This plan destroys data">
                <p>
                  Deleting or replacing {plural(dataLoss.length, "stateful resource")} destroys its data, and rollback cannot restore it:
                </p>
                <ul className="mt-1 list-disc pl-5 font-mono text-[12.5px]">
                  {dataLoss.map((r) => (
                    <li key={r.address} className="break-all">
                      {r.address}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}

            {plan.diagnostics.length > 0 && (
              <Callout tone="warn" title="OpenTofu reported">
                <ul className="space-y-1">
                  {plan.diagnostics.map((d, i) => (
                    <li key={i}>
                      <span className="text-ink-faint">{d.severity === "error" ? "Error: " : "Warning: "}</span>
                      {d.summary}
                      {d.detail ? <span className="text-ink-mute"> {d.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}

            {plan.truncated && (
              <Callout tone="info">
                Some resources or attributes were left out to keep this view short. The approval still covers the whole plan.
              </Callout>
            )}

            {groups.map((g, gi) => (
              <section key={g.nodeAddress ?? "unmapped"} aria-labelledby={`${uid}-node-${gi}`} className="space-y-2">
                <h4 id={`${uid}-node-${gi}`} className="text-[13px] font-medium text-ink-mute">
                  {g.nodeAddress ? (
                    <span className="break-all font-mono text-[12.5px] text-ink">{g.nodeAddress}</span>
                  ) : (
                    "Other changes"
                  )}{" "}
                  <span className="font-normal text-ink-faint">
                    · {plural(g.resources.length, "change")}
                    {!g.nodeAddress && " · not linked to one Zenith resource"}
                  </span>
                </h4>
                <div className="space-y-2">
                  {g.resources.map((r) => (
                    <ResourceChange key={r.address} resource={r} />
                  ))}
                </div>
              </section>
            ))}

            {plan.outputs.length > 0 && (
              <section aria-labelledby={`${uid}-outputs`} className="space-y-2">
                <h4 id={`${uid}-outputs`} className="text-[13px] font-medium text-ink-mute">
                  Outputs
                </h4>
                <ul className="divide-y divide-line rounded-card border border-line">
                  {plan.outputs.map((o) => (
                    <li key={o.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                      <span className="font-mono text-[12.5px] text-ink">{o.name}</span>
                      <Chip tone={isDestructiveAction(o.action) ? "err" : "neutral"}>{ACTION[o.action].label}</Chip>
                      {o.sensitive && <span className="text-[12.5px] text-ink-faint italic">(sensitive)</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </SurfaceGate>
    </Card>
  );
}
