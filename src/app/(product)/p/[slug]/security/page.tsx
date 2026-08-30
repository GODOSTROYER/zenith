"use client";
/**
 * Security — what the scanner found, what fixes it, and what someone decided
 * to live with. Fixes are ordinary actions, so they plan before they apply and
 * land in the audit trail like every other change.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { executeAction } from "@/lib/client/api";
import type { SecurityFinding } from "@/lib/domain/types";
import {
  Button,
  Card,
  Chip,
  Dialog,
  EmptyState,
  Input,
  RiskBadge,
  Skeleton,
  TimeAgo,
} from "@/components/ui";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ActionConfirm, ErrorNote, useSafeToasts } from "@/components/screens/shared";

const SEVERITY_ORDER: SecurityFinding["severity"][] = ["high", "medium", "low"];
const SEVERITY_TITLE: Record<SecurityFinding["severity"], string> = {
  high: "High severity",
  medium: "Medium severity",
  low: "Low severity",
};

export default function SecurityPage() {
  const { data, env, projectId, slug, refresh } = useSelectedEnv();
  const [fixing, setFixing] = useState<SecurityFinding | null>(null);
  const [dismissing, setDismissing] = useState<SecurityFinding | null>(null);

  const findings = useMemo(() => data?.findings ?? [], [data]);
  const open = findings.filter((f) => f.status === "open");
  const history = findings.filter((f) => f.status !== "open");

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
        SEVERITY_ORDER.map((sev) => {
          const group = open.filter((f) => f.severity === sev);
          if (group.length === 0) return null;
          return (
            <section key={sev}>
              <h2 className="mb-3 flex items-center gap-2 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                {SEVERITY_TITLE[sev]}
                <span className="tnum text-ink-faint">{group.length}</span>
              </h2>
              <Card padded={false}>
                <ul>
                  {group.map((f) => (
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
            </section>
          );
        })
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
