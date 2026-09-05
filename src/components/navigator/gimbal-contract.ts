/** The five application-owned workflow states. Absence of a run is null. */
export const GIMBAL_STATES = [
  "planning",
  "awaiting_approval",
  "applying",
  "verified",
  "blocked",
] as const;

export type GimbalState = (typeof GIMBAL_STATES)[number];
export type GimbalIcon = "route" | "pause" | "orbit" | "check" | "stop";
export type GimbalTone = "nav" | "warm" | "ok" | "err" | "neutral";

export interface GimbalStateInfo {
  label: string;
  description: string;
  color: string;
  icon: GimbalIcon;
  tone: GimbalTone;
}

/** Label, icon, accent, pose and motion consume the same state atomically. */
export const GIMBAL_STATE: Record<GimbalState, GimbalStateInfo> = {
  planning: {
    label: "Planning",
    description: "Reviewing the system and preparing a typed plan. Nothing is being deployed.",
    color: "#b89cff",
    icon: "route",
    tone: "nav",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    description: "The plan is ready for review. Execution waits for your approval.",
    color: "#e6bc69",
    icon: "pause",
    tone: "warm",
  },
  applying: {
    label: "Applying",
    description: "Approved typed actions are running. The result is not yet verified.",
    color: "#79baff",
    icon: "orbit",
    tone: "nav",
  },
  verified: {
    label: "Verified",
    description: "The completed result was checked against authoritative provider evidence.",
    color: "#86d6aa",
    icon: "check",
    tone: "ok",
  },
  blocked: {
    label: "Blocked",
    description: "A dependency, failed step or missing detail needs attention before the plan can proceed.",
    color: "#ee8b8b",
    icon: "stop",
    tone: "err",
  },
};
