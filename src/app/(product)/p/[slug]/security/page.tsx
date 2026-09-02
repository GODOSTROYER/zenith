"use client";
/**
 * Security — what the scanner found, what fixes it, and what someone decided
 * to live with. Fixes are ordinary actions, so they plan before they apply and
 * land in the audit trail like every other change.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldCheck, Wrench } from "lucide-react";
import type { ActionPlan } from "@/lib/actions/core";
import { executeAction, planAction } from "@/lib/client/api";
import type { SecurityFinding } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
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
import { ActionConfirm, ErrorNote, errorText, useSafeToasts } from "@/components/screens/shared";

const SEVERITY_ORDER: SecurityFinding["severity"][] = ["high", "medium", "low"];

type SeverityFilter = "all" | SecurityFinding["severity"];
type FixFilter = "all" | "fixable" | "manual";
type SortKey = "severity" | "newest" | "oldest";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "severity", label: "Highest severity first" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const byDate = (a: SecurityFinding, b: SecurityFinding) => (a.createdAt < b.createdAt ? 1 : -1);

export default function SecurityPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const [fixing, setFixing] = useState<SecurityFinding | null>(null);
  const [dismissing, setDismissing] = useState<SecurityFinding | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [fixable, setFixable] = useState<FixFilter>("all");
  const [sort, setSort] = useState<SortKey>("severity");

  const findings = useMemo(() => data?.findings ?? [], [data]);
  const open = useMemo(() => findings.filter((f) => f.status === "open"), [findings]);
  const history = findings.filter((f) => f.status !== "open");
  const autoFixable = useMemo(() => open.filter((f) => f.fix), [open]);
  const manualOnly = open.length - autoFixable.length;

  const visible = useMemo(() => {
    const rows = open.filter(
      (f) =>
        (severity === "all" || f.severity === severity) &&
        (fixable === "all" || (fixable === "fixable") === !!f.fix)
    );
    return rows.sort(
      sort === "severity"
        ? (a, b) =>
            SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || byDate(a, b)
        : sort === "newest"
          ? byDate
          : (a, b) => -byDate(a, b)
    );
  }, [open, severity, fixable, sort]);

  if (!data)
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={20} width="30%" />
        <Skeleton height={220} />
      </div>
    );

  const scope = { projectId, environmentId: env?.id };

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[980px] space-y-6 px-6 py-6">
      {open.length === 0 ? (
        <div className="rounded-card border border-ok/30 bg-ok-dim">
          <EmptyState
            icon={<ShieldCheck className="h-5 w-5 text-ok" />}
            title="No open findings."
            body="The scanner has nothing outstanding on this system. It re-runs every time the project loads."
          />
        </div>
      ) : (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<SeverityFilter>
              size="sm"
              label="Filter by severity"
              value={severity}
              onChange={setSeverity}
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
              value={fixable}
              onChange={setFixable}
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
              className="w-[210px]"
              aria-label="Sort findings"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              options={SORTS}
            />
            <Button
              className="ml-auto"
              size="sm"
              icon={<Wrench className="h-3.5 w-3.5" />}
              disabled={autoFixable.length === 0}
              disabledReason={
                open.length === 0
                  ? "Nothing is open to fix."
                  : `None of the ${open.length} open finding${open.length === 1 ? " has" : "s have"} an automatic fix — change the system, then dismiss each with a reason.`
              }
              title="Preview every automatic fix, then run them"
              onClick={() => setBulkOpen(true)}
            >
              Fix all {autoFixable.length}
            </Button>
          </div>

          <p className="text-[12px] text-ink-faint">
            {visible.length === open.length
              ? `${open.length} open finding${open.length === 1 ? "" : "s"}`
              : `${visible.length} of ${open.length} open findings shown`}
            {manualOnly > 0 &&
              ` · ${manualOnly} ${manualOnly === 1 ? "has" : "have"} no automatic fix and ${manualOnly === 1 ? "is" : "are"} left out of “Fix all”`}
          </p>

          {visible.length === 0 ? (
            <Card>
              <p className="text-[13px] text-ink-mute">
                No open finding matches these filters. Widen them to see the other{" "}
                {open.length - visible.length}.
              </p>
            </Card>
          ) : (
            <Card padded={false}>
              <ul>
                {visible.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-start gap-4 border-b border-line px-5 py-4 last:border-b-0"
                  >
                    <RiskBadge level={f.severity} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[14px] text-ink">{f.title}</h3>
                      <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                        {f.detail}
                      </p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
                        <TimeAgo iso={f.createdAt} prefix="found" />
                        {f.targetId && slug && (
                          <Link
                            href={`/p/${slug}?select=${f.targetId}`}
                            className="font-mono text-signal hover:underline"
                          >
                            show on map
                          </Link>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        disabled={!f.fix}
                        disabledReason="This finding has no automatic fix — change the system, then dismiss it with a reason."
                        onClick={() => setFixing(f)}
                        title={f.fix?.label}
                      >
                        {f.fix ? "Fix" : "No auto-fix"}
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setDismissing(f)}>
                        Dismiss
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}

      {history.length > 0 && (
        <details className="rounded-card border border-line bg-bg2">
          <summary className="cursor-pointer px-5 py-3 text-[13px] text-ink-mute select-none hover:text-ink">
            History — {history.length} resolved or dismissed
          </summary>
          <ul className="border-t border-line">
            {history.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 border-b border-line px-5 py-3 text-[12.5px] last:border-b-0"
              >
                <Chip tone={f.status === "resolved" ? "ok" : "neutral"}>{f.status}</Chip>
                <span className="min-w-0 flex-1 truncate text-ink">{f.title}</span>
                <span className="shrink-0 text-ink-faint">
                  <TimeAgo iso={f.createdAt} />
                </span>
              </li>
            ))}
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

      {bulkOpen && (
        <BulkFixDialog
          findings={autoFixable}
          skipped={manualOnly}
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

/* -------------------------------- bulk fix -------------------------------- */

interface PlanRow {
  finding: SecurityFinding;
  plan?: ActionPlan;
  error?: string;
}

/**
 * Plan-first, N times over: every fixable finding is previewed with its own
 * plan before a single one runs, and the fixes then run one at a time through
 * the same action the single-finding Fix button uses.
 */
function BulkFixDialog({
  findings,
  skipped,
  scope,
  onClose,
  onDone,
}: {
  findings: SecurityFinding[];
  /** open findings with no automatic fix — honestly excluded, never counted in */
  skipped: number;
  scope: { projectId?: string; environmentId?: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const toasts = useSafeToasts();
  const [rows, setRows] = useState<PlanRow[]>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>();

  const list = useRef(findings);
  list.current = findings;
  const idKey = findings.map((f) => f.id).join(",");
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let alive = true;
    setRows(undefined);
    const s = JSON.parse(scopeKey) as typeof scope;
    Promise.all(
      list.current.map((finding) =>
        planAction("security.resolveFinding", {
          input: { findingId: finding.id, applyFix: true },
          scope: s,
        })
          .then((plan): PlanRow => ({ finding, plan }))
          .catch((e: unknown): PlanRow => ({ finding, error: errorText(e).message }))
      )
    ).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [idKey, scopeKey]);

  const runnable = rows?.filter((r) => r.plan) ?? [];
  const unplannable = rows?.filter((r) => !r.plan) ?? [];
  const costDelta = runnable.reduce((sum, r) => sum + (r.plan?.costDeltaUsd ?? 0), 0);
  const warnings = runnable.flatMap((r) => r.plan?.warnings ?? []);

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    const failures: string[] = [];
    let fixed = 0;
    try {
      for (const [i, r] of runnable.entries()) {
        setProgress(i + 1);
        const result = await executeAction("security.resolveFinding", {
          input: { findingId: r.finding.id, applyFix: true },
          scope,
        });
        if (result.ok) fixed++;
        else failures.push(`${r.finding.title}: ${result.error ?? result.summary}`);
      }
      toasts.push({
        kind: failures.length === 0 ? "ok" : "err",
        title:
          failures.length === 0
            ? `Fixed ${fixed} finding${fixed === 1 ? "" : "s"}.`
            : `Fixed ${fixed} of ${runnable.length}; ${failures.length} did not apply.`,
        body: failures[0],
      });
      if (failures.length > 0) setError(new Error(failures.join(" · ")));
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
      title={`Fix ${findings.length} finding${findings.length === 1 ? "" : "s"}`}
      description="Each one runs its own registered action, with its own plan and its own audit entry."
      width={620}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!rows || runnable.length === 0}
            disabledReason={
              !rows
                ? "Waiting for the plans — every fix is previewed before anything runs."
                : "None of these fixes could be planned, so none of them can run."
            }
            onClick={apply}
          >
            {busy && progress > 0
              ? `Fixing ${progress} of ${runnable.length}`
              : `Apply ${runnable.length} fix${runnable.length === 1 ? "" : "es"}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <ErrorNote error={error} /> : null}

        {!rows ? (
          <div className="space-y-2">
            <Skeleton height={14} width="60%" />
            <Skeleton height={12} />
            <Skeleton height={12} width="80%" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={costDelta === 0 ? "neutral" : costDelta > 0 ? "warn" : "ok"}>
                {costDelta === 0 ? "no cost change" : `${fmtUsd(costDelta)} est./mo`}
              </Chip>
              {skipped > 0 && (
                <Chip tone="neutral">
                  {skipped} finding{skipped === 1 ? "" : "s"} with no fix left untouched
                </Chip>
              )}
            </div>

            <ul className="divide-y divide-line rounded-card border border-line">
              {rows.map((r) => (
                <li key={r.finding.id} className="space-y-1 px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <RiskBadge level={r.plan?.risk ?? r.finding.severity} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-ink">{r.finding.title}</p>
                      <p className="mt-0.5 text-[12.5px] text-ink-mute">
                        {r.plan?.summary ?? r.error}
                      </p>
                      {r.plan && r.plan.costDeltaUsd !== 0 && (
                        <p className="tnum mt-0.5 text-[12px] text-ink-faint">
                          {fmtUsd(r.plan.costDeltaUsd)} est./mo
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {unplannable.length > 0 && (
              <p className="text-[12.5px] text-ink-mute">
                {unplannable.length} of these could not be planned and will be skipped. Open each
                one on its own to see why.
              </p>
            )}

            {warnings.length > 0 && (
              <ul className="space-y-1.5 rounded-card border border-warn/30 bg-warn-dim px-4 py-3 text-[13px] text-ink">
                {[...new Set(warnings)].map((w, i) => (
                  <li key={i} className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-[12px] text-ink-faint">
              They run one at a time. If one fails the rest still run, and the failure is named
              here and in Activity.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

function DismissDialog({
  finding,
  scope,
  onClose,
  onDone,
}: {
  finding: SecurityFinding | null;
  scope: { projectId?: string; environmentId?: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const toasts = useSafeToasts();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const submit = async () => {
    if (!finding) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await executeAction("security.dismissFinding", {
        input: { findingId: finding.id, reason: reason.trim() },
        scope,
      });
      toasts.push({
        kind: result.ok ? "ok" : "err",
        title: result.summary,
        body: result.ok ? undefined : result.error,
      });
      if (result.ok) {
        setReason("");
        onDone();
      } else setError(new Error(result.error ?? result.summary));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={finding !== null}
      onClose={onClose}
      title="Dismiss this finding"
      description={finding?.title}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!reason.trim()}
            disabledReason="Say why — the reason is written to the audit log."
            onClick={submit}
          >
            Dismiss
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink-mute">
          Dismissing changes nothing about the system. The finding stays visible under History
          and the reason is permanent.
        </p>
        {finding?.severity === "high" && (
          <p className="rounded-card border border-warn/30 bg-warn-dim px-3 py-2 text-[12.5px] text-ink">
            This is a high-severity finding. Dismissing it does not make it safe.
          </p>
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
        {error ? <ErrorNote error={error} /> : null}
      </div>
    </Dialog>
  );
}
