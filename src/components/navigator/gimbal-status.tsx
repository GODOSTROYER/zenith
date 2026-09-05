import { Check, CircleStop, Compass, Orbit, Pause, Route } from "lucide-react";
import { GIMBAL_STATE, type GimbalState } from "./gimbal-contract";

const ICONS = { planning: Route, awaiting_approval: Pause, applying: Orbit, verified: Check, blocked: CircleStop };

export function GimbalStatus({ state, label }: { state: GimbalState | null; label?: string }) {
  const Icon = state ? ICONS[state] : Compass;
  return (
    <span className="gimbal-status" data-gimbal-state={state ?? "neutral"}>
      <span className="gimbal-state-dot" />
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{label ?? (state ? GIMBAL_STATE[state].label : "Ready")}</span>
    </span>
  );
}
