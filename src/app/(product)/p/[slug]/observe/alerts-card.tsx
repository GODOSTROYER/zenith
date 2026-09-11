"use client";
/**
 * The Alerts section on Observe: the rules, the open alerts and the record of
 * past ones.
 *
 * The honesty this screen has to carry has two halves now that delivery exists:
 *
 *  - **Where an alert goes** is read from the workspace, never asserted. The
 *    server writes `feed.delivery` from the channels that are actually enabled,
 *    so a workspace with none is told it is on-screen only and one with two is
 *    told which two. No copy on this screen guesses.
 *  - **What actually happened** is shown per alert. `event.deliveries` is a
 *    list of attempts: delivered, or failed with the reason and the fix. An
 *    empty list means Zenith tried and had nowhere to send; a missing list
 *    means the alert predates channels. Those are three different sentences and
 *    this screen writes all three.
 */
import { useState } from "react";
import { BellRing, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useAlertHistory, type ProjectAlerts, type PublicAlertChannel } from "@/lib/client/alerts";
import type { AlertEvent, AlertRule } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo } from "@/components/ui/time-ago";
import { ActionConfirm, ErrorNote, SimulatedChip } from "@/components/screens/shared";
import { AckDialog, CreateDialog, EditDialog } from "./alert-dialogs";
import { failedNames, ruleChannelLine, ruleLabel, type Kinds } from "./alert-labels";

const SEVERITY_TONE: Record<AlertEvent["severity"], ChipTone> = {
  high: "err",
  medium: "warn",
  low: "info",
};

/**
 * The fallback delivery sentence, used only before the feed has answered. Once
 * it has, `feed.delivery` — written by the server from this workspace's actual
 * channels — replaces it everywhere.
 */
const DELIVERY_UNKNOWN =
  "Alerts always show here. Whether they are also sent to a webhook, Slack or email depends on the delivery channels under Settings → Alerts.";

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
  const channels = alerts.channels;
  /** Written by the server from this workspace's channels — never guessed here. */
  const delivery = alerts.data?.delivery ?? DELIVERY_UNKNOWN;
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
          ? `${environmentName} · evaluates every ${Math.round(alerts.data.evaluationIntervalMs / 1000)}s · ${delivery}`
          : environmentName
      }
      actions={
        <>
          <SimulatedChip title="Every condition Zenith can evaluate today reads generated health or estimated cost." />
          {kinds && (
            <Button size="sm" variant="quiet" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: "create" })}>
              Add rule
            </Button>
          )}
        </>
      }
      footer={alerts.data ? <span>Last evaluated <TimeAgo iso={alerts.data.evaluatedAt} /> · {rules.length} rule{rules.length === 1 ? "" : "s"} · {open.length} open alert{open.length === 1 ? "" : "s"}</span> : undefined}
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
              Watch service health, failed deployments, budget, or replica counts. When a condition is met, its alert stays open until it clears. {delivery}
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
            channels={channels}
            onEdit={(rule) => setDialog({ kind: "edit", rule })}
            onDelete={(rule) => setDialog({ kind: "delete", rule })}
          />
          <OpenEvents
            open={open}
            channels={channels}
            onAck={(event) => setDialog({ kind: "ack", event })}
          />
          <History
            projectId={projectId}
            environmentId={environmentId}
            recent={alerts.data.recent}
            channels={channels}
          />
        </div>
      )}

      {dialog?.kind === "create" && kinds && (
        <CreateDialog
          kinds={kinds}
          scope={scope}
          environmentName={environmentName}
          channels={channels}
          delivery={delivery}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.kind === "edit" && kinds && (
        <EditDialog
          rule={dialog.rule}
          kinds={kinds}
          scope={scope}
          channels={channels}
          delivery={delivery}
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

/* -------------------------------- delivery -------------------------------- */

/**
 * What happened when this alert was pushed out. Three states, three sentences:
 * nothing recorded (the alert predates channels), nowhere to send, or the
 * per-channel results including the failures — a failure is shown with its
 * reason, never hidden behind a count.
 */
function Deliveries({
  event,
  channels,
}: {
  event: AlertEvent;
  channels: PublicAlertChannel[];
}) {
  const rows = event.deliveries;
  if (rows === undefined)
    return (
      <p className="mt-1 text-[11.5px] text-ink-faint">
        No delivery recorded for this alert — it fired before this workspace had channels.
      </p>
    );
  if (rows.length === 0)
    return (
      <p className="mt-1 text-[11.5px] text-ink-faint">
        Not sent anywhere: no delivery channel was enabled when it fired.
      </p>
    );

  const nameOf = (id: string) => channels.find((c) => c.id === id)?.name ?? "a deleted channel";
  return (
    <ul className="mt-1 space-y-0.5">
      {rows.map((d, i) => (
        <li key={`${d.channelId}-${d.at}-${i}`} className="text-[11.5px] leading-relaxed">
          {d.ok ? (
            <span className="text-ok">
              Delivered to {nameOf(d.channelId)} <TimeAgo iso={d.at} />
              {d.status ? ` · HTTP ${d.status}` : ""}
            </span>
          ) : (
            <span className="text-err">
              Failed to reach {nameOf(d.channelId)} <TimeAgo iso={d.at} />
              {d.error ? `: ${d.error}` : "."}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------- rules --------------------------------- */

function RuleList({
  rules,
  kinds,
  open,
  channels,
  onEdit,
  onDelete,
}: {
  rules: AlertRule[];
  kinds: Kinds;
  open: AlertEvent[];
  channels: PublicAlertChannel[];
  onEdit: (rule: AlertRule) => void;
  onDelete: (rule: AlertRule) => void;
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-[13px] font-medium text-ink">
        Rules ({rules.length})
      </h4>
      {rules.map((rule) => {
        const firing = open.some((e) => e.ruleId === rule.id);
        return (
          <div
            key={rule.id}
            className="flex flex-wrap items-start justify-between gap-3 border-b border-line py-3 last:border-b-0"
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
              <p className="mt-1 text-[12px] leading-relaxed text-ink-mute">
                Watches {kinds[rule.kind]?.watches ?? rule.kind}. {ruleChannelLine(rule, channels)}{" "}
                Added by {rule.createdBy?.name ?? "someone"} <TimeAgo iso={rule.createdAt} />.
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

function OpenEvents({
  open,
  channels,
  onAck,
}: {
  open: AlertEvent[];
  channels: PublicAlertChannel[];
  onAck: (e: AlertEvent) => void;
}) {
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h4 className="text-[13px] font-medium text-ink">
        Open ({open.length})
      </h4>
      {open.length === 0 ? (
        <p className="text-[13px] text-ink-mute">
          Nothing is firing. An open alert would appear here and at the top of this page.
        </p>
      ) : (
        open.map((event) => (
          <div key={event.id} className="border-l-2 border-warn bg-bg1 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={SEVERITY_TONE[event.severity]}>{event.severity}</Chip>
                  <span className="text-[13px] text-ink">{event.summary}</span>
                  {event.simulated && (
                    <SimulatedChip title="This condition read generated health or estimated cost." />
                  )}
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
                  Fired <TimeAgo iso={event.firedAt} />. {event.detail}
                </p>
                <Deliveries event={event} channels={channels} />
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
  channels,
}: {
  projectId: string | undefined;
  environmentId: string;
  recent: AlertEvent[];
  channels: PublicAlertChannel[];
}) {
  const [full, setFull] = useState(false);
  // Held off until asked for: `null` tells useJson not to fetch at all.
  const history = useAlertHistory(full ? projectId : null, environmentId, FULL_HISTORY);
  const rows = (full ? history.data?.events?.filter((e) => e.resolvedAt) : recent) ?? recent;

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-medium text-ink">Past alerts</h4>
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
        <ul className="divide-y divide-line">
          {rows.map((event) => (
            <li key={event.id} className="py-3 text-[13px] leading-relaxed text-ink-mute">
              <span className="text-ink-faint">
                <TimeAgo iso={event.firedAt} /> ·{" "}
              </span>
              {event.summary}{" "}
              <span className="text-ink-faint">
                Closed {event.resolvedAt ? <TimeAgo iso={event.resolvedAt} /> : "—"}
                {event.resolvedReason ? `: ${event.resolvedReason}` : "."}
              </span>
              {/* Only the failures: a successful delivery on a closed alert is
                  not news, an alert that never reached anyone is. */}
              {failedNames(event, channels) && (
                <span className="text-err"> Never reached {failedNames(event, channels)}.</span>
              )}
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
