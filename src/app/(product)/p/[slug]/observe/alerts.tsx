"use client";
/**
 * Alerts on Observe: the banner above health, and the section that owns the
 * rules, the open alerts and the record of past ones.
 *
 * The honesty this screen has to carry: an alert here is a record and a
 * notification *inside Orrery*. It does not email, page or post anywhere. The
 * empty state says that before anyone creates their first rule, and the section
 * subtitle keeps saying it afterwards.
 */
import { useState } from "react";
import { BellRing, Check, Pencil, Plus, Trash2 } from "lucide-react";
import type { AlertKindSpec } from "@/lib/alerts";
import { useAlertHistory, type AlertsFeed, type ProjectAlerts } from "@/lib/client/alerts";
import type { AlertEvent, AlertKind, AlertRule } from "@/lib/domain/types";
import {
  Button,
  Callout,
  Card,
  Chip,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  TimeAgo,
  type ChipTone,
} from "@/components/ui";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";

const SEVERITY_TONE: Record<AlertEvent["severity"], ChipTone> = {
  high: "err",
  medium: "warn",
  low: "info",
};

/** The one sentence this whole feature has to keep saying. */
const DELIVERY =
  "Alerts are in-product only: they show here and anywhere else in Orrery that reads them. There is no email, Slack or webhook delivery, so nothing reaches you while Orrery is closed.";

type Kinds = AlertsFeed["kinds"];

const effectiveThreshold = (rule: Pick<AlertRule, "kind" | "threshold">, kinds: Kinds) =>
  rule.threshold ?? kinds[rule.kind]?.threshold?.default;

function ruleLabel(rule: Pick<AlertRule, "kind" | "threshold">, kinds: Kinds): string {
  const spec: AlertKindSpec | undefined = kinds[rule.kind];
  if (!spec) return rule.kind;
  return spec.threshold
    ? `${spec.title} (${effectiveThreshold(rule, kinds)}${spec.threshold.unit})`
    : spec.title;
}

/* --------------------------------- banner --------------------------------- */

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
          . Nothing was emailed or posted anywhere — Orrery has no delivery channels.
        </p>
      </div>
    </Callout>
  );
}

/* --------------------------------- section -------------------------------- */

type Dialog =
  | { kind: "create" }
  | { kind: "edit"; rule: AlertRule }
  | { kind: "delete"; rule: AlertRule }
  | { kind: "ack"; event: AlertEvent };

export function AlertsCard({
  projectId,
  environmentId,
  environmentName,
  alerts,
}: {
  projectId: string | undefined;
  environmentId: string;
  environmentName: string;
  alerts: ProjectAlerts;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const kinds = alerts.data?.kinds;
  const rules = alerts.rules;
  const open = alerts.open;
  const scope = { projectId, environmentId };
  const done = () => {
    setDialog(null);
    alerts.refresh();
  };

  return (
    <div id="alerts" className="scroll-mt-6">
    <Card
      title="Alerts"
      subtitle={
        alerts.data
          ? `${environmentName} · checked every ${Math.round(alerts.data.evaluationIntervalMs / 1000)}s and whenever this page loads · in-product only, no email or Slack`
          : environmentName
      }
      actions={
        <>
          <Chip tone="info" title="Every condition Orrery can evaluate today reads generated health or estimated cost.">
            simulated
          </Chip>
          {kinds && (
            <Button size="sm" variant="quiet" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: "create" })}>
              Add rule
            </Button>
          )}
        </>
      }
    >
      {alerts.error ? (
        <ErrorNote error={alerts.error} />
      ) : !alerts.data || !kinds ? (
        <Skeleton height={120} />
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<BellRing className="h-5 w-5" />}
          title={`No alert rules on ${environmentName}`}
          body={
            <>
              A rule watches one condition — a degraded service, a failed deployment, cost against
              the budget, replicas under a floor — and records it here when it becomes true, once,
              until it clears. {DELIVERY}
            </>
          }
          action={
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: "create" })}>
              Add the first rule
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <RuleList
            rules={rules}
            kinds={kinds}
            open={open}
            onEdit={(rule) => setDialog({ kind: "edit", rule })}
            onDelete={(rule) => setDialog({ kind: "delete", rule })}
          />
          <OpenEvents open={open} onAck={(event) => setDialog({ kind: "ack", event })} />
          <History
            projectId={projectId}
            environmentId={environmentId}
            recent={alerts.data.recent}
          />
        </div>
      )}

      {dialog?.kind === "create" && kinds && (
        <CreateDialog
          kinds={kinds}
          scope={scope}
          environmentName={environmentName}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.kind === "edit" && kinds && (
        <EditDialog
          rule={dialog.rule}
          kinds={kinds}
          scope={scope}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.kind === "delete" && kinds && (
        <ActionConfirm
          open
          onClose={() => setDialog(null)}
          actionId="alerts.deleteRule"
          input={{ ruleId: dialog.rule.id }}
          scope={scope}
          danger
          title={`Delete "${ruleLabel(dialog.rule, kinds)}"`}
          description={`${environmentName} stops being watched for this. Past alerts stay under history.`}
          confirmLabel="Delete rule"
          onDone={done}
        />
      )}
      {dialog?.kind === "ack" && (
        <AckDialog event={dialog.event} scope={scope} onClose={() => setDialog(null)} onDone={done} />
      )}
    </Card>
    </div>
  );
}

/* --------------------------------- rules ---------------------------------- */

function RuleList({
  rules,
  kinds,
  open,
  onEdit,
  onDelete,
}: {
  rules: AlertRule[];
  kinds: Kinds;
  open: AlertEvent[];
  onEdit: (rule: AlertRule) => void;
  onDelete: (rule: AlertRule) => void;
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
        Rules ({rules.length})
      </h4>
      {rules.map((rule) => {
        const firing = open.some((e) => e.ruleId === rule.id);
        return (
          <div
            key={rule.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-line bg-bg1 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-ink">{ruleLabel(rule, kinds)}</span>
                {!rule.enabled ? (
                  <Chip tone="neutral" title="Turned off: it is not evaluated at all.">
                    off
                  </Chip>
                ) : firing ? (
                  <Chip tone="err">firing</Chip>
                ) : (
                  <Chip tone="ok">clear</Chip>
                )}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
                Watches {kinds[rule.kind]?.watches ?? rule.kind}. Added by{" "}
                {rule.createdBy?.name ?? "someone"} <TimeAgo iso={rule.createdAt} />.
              </p>
            </div>
            <span className="flex shrink-0 items-center">
              <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => onEdit(rule)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => onDelete(rule)}>
                Delete
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------- events --------------------------------- */

function OpenEvents({ open, onAck }: { open: AlertEvent[]; onAck: (e: AlertEvent) => void }) {
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
        Open ({open.length})
      </h4>
      {open.length === 0 ? (
        <p className="text-[13px] text-ink-mute">
          Nothing is firing. An open alert would appear here and at the top of this page.
        </p>
      ) : (
        open.map((event) => (
          <div key={event.id} className="rounded-card border border-line bg-bg1 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={SEVERITY_TONE[event.severity]}>{event.severity}</Chip>
                  <span className="text-[13px] text-ink">{event.summary}</span>
                  {event.simulated && (
                    <Chip tone="info" title="This condition read generated health or estimated cost.">
                      simulated
                    </Chip>
                  )}
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
                  Fired <TimeAgo iso={event.firedAt} />. {event.detail}
                </p>
                {event.acknowledgedAt && (
                  <p className="mt-1 text-[11.5px] text-ink-mute">
                    Acknowledged by {event.acknowledgedBy?.name ?? "someone"}{" "}
                    <TimeAgo iso={event.acknowledgedAt} />
                    {event.acknowledgedNote ? `: “${event.acknowledgedNote}”` : "."} It stays open
                    until the condition clears.
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="quiet"
                icon={<Check className="h-3.5 w-3.5" />}
                disabled={!!event.acknowledgedAt}
                disabledReason={`${event.acknowledgedBy?.name ?? "Someone"} already acknowledged this. It closes on its own when the condition clears.`}
                onClick={() => onAck(event)}
              >
                Acknowledge
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const FULL_HISTORY = 200;

function History({
  projectId,
  environmentId,
  recent,
}: {
  projectId: string | undefined;
  environmentId: string;
  recent: AlertEvent[];
}) {
  const [full, setFull] = useState(false);
  // Held off until asked for: `null` tells useJson not to fetch at all.
  const history = useAlertHistory(full ? projectId : null, environmentId, FULL_HISTORY);
  const rows = (full ? history.data?.events?.filter((e) => e.resolvedAt) : recent) ?? recent;

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Past alerts</h4>
        {!full && recent.length > 0 && (
          <Button size="sm" variant="quiet" onClick={() => setFull(true)}>
            Load full history
          </Button>
        )}
      </div>
      {history.error && <ErrorNote error={history.error} />}
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-mute">
          No alert has closed yet. Once one does, the record of it stays here — including for rules
          that were deleted afterwards.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((event) => (
            <li key={event.id} className="text-[12.5px] leading-relaxed text-ink-mute">
              <span className="text-ink-faint">
                <TimeAgo iso={event.firedAt} /> ·{" "}
              </span>
              {event.summary}{" "}
              <span className="text-ink-faint">
                Closed {event.resolvedAt ? <TimeAgo iso={event.resolvedAt} /> : "—"}
                {event.resolvedReason ? `: ${event.resolvedReason}` : "."}
              </span>
            </li>
          ))}
        </ul>
      )}
      {full && history.loading && <Skeleton height={40} />}
      {full && !history.loading && (
        <p className="text-[11.5px] text-ink-faint">
          The newest {FULL_HISTORY} alerts for this environment. Anything older is still on disk,
          one page further through /api/projects/:id/alerts/events.
        </p>
      )}
    </div>
  );
}

/* --------------------------------- dialogs -------------------------------- */

function CreateDialog({
  kinds,
  scope,
  environmentName,
  onClose,
  onDone,
}: {
  kinds: Kinds;
  scope: { projectId: string | undefined; environmentId: string };
  environmentName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const entries = Object.entries(kinds) as [AlertKind, AlertKindSpec][];
  const [kind, setKind] = useState<AlertKind>(entries[0][0]);
  const spec = kinds[kind];
  const [threshold, setThreshold] = useState<string>(String(spec.threshold?.default ?? ""));

  const pick = (next: AlertKind) => {
    setKind(next);
    setThreshold(String(kinds[next].threshold?.default ?? ""));
  };
  const value = Number(threshold);
  const usable = spec.threshold ? Number.isFinite(value) : true;

  return (
    <ActionConfirm
      open
      onClose={onClose}
      actionId="alerts.createRule"
      input={{
        ...scope,
        kind,
        threshold: spec.threshold && usable ? value : undefined,
      }}
      scope={scope}
      title={`Watch ${environmentName}`}
      description={DELIVERY}
      confirmLabel="Create rule"
      onDone={onDone}
    >
      <div className="space-y-3">
        <Field label="Condition" help={spec.watches}>
          <Select
            value={kind}
            onChange={(e) => pick(e.target.value as AlertKind)}
            options={entries.map(([id, s]) => ({ value: id, label: s.title }))}
          />
        </Field>
        {spec.threshold && (
          <Field
            label={spec.threshold.label}
            help={`Between ${spec.threshold.min}${spec.threshold.unit} and ${spec.threshold.max}${spec.threshold.unit}.`}
            error={usable ? undefined : "Enter a number."}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={spec.threshold.min}
              max={spec.threshold.max}
              value={threshold}
              suffix={spec.threshold.unit.trim() || undefined}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </Field>
        )}
      </div>
    </ActionConfirm>
  );
}

function EditDialog({
  rule,
  kinds,
  scope,
  onClose,
  onDone,
}: {
  rule: AlertRule;
  kinds: Kinds;
  scope: { projectId: string | undefined; environmentId: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const spec = kinds[rule.kind];
  const [threshold, setThreshold] = useState<string>(
    String(effectiveThreshold(rule, kinds) ?? "")
  );
  const [enabled, setEnabled] = useState(rule.enabled);
  const value = Number(threshold);
  const usable = spec.threshold ? Number.isFinite(value) : true;
  const changedThreshold = spec.threshold && usable && value !== effectiveThreshold(rule, kinds);

  return (
    <ActionConfirm
      open
      onClose={onClose}
      actionId="alerts.updateRule"
      input={{
        ruleId: rule.id,
        threshold: changedThreshold ? value : undefined,
        enabled: enabled === rule.enabled ? undefined : enabled,
      }}
      scope={scope}
      title={`Edit "${ruleLabel(rule, kinds)}"`}
      description={DELIVERY}
      confirmLabel="Save rule"
      onDone={onDone}
    >
      <div className="space-y-3">
        {spec.threshold && (
          <Field
            label={spec.threshold.label}
            help={`Between ${spec.threshold.min}${spec.threshold.unit} and ${spec.threshold.max}${spec.threshold.unit}.`}
            error={usable ? undefined : "Enter a number."}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={spec.threshold.min}
              max={spec.threshold.max}
              value={threshold}
              suffix={spec.threshold.unit.trim() || undefined}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </Field>
        )}
        <Field
          label="Evaluation"
          help="Turning a rule off stops it being checked and closes any alert it has open."
        >
          <Select
            value={enabled ? "on" : "off"}
            onChange={(e) => setEnabled(e.target.value === "on")}
            options={[
              { value: "on", label: "Watching" },
              { value: "off", label: "Turned off" },
            ]}
          />
        </Field>
      </div>
    </ActionConfirm>
  );
}

function AckDialog({
  event,
  scope,
  onClose,
  onDone,
}: {
  event: AlertEvent;
  scope: { projectId: string | undefined; environmentId: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <ActionConfirm
      open
      onClose={onClose}
      actionId="alerts.acknowledge"
      input={{ eventId: event.id, note: note.trim() || undefined }}
      scope={scope}
      title="Acknowledge alert"
      description="Records that you have seen it. It does not change the system, and it does not close the alert — that happens when the condition clears."
      confirmLabel="Acknowledge"
      onDone={onDone}
    >
      <Field label="Note (optional)" help="Kept on the alert and in the audit trail.">
        <Input
          value={note}
          placeholder="Looking at it — scaling api back up"
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </ActionConfirm>
  );
}
