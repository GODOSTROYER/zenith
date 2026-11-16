"use client";
/**
 * Choose how much an environment's agents and automation may do on their own.
 *
 * Six levels, each with its plain-language meaning printed next to its number.
 * Only a workspace admin can change it: for everyone else the six options are
 * visible but disabled, and the reason is printed above them and linked to the
 * group with `aria-describedby`. A change is staged, not applied on click: the
 * admin sees what moves from where to where, and what that unlocks, then saves it
 * explicitly. The control never claims more than it controls: policy can still
 * demand approvals at any level, which the note says.
 */
import { useId, useRef, useState } from "react";
import type { AutonomyLevel, EnvironmentClass } from "@/lib/policy/types";
import { cx } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { AUTONOMY_LEVELS, AUTONOMY_POLICY_NOTE, autonomyInfo } from "./autonomy-levels";
import type { RoleName } from "./labels";

export interface AutonomyControlProps extends AsyncSurfaceProps {
  level: AutonomyLevel;
  /** the viewer's workspace role; only "admin" may change the level */
  viewerRole: RoleName;
  environmentName?: string;
  environmentClass?: EnvironmentClass;
  /** called with the new level when an admin saves; may be async */
  onChange: (next: AutonomyLevel) => void | Promise<void>;
  /** a failure to show under the buttons, for example a refusal from the server */
  actionError?: string;
}

export function adminOnlyReason(role: RoleName): string | undefined {
  if (role === "admin") return undefined;
  const who = role === "none" ? "you are not a member of this workspace" : `you have the ${role} role`;
  return `Only a workspace admin can change the autonomy level, and ${who}. Ask an admin to change it.`;
}

export function AutonomyControl({
  level,
  viewerRole,
  environmentName,
  environmentClass,
  onChange,
  actionError,
  loading,
  error,
  onRetry,
}: AutonomyControlProps) {
  const ids = useId();
  const reasonId = `${ids}-reason`;
  const [draft, setDraft] = useState<AutonomyLevel | null>(null);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const inflight = useRef(false);

  const locked = adminOnlyReason(viewerRole);
  const staged = draft !== null && draft !== level ? draft : null;
  const selected = staged ?? level;
  const from = autonomyInfo(level);
  const to = autonomyInfo(selected);
  const raising = staged !== null && staged > level;
  const production = environmentClass === "production";

  const save = async () => {
    if (staged === null || inflight.current || locked) return;
    inflight.current = true;
    setSaving(true);
    setLocalError(undefined);
    try {
      await onChange(staged);
      setDraft(null);
    } catch (e) {
      setLocalError(e instanceof Error && e.message ? e.message : "Zenith could not save the autonomy level. Nothing was changed.");
    } finally {
      inflight.current = false;
      setSaving(false);
    }
  };

  const shownError = actionError ?? localError;
  const saveHintId = `${ids}-save-hint`;

  return (
    <Card
      title="Autonomy"
      subtitle={
        environmentName
          ? `How much Zenith and connected agents may do on their own in ${environmentName}.`
          : "How much Zenith and connected agents may do on their own in this environment."
      }
      actions={
        <Chip tone="neutral" title={from.summary}>
          <span className="tnum">Level {level}</span> · {from.name}
        </Chip>
      }
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="the autonomy level" rows={4}>
        <div className="space-y-4">
          {locked && (
            <p id={reasonId} className="text-[13px] text-ink-mute">
              {locked}
            </p>
          )}

          <fieldset className="space-y-2" aria-describedby={locked ? reasonId : undefined} disabled={Boolean(locked) || saving}>
            <legend className="mb-1 text-[13px] font-medium text-ink-mute">Autonomy level</legend>
            {AUTONOMY_LEVELS.map((l) => {
              const current = l.level === level;
              const chosen = l.level === selected;
              const id = `${ids}-level-${l.level}`;
              return (
                <label
                  key={l.level}
                  htmlFor={id}
                  className={cx(
                    "flex items-start gap-3 rounded-card border px-4 py-3",
                    chosen ? "border-signal bg-signal-dim" : "border-line bg-bg2",
                    locked ? "cursor-not-allowed" : "cursor-pointer hover:border-line-strong"
                  )}
                >
                  <input
                    id={id}
                    type="radio"
                    name={`${ids}-autonomy`}
                    value={l.level}
                    checked={chosen}
                    disabled={Boolean(locked) || saving}
                    onChange={() => {
                      if (!locked && !saving) setDraft(l.level);
                    }}
                    aria-describedby={locked ? reasonId : undefined}
                    className="mt-1 h-3.5 w-3.5 shrink-0 accent-signal"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                      <span className="tnum text-ink-faint">{l.level}</span>
                      {l.name}
                      {current && <Chip>Current</Chip>}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-ink-mute">{l.summary}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <p className="text-[12.5px] text-ink-mute">{AUTONOMY_POLICY_NOTE}</p>

          {staged !== null && (
            <Callout tone={raising && production ? "warn" : "info"} title={`Change from level ${level} to level ${staged}`} compact>
              <p>
                From <strong className="font-medium">{from.name}</strong> to <strong className="font-medium">{to.name}</strong>. {to.summary}
              </p>
              {raising && production && (
                <p className="mt-1">
                  This is a production environment. Raising autonomy lets Zenith make these changes in production without waiting for a person.
                </p>
              )}
            </Callout>
          )}

          {shownError && (
            <Callout tone="err" compact>
              {shownError}
            </Callout>
          )}

          {!locked && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                busy={saving}
                disabled={staged === null}
                disabledReason="Choose a different level first; there is nothing to save."
                aria-describedby={staged === null ? saveHintId : undefined}
                onClick={() => void save()}
              >
                Save autonomy level
              </Button>
              {staged === null && (
                <span id={saveHintId} className="text-[12.5px] text-ink-mute">
                  Choose a different level to save a change.
                </span>
              )}
              {staged !== null && (
                <Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
                  Discard change
                </Button>
              )}
            </div>
          )}
        </div>
      </SurfaceGate>
    </Card>
  );
}
