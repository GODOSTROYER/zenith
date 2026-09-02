"use client";
import { useState, useTransition } from "react";
import { Chip, SegmentedControl } from "@/components/ui";
import type { AutonomyLevel } from "@/lib/domain/types";
import { setAutonomyAction } from "@/lib/navigator/server-actions";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING, type WorkspaceRole } from "@/lib/navigator/shared";

export interface AutonomyDialProps {
  level: AutonomyLevel;
  /** called after the action lands, so the page can refetch */
  onChanged: (level: AutonomyLevel) => void;
  /** whose setting this is — it is workspace-wide, not per-project */
  workspaceName?: string;
  /** the caller's role; `workspace.setAutonomy` is admin-only. null = demo mode */
  role?: WorkspaceRole | null;
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
export function AutonomyDial({ level, onChanged, workspaceName, role }: AutonomyDialProps) {
  const [optimistic, setOptimistic] = useState<AutonomyLevel | null>(null);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const shown = optimistic ?? level;

  // workspace.setAutonomy is admin-only. Without this the dial snaps to the
  // new notch, the server refuses, and it snaps back with an error — a dead
  // control that looked live for a second. (null = no auth configured, where
  // the local actor is admin.)
  const denied =
    role && role !== "admin"
      ? `Only a workspace admin can move the autonomy dial, and you are ${role} in ${
          workspaceName ?? "this workspace"
        }. Ask an admin to change it — every level's behaviour is described below.`
      : undefined;

  // The dial lives in a project view but writes a workspace setting. Say so at
  // the control, not only in the docs.
  const scopeNote = `This dial is a workspace setting${
    workspaceName ? ` on ${workspaceName}` : ""
  } — changing it changes the Navigator's autonomy in every project, not just this one.`;

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
        <Chip title={scopeNote}>{workspaceName ? `all of ${workspaceName}` : "whole workspace"}</Chip>
        <SegmentedControl<AutonomyLevel>
          size="sm"
          label="Navigator autonomy level"
          value={shown}
          onChange={change}
          options={AUTONOMY_LEVELS.map((l) => ({
            value: l,
            label: l,
            title: `Level ${NOTCH[l]} — ${AUTONOMY_MEANING[l]}`,
            disabled: Boolean(denied) && l !== shown,
            disabledReason: denied,
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
      <p className="mt-1 max-w-[62ch] text-[12px] text-ink-faint">{scopeNote}</p>
      {denied && <p className="mt-1 max-w-[62ch] text-[12px] text-ink-faint">{denied}</p>}
      {error && <p className="mt-1 text-[12.5px] text-err">{error}</p>}
    </div>
  );
}
