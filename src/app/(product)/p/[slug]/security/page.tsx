"use client";
/**
 * Security — what the scanner found, what fixes it, and what someone decided
 * to live with. Fixes are ordinary actions, so they plan before they apply and
 * land in the audit trail like every other change.
 *
 * Every automatic fix is previewed once, for the whole screen: the row can say
 * what its fix costs before you open anything, "Fix all" runs exactly the
 * previews it showed, and a fix that would be refused is never offered.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Wrench } from "lucide-react";
import type { Role } from "@/lib/actions/core";
import { executeAction, planAction } from "@/lib/client/api";
import type { SecurityFinding } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import {
  Button,
  Callout,
  Card,
  Chip,
  CostDelta,
  Dialog,
  EmptyState,
  Input,
  RiskBadge,
  SegmentedControl,
  Select,
  Skeleton,
  TimeAgo,
} from "@/components/ui";
import { useSelectedEnv } from "@/components/screens/project-data";
import { useShell } from "@/components/shell/shell-context";
import {
  ActionConfirm,
  EnvDot,
  ErrorNote,
  envTone,
  errorText,
  useSafeToasts,
  type Scope,
} from "@/components/screens/shared";
import {
  excludedNote,
  isEnvironmentPolicy,
  matches,
  NO_FILTERS,
  SEVERITY_ORDER,
  sortFindings,
  splitFixes,
  STATUS_LABEL,
  toCsv,
  toJson,
  type EnvFilter,
  type Filters,
  type FixFilter,
  type FixRow,
  type FixSplit,
  type SeverityFilter,
  type SortKey,
} from "./rows";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "severity", label: "Highest severity first" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

/** Why a control is closed to a viewer. Same sentence wherever it appears. */
const viewerReason = (verb: string, role: Role | null) =>
  `${verb} needs the editor role and you are ${role ?? "a viewer"} in this workspace. Ask a workspace admin to raise your role in Settings → Members, or have them run it.`;

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
      download(`orrery-findings-${slug}-${stamp}.csv`, toCsv(findings, envName), "text/csv");
    else
      download(
        `orrery-findings-${slug}-${stamp}.json`,
        toJson(findings, { project: slug, at: at.toISOString(), envName }),
        "application/json"
      );
  };

  /** The environment chip a finding carries, filled in when the header has that environment selected. */
  const envChip = (f: SecurityFinding) => {
    if (!f.environmentId) return null;
    const e = envById.get(f.environmentId);
    const klass = e?.class ?? "sandbox";
    const here = f.environmentId === env?.id;
    return (
      <Chip
        tone={here ? envTone(klass) : "neutral"}
        icon={<EnvDot klass={klass} />}
        title={
          here
            ? "This finding is about the environment selected in the header."
            : `This finding is about ${e?.name ?? f.environmentId}, not the environment selected in the header.`
        }
      >
        {e?.name ?? f.environmentId}
      </Chip>
    );
  };

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
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<SeverityFilter>
              size="sm"
              label="Filter by severity"
              value={filters.severity}
              onChange={(v) => setFilters((f) => ({ ...f, severity: v }))}
              options={[
                { value: "all", label: `All ${open.length}`, title: "Every open finding" },
                ...SEVERITY_ORDER.map((s) => ({
                  value: s,
                  label: `${s} ${open.filter((f) => f.severity === s).length}`,
                  title: `${s} severity only`,
                })),
              ]}
            />
            <SegmentedControl<FixFilter>
              size="sm"
              label="Filter by whether a fix exists"
              value={filters.fix}
              onChange={(v) => setFilters((f) => ({ ...f, fix: v }))}
              options={[
                { value: "all", label: "Any fix", title: "Fixable and manual findings" },
                {
                  value: "fixable",
                  label: `Auto-fixable ${autoFixable.length}`,
                  title: "Findings a registered action can fix",
                },
                {
                  value: "manual",
                  label: `Manual ${manualOnly}`,
                  title: "Findings with no automatic fix — you change the system yourself",
                },
              ]}
            />
            <Select
              className="w-[190px]"
              aria-label="Filter by environment"
              value={filters.environmentId}
              onChange={(e) => setFilters((f) => ({ ...f, environmentId: e.target.value as EnvFilter }))}
              options={[
                { value: "all", label: "Any environment" },
                ...environments.map((e) => ({
                  value: e.id,
                  label: `${e.name} · ${open.filter((f) => f.environmentId === e.id).length}`,
                })),
                {
                  value: "none",
                  label: `Not environment-specific · ${open.filter((f) => !f.environmentId).length}`,
                },
              ]}
            />
            <Select
              className="w-[190px]"
              aria-label="Sort findings"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              options={SORTS}
            />
            <div className="ml-auto flex items-center gap-2">
              <ExportMenu onSave={save} count={findings.length} />
              <Button
                size="sm"
                icon={<Wrench className="h-3.5 w-3.5" />}
                disabled={
                  !canEdit ||
                  autoFixable.length === 0 ||
                  (!!plans && split.runnable.length === 0)
                }
                disabledReason={
                  !canEdit
                    ? viewerReason("Fixing a finding", role)
                    : autoFixable.length === 0
                      ? `None of the ${open.length} open finding${open.length === 1 ? " has" : "s have"} an automatic fix — change the system, then dismiss each with a reason.`
                      : (excluded ??
                        "None of these fixes can run right now — open one to see what its plan says.")
                }
                title="Preview every automatic fix, then run them"
                onClick={() => setBulkOpen(true)}
              >
                Fix all {plans && canEdit ? split.runnable.length : autoFixable.length}
              </Button>
            </div>
          </div>

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
                {visible.map((f) => {
                  const row = planOf.get(f.id);
                  const blocked = row?.plan?.blocked;
                  const here = !!f.environmentId && f.environmentId === env?.id;
                  return (
                    <li
                      key={f.id}
                      className={cx(
                        "flex items-start gap-4 border-b border-line px-5 py-4 last:border-b-0",
                        here && "bg-signal/[0.045]"
                      )}
                    >
                      <RiskBadge level={f.severity} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[14px] text-ink">{f.title}</h3>
                        <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                          {f.detail}
                        </p>

                        {f.fix && (
                          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                            <span className="text-ink-mute">{f.fix.label}</span>
                            {row?.plan ? (
                              <>
                                <CostDelta usd={row.plan.costDeltaUsd} suffix="/mo est." />
                                <span title={`Running this fix is ${row.plan.risk} risk.`}>
                                  {row.plan.risk} risk
                                </span>
                              </>
                            ) : row?.error ? (
                              <span className="text-warn">could not be previewed</span>
                            ) : (
                              <span>working out what it would cost…</span>
                            )}
                          </p>
                        )}

                        {blocked && (
                          <Callout tone="warn" compact className="mt-1.5 max-w-[70ch]">
                            {blocked}
                          </Callout>
                        )}

                        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                          <TimeAgo iso={f.createdAt} prefix="found" />
                          {envChip(f)}
                          {f.targetId && slug && (
                            <Link
                              href={`/p/${slug}?select=${f.targetId}`}
                              className="font-mono text-signal hover:underline"
                            >
                              show on map
                            </Link>
                          )}
                          {isEnvironmentPolicy(f) && slug && (
                            <Link
                              href={`/p/${slug}/settings#environments`}
                              className="text-signal hover:underline"
                            >
                              Settings → Environments
                            </Link>
                          )}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!f.fix || !canEdit || !!blocked}
                          disabledReason={
                            !f.fix
                              ? "This finding has no automatic fix — change the system, then dismiss it with a reason."
                              : !canEdit
                                ? viewerReason("Fixing a finding", role)
                                : blocked
                          }
                          onClick={() => setFixing(f)}
                          title={f.fix?.label}
                        >
                          {f.fix ? "Fix" : "No auto-fix"}
                        </Button>
                        <Button
                          size="sm"
                          variant="quiet"
                          disabled={!canEdit}
                          disabledReason={viewerReason("Dismissing a finding", role)}
                          onClick={() => setDismissing(f)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>
      )}

      {pending.length > 0 && (
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
      )}

      {history.length > 0 && (
        <details className="rounded-card border border-line bg-bg2">
          <summary className="cursor-pointer px-5 py-3 text-[13px] text-ink-mute select-none hover:text-ink">
            History — {history.length} resolved or dismissed
          </summary>
          <ul className="border-t border-line">
            {history.map((f) => {
              const landed = revisions.find((r) => r.id === f.fixedInRevisionId);
              return (
                <li
                  key={f.id}
                  className="flex items-start gap-3 border-b border-line px-5 py-3 text-[12.5px] last:border-b-0"
                >
                  <Chip tone={f.status === "resolved" ? "ok" : "neutral"} className="mt-0.5">
                    {STATUS_LABEL[f.status]}
                  </Chip>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ink">{f.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                      <TimeAgo
                        iso={f.resolvedAt ?? f.createdAt}
                        prefix={f.status === "resolved" ? "resolved" : "dismissed"}
                      />
                      <span>by {f.resolvedBy?.name ?? "someone before this was recorded"}</span>
                      {envChip(f)}
                      {landed && slug && (
                        <Link
                          href={`/p/${slug}/revisions`}
                          className="text-signal hover:underline"
                          title="The deployed revision that made the fix true"
                        >
                          landed in revision {landed.number}
                        </Link>
                      )}
                    </p>
                    {f.resolvedReason && (
                      <p className="mt-0.5 text-[12px] text-ink-mute">{f.resolvedReason}</p>
                    )}
                  </div>
                  {f.status === "dismissed" && (
                    <Button
                      size="sm"
                      variant="quiet"
                      className="shrink-0"
                      disabled={!canEdit}
                      disabledReason={viewerReason("Reopening a finding", role)}
                      title="Undo this dismissal — the finding counts as open again"
                      onClick={() => setReopening(f)}
                    >
                      Reopen
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
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

/* ------------------------------- fix previews ------------------------------ */

/**
 * One plan per fixable finding, for the whole screen. Planning is read-only
 * and open to every role, so this is also how a row knows a fix would be
 * refused before anyone clicks it.
 *
 * ponytail: one request per fixable finding, in parallel. A batch plan
 * endpoint if a project ever carries enough findings for that to matter.
 */
function useFixPlans(
  findings: SecurityFinding[],
  scope: Scope
): { rows: FixRow[]; at: string } | undefined {
  const [state, setState] = useState<{ rows: FixRow[]; at: string }>();

  const list = useRef(findings);
  list.current = findings;
  const idKey = findings.map((f) => f.id).join(",");
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let alive = true;
    setState(undefined);
    const s = JSON.parse(scopeKey) as Scope;
    Promise.all(
      list.current.map((finding) =>
        planAction("security.resolveFinding", {
          input: { findingId: finding.id, applyFix: true },
          scope: s,
        })
          .then((plan): FixRow => ({ finding, plan }))
          .catch((e: unknown): FixRow => ({ finding, error: errorText(e).message }))
      )
    ).then((rows) => alive && setState({ rows, at: new Date().toISOString() }));
    return () => {
      alive = false;
    };
  }, [idKey, scopeKey]);

  return state;
}

/* --------------------------------- export --------------------------------- */

/** Client-side file save; findings never round-trip through a server to be read back. */
function download(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ExportMenu({ onSave, count }: { onSave: (kind: "json" | "csv") => void; count: number }) {
  const title = `All ${count} finding${count === 1 ? "" : "s"} on this project, every status included. Written in your browser from what this page already loaded.`;
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="quiet" title={title} onClick={() => onSave("json")}>
        Export JSON
      </Button>
      <Button size="sm" variant="quiet" title={title} onClick={() => onSave("csv")}>
        CSV
      </Button>
    </div>
  );
}

/* -------------------------------- bulk fix -------------------------------- */

/**
 * Plan-first, N times over: every fixable finding was previewed before a
 * single one runs, and the fixes then run one at a time through the same
 * action the single-finding Fix button uses — stoppable between findings.
 */
function BulkFixDialog({
  rows,
  plannedAt,
  split,
  skipped,
  role,
  scope,
  onClose,
  onDone,
}: {
  /** undefined while the previews are still being computed */
  rows: FixRow[] | undefined;
  plannedAt: string | undefined;
  split: FixSplit;
  /** open findings with no automatic fix — honestly excluded, never counted in */
  skipped: number;
  role: Role | null;
  scope: Scope;
  onClose: () => void;
  onDone: () => void;
}) {
  const toasts = useSafeToasts();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [halted, setHalted] = useState<{ ran: number; of: number }>();
  const [error, setError] = useState<unknown>();
  const stop = useRef(false);

  // The project polls while this is open, and a fix that lands changes the
  // finding list underneath it. This dialog keeps the previews it opened with,
  // so the list cannot rearrange itself mid-run and "computed before any fix
  // ran" stays literally true.
  const frozen = useRef<{ rows: FixRow[]; split: FixSplit; plannedAt?: string }>(undefined);
  if (!frozen.current && rows) frozen.current = { rows, split, plannedAt };
  const shown = frozen.current;

  const runnable = shown?.split.runnable ?? [];
  const costDelta = runnable.reduce((sum, r) => sum + (r.plan?.costDeltaUsd ?? 0), 0);
  const warnings = runnable.flatMap((r) => r.plan?.warnings ?? []);
  const excluded = shown ? excludedNote(shown.split, role) : undefined;
  const left = shown
    ? [...shown.split.roleBlocked, ...shown.split.otherBlocked, ...shown.split.unplannable]
    : [];

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    setHalted(undefined);
    setStopping(false);
    stop.current = false;
    const failures: string[] = [];
    let fixed = 0;
    let ran = 0;
    try {
      for (const r of runnable) {
        if (stop.current) break;
        ran += 1;
        setProgress(ran);
        const result = await executeAction("security.resolveFinding", {
          input: { findingId: r.finding.id, applyFix: true },
          scope,
        });
        if (result.ok) fixed++;
        else failures.push(`${r.finding.title}: ${result.error ?? result.summary}`);
      }
      const stopped = ran < runnable.length;
      toasts.push({
        kind: failures.length === 0 ? "ok" : "err",
        title:
          failures.length > 0
            ? `Fixed ${fixed} of ${ran} attempted; ${failures.length} did not apply.`
            : stopped
              ? `Stopped after ${fixed} of ${runnable.length}.`
              : `Fixed ${fixed} finding${fixed === 1 ? "" : "s"}.`,
        body: failures[0],
      });
      if (failures.length > 0) setError(new Error(failures.join(" · ")));
      else if (stopped) setHalted({ ran, of: runnable.length });
      else onDone();
    } catch (e) {
      setError(e);
      const { message, fix } = errorText(e);
      toasts.push({ kind: "err", title: message, body: fix });
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Fix ${shown ? runnable.length : "…"} finding${runnable.length === 1 ? "" : "s"}`}
      description="Each one runs its own registered action, with its own plan and its own audit entry."
      width={620}
      footer={
        <>
          {busy ? (
            <Button
              variant="quiet"
              disabled={stopping}
              disabledReason="Stopping — the fix that is running now finishes first."
              title="The fix that is running now finishes; nothing after it starts."
              onClick={() => {
                stop.current = true;
                setStopping(true);
              }}
            >
              {stopping ? "Stopping…" : "Stop after this one"}
            </Button>
          ) : (
            <Button variant="quiet" onClick={halted ? onDone : onClose}>
              {halted ? "Close" : "Cancel"}
            </Button>
          )}
          {!halted && (
            <Button
              busy={busy}
              disabled={!shown || runnable.length === 0}
              disabledReason={
                !shown
                  ? "Waiting for the previews — every fix is planned before anything runs."
                  : (excluded ?? "None of these fixes could be planned, so none of them can run.")
              }
              onClick={apply}
            >
              {busy && progress > 0
                ? `Fixing ${progress} of ${runnable.length}`
                : `Apply ${runnable.length} fix${runnable.length === 1 ? "" : "es"}`}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {error ? <ErrorNote error={error} /> : null}

        {halted && (
          <Callout tone="warn">
            Stopped after {halted.ran} of {halted.of}. The remaining {halted.of - halted.ran}{" "}
            {halted.of - halted.ran === 1 ? "fix was" : "fixes were"} not run and{" "}
            {halted.of - halted.ran === 1 ? "its finding is" : "their findings are"} still open.
          </Callout>
        )}

        {!shown ? (
          <div className="space-y-2">
            <Skeleton height={14} width="60%" />
            <Skeleton height={12} />
            <Skeleton height={12} width="80%" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={costDelta === 0 ? "neutral" : costDelta > 0 ? "warn" : "ok"}>
                <CostDelta usd={costDelta} bare /> est./mo
              </Chip>
              {skipped > 0 && (
                <Chip tone="neutral">
                  {skipped} finding{skipped === 1 ? "" : "s"} with no fix left untouched
                </Chip>
              )}
            </div>

            {runnable.length > 0 && (
              <ul className="divide-y divide-line rounded-card border border-line">
                {runnable.map((r) => (
                  <li key={r.finding.id} className="space-y-1 px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <RiskBadge level={r.plan?.risk ?? r.finding.severity} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-ink">{r.finding.title}</p>
                        <p className="mt-0.5 text-[12.5px] text-ink-mute">{r.plan?.summary}</p>
                        {r.plan && r.plan.costDeltaUsd !== 0 && (
                          <p className="mt-0.5 text-[12px] text-ink-faint">
                            <CostDelta usd={r.plan.costDeltaUsd} suffix="/mo est." />
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {left.length > 0 && (
              <div className="space-y-1.5 rounded-card border border-line px-4 py-3">
                <p className="text-[12.5px] text-ink">
                  {excluded ?? `${left.length} left out.`}
                </p>
                <ul className="space-y-1 text-[12px] text-ink-mute">
                  {left.map((r) => (
                    <li key={r.finding.id}>
                      <span className="text-ink">{r.finding.title}</span> —{" "}
                      {r.plan?.blocked ?? r.error ?? "no preview came back."}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {warnings.length > 0 && (
              <Callout tone="warn">
                <ul className="space-y-1.5">
                  {[...new Set(warnings)].map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}

            <p className="max-w-[70ch] text-[12px] text-ink-faint">
              Every preview above was computed{" "}
              {shown.plannedAt ? <TimeAgo iso={shown.plannedAt} /> : "when this page loaded"},
              before any fix ran. They then run one at a time, so a later fix can behave
              differently from its preview if an earlier one changed the same thing — and you can
              stop between findings. If one fails the rest still run, and the failure is named here
              and in Activity.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/* --------------------------------- dismiss -------------------------------- */

/** How long the typed reason settles before it is planned. */
const REASON_DEBOUNCE_MS = 250;

/**
 * Dismissal is a mutation like any other, so it goes through the same
 * plan-first dialog as Fix. The reason is part of the planned input — the
 * preview quotes exactly the sentence that will be written to the audit log,
 * and an empty one is refused by the action's own schema rather than by a
 * disabled button this screen invented.
 *
 * ponytail: the reason is debounced before planning, so the plan on screen can
 * be up to 250ms behind the keystrokes. It is always the input that executes.
 */
function DismissDialog({
  finding,
  scope,
  onClose,
  onDone,
}: {
  finding: SecurityFinding | null;
  scope: Scope;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [planned, setPlanned] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setPlanned(reason.trim()), REASON_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [reason]);

  // A new finding is a new decision: never carry a reason across.
  useEffect(() => {
    if (finding) {
      setReason("");
      setPlanned("");
    }
  }, [finding]);

  const settling = reason.trim() !== planned;

  return (
    <ActionConfirm
      open={finding !== null}
      onClose={onClose}
      actionId="security.dismissFinding"
      input={{ findingId: finding?.id, reason: planned }}
      scope={scope}
      title="Dismiss this finding"
      description={finding?.title}
      confirmLabel="Dismiss"
      onDone={onDone}
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink-mute">
          Dismissing changes nothing about the system. The finding moves to History with the reason
          below, which is permanent — reopening it later does not erase this.
        </p>
        {finding?.severity === "high" && (
          <Callout tone="warn" compact>
            This is a high-severity finding. Dismissing it does not make it safe.
          </Callout>
        )}
        <label className="block space-y-1.5">
          <span className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Reason</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Accepted — internal-only service behind the VPN"
            autoFocus
          />
        </label>
        <p className="text-[11.5px] text-ink-faint">
          {settling
            ? "Updating the preview for what you typed…"
            : "The preview below is for exactly this reason."}
        </p>
      </div>
    </ActionConfirm>
  );
}
