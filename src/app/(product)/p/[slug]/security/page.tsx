"use client";
/**
 * Security — what the scanner found, what fixes it, and what someone decided
 * to live with. Fixes are ordinary actions, so they plan before they apply and
 * land in the audit trail like every other change.
 *
 * Every automatic fix is previewed once, for the whole screen (see
 * use-fix-plans.ts): the row can say what its fix costs before you open
 * anything, "Fix all" runs exactly the previews it showed, and a fix that
 * would be refused is never offered.
 */
import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { SecurityFinding } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSelectedEnv } from "@/components/screens/project-data";
import { useShell } from "@/components/shell/shell-context";
import { downloadFile } from "@/components/screens/download-file";
import { ActionConfirm, type Scope } from "@/components/screens/shared";
import { BulkFixDialog } from "./bulk-fix-dialog";
import { DismissDialog } from "./dismiss-dialog";
import { FindingEnvChip } from "./finding-env-chip";
import { FindingRow } from "./finding-row";
import { FiltersBar } from "./filters-bar";
import { HistorySection } from "./history-section";
import { PendingSection } from "./pending-section";
import { useFixPlans } from "./use-fix-plans";
import {
  excludedNote,
  matches,
  NO_FILTERS,
  sortFindings,
  splitFixes,
  toCsv,
  toJson,
  type Filters,
  type SortKey,
} from "./rows";

export default function SecurityPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const { boot } = useShell();
  const role = boot?.role ?? null;
  const canEdit = role !== "viewer";

  const [fixing, setFixing] = useState<SecurityFinding | null>(null);
  const [dismissing, setDismissing] = useState<SecurityFinding | null>(null);
  const [reopening, setReopening] = useState<SecurityFinding | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>("severity");

  const findings = useMemo(() => data?.findings ?? [], [data]);
  const environments = useMemo(() => data?.environments ?? [], [data]);
  const revisions = useMemo(() => data?.revisions ?? [], [data]);

  const open = useMemo(() => findings.filter((f) => f.status === "open"), [findings]);
  const pending = useMemo(
    () => findings.filter((f) => f.status === "fixed_pending_deploy"),
    [findings]
  );
  const history = useMemo(
    () => findings.filter((f) => f.status === "resolved" || f.status === "dismissed"),
    [findings]
  );
  const autoFixable = useMemo(() => open.filter((f) => f.fix), [open]);
  const manualOnly = open.length - autoFixable.length;

  const scope = useMemo<Scope>(() => ({ projectId, environmentId: env?.id }), [projectId, env?.id]);
  const plans = useFixPlans(autoFixable, scope);
  const planOf = useMemo(
    () => new Map((plans?.rows ?? []).map((r) => [r.finding.id, r])),
    [plans]
  );
  const split = useMemo(() => splitFixes(plans?.rows ?? [], role), [plans, role]);
  const excluded = excludedNote(split, role);

  const envById = useMemo(() => new Map(environments.map((e) => [e.id, e])), [environments]);
  const envName = useMemo(
    () => Object.fromEntries(environments.map((e) => [e.id, e.name])),
    [environments]
  );

  const visible = useMemo(
    () => sortFindings(open.filter((f) => matches(f, filters)), sort),
    [open, filters, sort]
  );

  if (!data)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  const save = (kind: "json" | "csv") => {
    const at = new Date();
    const stamp = at.toISOString().slice(0, 10);
    if (kind === "csv")
      downloadFile(`orrery-findings-${slug}-${stamp}.csv`, toCsv(findings, envName), "text/csv");
    else
      downloadFile(
        `orrery-findings-${slug}-${stamp}.json`,
        toJson(findings, { project: slug, at: at.toISOString(), envName }),
        "application/json"
      );
  };

  /** The environment chip a finding carries, filled in when the header has that environment selected. */
  const envChip = (f: SecurityFinding) => (
    <FindingEnvChip finding={f} envById={envById} selectedEnvId={env?.id} />
  );

  return (
    <div className="mx-auto h-full w-full max-w-[980px] space-y-6 overflow-y-auto px-6 py-6">
      {open.length === 0 ? (
        <div className="rounded-card border border-ok/30 bg-ok-dim">
          <EmptyState
            icon={<ShieldCheck className="h-5 w-5 text-ok" />}
            title="No open findings."
            body={
              pending.length > 0
                ? `The scanner has nothing outstanding in the working copy, but ${pending.length} fix${pending.length === 1 ? " is" : "es are"} still waiting on a deploy — see below.`
                : "The scanner has nothing outstanding on this system. It re-runs every time the project loads."
            }
            secondaryAction={
              findings.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => save("json")}>
                  Export findings (JSON)
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <section className="space-y-3">
          <FiltersBar
            open={open}
            autoFixable={autoFixable}
            manualOnly={manualOnly}
            environments={environments}
            filters={filters}
            sort={sort}
            planned={!!plans}
            split={split}
            excluded={excluded}
            canEdit={canEdit}
            role={role}
            exportCount={findings.length}
            onFilters={setFilters}
            onSort={setSort}
            onSave={save}
            onFixAll={() => setBulkOpen(true)}
          />

          <p className="text-[12px] text-ink-faint">
            {visible.length === open.length
              ? `${open.length} open finding${open.length === 1 ? "" : "s"}`
              : `${visible.length} of ${open.length} open findings shown`}
            {manualOnly > 0 &&
              ` · ${manualOnly} ${manualOnly === 1 ? "has" : "have"} no automatic fix and ${manualOnly === 1 ? "is" : "are"} left out of “Fix all”`}
          </p>
          {excluded && <p className="text-[12px] text-ink-faint">{excluded}</p>}

          {visible.length === 0 ? (
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-ink-mute">
                  No open finding matches these filters. Widen them to see the other{" "}
                  {open.length - visible.length}.
                </p>
                <Button size="sm" variant="quiet" onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
                </Button>
              </div>
            </Card>
          ) : (
            <Card padded={false}>
              <ul>
                {visible.map((f) => (
                  <FindingRow
                    key={f.id}
                    finding={f}
                    row={planOf.get(f.id)}
                    here={!!f.environmentId && f.environmentId === env?.id}
                    canEdit={canEdit}
                    role={role}
                    slug={slug}
                    envChip={envChip(f)}
                    onFix={() => setFixing(f)}
                    onDismiss={() => setDismissing(f)}
                  />
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}

      {pending.length > 0 && (
        <PendingSection pending={pending} slug={slug} envChip={envChip} />
      )}

      {history.length > 0 && (
        <HistorySection
          history={history}
          revisions={revisions}
          slug={slug}
          canEdit={canEdit}
          role={role}
          envChip={envChip}
          onReopen={setReopening}
        />
      )}

      <ActionConfirm
        open={fixing !== null}
        onClose={() => setFixing(null)}
        actionId="security.resolveFinding"
        input={{ findingId: fixing?.id, applyFix: true }}
        scope={scope}
        title={fixing?.fix?.label ?? "Apply the fix"}
        description={fixing?.title}
        confirmLabel="Apply fix"
        onDone={() => {
          setFixing(null);
          refresh();
        }}
      />

      <ActionConfirm
        open={reopening !== null}
        onClose={() => setReopening(null)}
        actionId="security.reopenFinding"
        input={{ findingId: reopening?.id }}
        scope={scope}
        title="Reopen this finding"
        description={reopening?.title}
        confirmLabel="Reopen"
        onDone={() => {
          setReopening(null);
          refresh();
        }}
      />

      {bulkOpen && (
        <BulkFixDialog
          rows={plans?.rows}
          plannedAt={plans?.at}
          split={split}
          skipped={manualOnly}
          role={role}
          scope={scope}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            refresh();
          }}
        />
      )}

      <DismissDialog
        finding={dismissing}
        scope={scope}
        onClose={() => setDismissing(null)}
        onDone={() => {
          setDismissing(null);
          refresh();
        }}
      />
    </div>
  );
}
