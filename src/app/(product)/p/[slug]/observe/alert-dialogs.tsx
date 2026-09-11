"use client";
/**
 * The dialogs the Alerts section opens: add a rule, edit one, acknowledge an
 * open alert, and the channel picker the first two share. Each one runs
 * plan-first through the action registry.
 */
import { useState } from "react";
import type { AlertKindSpec } from "@/lib/alerts";
import type { AlertEvent, AlertKind, AlertRule } from "@/lib/domain/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { PublicAlertChannel } from "@/lib/client/alerts";
import { ActionConfirm } from "@/components/screens/shared";
import { effectiveThreshold, ruleLabel, type Kinds } from "./alert-labels";

/* --------------------------------- dialogs -------------------------------- */

/**
 * Which channels a rule delivers to. "Every enabled channel" is the default and
 * stays the default — picking channels explicitly writes `channelIds`, and
 * unticking all of them writes `[]`, which is how a rule is kept on screen only.
 */
export function ChannelPicker({
  channels,
  selected,
  onChange,
}: {
  channels: PublicAlertChannel[];
  /** undefined = every enabled channel */
  selected: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const enabled = channels.filter((c) => c.enabled);
  if (enabled.length === 0)
    return (
      <Field label="Delivery">
        <p className="text-[12.5px] text-ink-mute">
          This workspace has no enabled delivery channels, so this alert will only ever be on
          screen. Add one under Settings → Alerts.
        </p>
      </Field>
    );

  return (
    <Field
      label="Delivery"
      help="Every enabled channel by default. Pick channels to narrow it; untick them all to keep this rule on screen only."
    >
      <div className="space-y-1.5">
        <Checkbox
          checked={selected === undefined}
          onChange={(all) => onChange(all ? undefined : enabled.map((c) => c.id))}
          label="Every enabled channel"
          help={`Right now: ${enabled.map((c) => c.name).join(", ")}. A channel added later is included automatically.`}
        />
        {selected !== undefined &&
          enabled.map((c) => (
            <Checkbox
              key={c.id}
              className="ml-5"
              checked={selected.includes(c.id)}
              onChange={(on) =>
                onChange(on ? [...selected, c.id] : selected.filter((id) => id !== c.id))
              }
              label={`${c.name} (${c.kind})`}
            />
          ))}
      </div>
    </Field>
  );
}

export function CreateDialog({
  kinds,
  scope,
  environmentName,
  channels,
  delivery,
  onClose,
  onDone,
}: {
  kinds: Kinds;
  scope: { projectId: string | undefined; environmentId: string };
  environmentName: string;
  channels: PublicAlertChannel[];
  delivery: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const entries = Object.entries(kinds) as [AlertKind, AlertKindSpec][];
  const [kind, setKind] = useState<AlertKind>(entries[0][0]);
  const spec = kinds[kind];
  const [threshold, setThreshold] = useState<string>(String(spec.threshold?.default ?? ""));
  const [channelIds, setChannelIds] = useState<string[] | undefined>(undefined);

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
        channelIds,
      }}
      scope={scope}
      title={`Watch ${environmentName}`}
      description={delivery}
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
        <ChannelPicker channels={channels} selected={channelIds} onChange={setChannelIds} />
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

export function EditDialog({
  rule,
  kinds,
  scope,
  channels,
  delivery,
  onClose,
  onDone,
}: {
  rule: AlertRule;
  kinds: Kinds;
  scope: { projectId: string | undefined; environmentId: string };
  channels: PublicAlertChannel[];
  delivery: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const spec = kinds[rule.kind];
  const [threshold, setThreshold] = useState<string>(
    String(effectiveThreshold(rule, kinds) ?? "")
  );
  const [enabled, setEnabled] = useState(rule.enabled);
  const [channelIds, setChannelIds] = useState<string[] | undefined>(rule.channelIds);
  const value = Number(threshold);
  const usable = spec.threshold ? Number.isFinite(value) : true;
  const changedThreshold = spec.threshold && usable && value !== effectiveThreshold(rule, kinds);
  const changedChannels =
    JSON.stringify(channelIds ?? null) !== JSON.stringify(rule.channelIds ?? null);

  return (
    <ActionConfirm
      open
      onClose={onClose}
      actionId="alerts.updateRule"
      input={{
        ruleId: rule.id,
        threshold: changedThreshold ? value : undefined,
        // null, not undefined: "back to every enabled channel" and "leave the
        // selection alone" are different requests and the action reads both.
        channelIds: changedChannels ? (channelIds ?? null) : undefined,
        enabled: enabled === rule.enabled ? undefined : enabled,
      }}
      scope={scope}
      title={`Edit "${ruleLabel(rule, kinds)}"`}
      description={delivery}
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
        <ChannelPicker channels={channels} selected={channelIds} onChange={setChannelIds} />
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

export function AckDialog({
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
