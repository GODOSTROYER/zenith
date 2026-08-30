"use client";
import { useState, useTransition } from "react";
import { Chip, SegmentedControl } from "@/components/ui";
import type { AutonomyLevel } from "@/lib/domain/types";
import { setAutonomyAction } from "@/lib/navigator/server-actions";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING } from "@/lib/navigator/shared";

export interface AutonomyDialProps {
  level: AutonomyLevel;
  /** called after the action lands, so the page can refetch */
  onChanged: (level: AutonomyLevel) => void;
}

const NOTCH: Record<AutonomyLevel, number> = {
  observe: 1,
  plan: 2,
  approve: 3,
  bounded: 4,
  autonomous: 5,
};

/**
 * The autonomy dial. Five notches, and the copy under it is the rule the
 * executor actually enforces — not a softer version of it.
 */
export function AutonomyDial({ level, onChanged }: AutonomyDialProps) {
  const [optimistic, setOptimistic] = useState<AutonomyLevel | null>(null);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const shown = optimistic ?? level;

  const change = (next: AutonomyLevel) => {
    if (next === shown) return;
    setOptimistic(next);
    setError(undefined);
    start(async () => {
      const res = await setAutonomyAction(next);
      if (res.error) {
        setOptimistic(null);
        setError(`${res.error}${res.fix ? ` ${res.fix}` : ""}`);
        return;
      }
      setOptimistic(null);
      onChanged(next);
    });
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[11.5px] font-medium tracking-[0.02em] text-ink-faint uppercase">
          Autonomy
        </span>
        <SegmentedControl<AutonomyLevel>
          size="sm"
          label="Navigator autonomy level"
          value={shown}
          onChange={change}
          options={AUTONOMY_LEVELS.map((l) => ({
            value: l,
            label: l,
            title: `Level ${NOTCH[l]} — ${AUTONOMY_MEANING[l]}`,
          }))}
        />
        <Chip tone="nav" title={`Level ${NOTCH[shown]} of 5`}>
          <span className="tnum">L{NOTCH[shown]}</span>
          {shown}
        </Chip>
        {pending && <span className="text-[12px] text-ink-faint">saving…</span>}
      </div>
      <p className="mt-1.5 max-w-[62ch] text-[12.5px] text-ink-mute">
        {AUTONOMY_MEANING[shown]} Every step is audited whatever the level, and deployments
        still obey each environment&rsquo;s approval policy.
      </p>
      {error && <p className="mt-1 text-[12.5px] text-err">{error}</p>}
    </div>
  );
}
